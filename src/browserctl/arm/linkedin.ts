// browserctl arm tool for LinkedIn: runs every code gate that used to live inside the typed send tools
// (preSendGuard, connection status, ceiling read, profile URL and page name, screen, output gate) and
// then arms ONE intent. The commit path (commit.ts) refuses any send without it. Arming also runs in a
// dry run: it records and creates a dry intent, whose commit records instead of clicking.
import type BetterSqlite3 from 'better-sqlite3';
import { connectionState } from '../../linkedin/connectionState.js';
import type { LinkedinConfig } from '../../linkedin/config.js';
import { outputGateContext, preSendGuard, type FactCheck, type Kind } from '../../linkedin/guard.js';
import { finishTouch, pauseContact, personByProfileKey, type PersonRow } from '../../linkedin/touches.js';
import { isProfileUrl, profileKeyOf } from '../../linkedin/urls.js';
import { extractExpectedNameFromTitle, extractProfileSlug, namesPlausiblyMatch, verifyProfileUrl } from '../../linkedin/verify.js';
import { loadOutreachConfig } from '../../outreach/config.js';
import { ceilings, haltReason } from '../../outreach/limits.js';
import { companyPaused } from '../../outreach/people.js';
import { recordDryRun } from '../../safety/dryRun.js';
import { gateOutbound } from '../../safety/outputGate.js';
import type { StyleConfig } from '../../safety/styleGate.js';
import type { Engine } from '../act.js';
import { profileHeadingName } from '../commit.js';
import { killReason, type EngineDeps } from '../engineTypes.js';
import { normName, type CommitClass } from '../guard.js';
import type { IntentStore } from '../intent.js';
import { bindTouchRelease } from '../intent.js';
import { renderTree, type RawTree } from '../snapshot.js';

export type ArmKind = 'connect_note' | 'role_ask' | 'rapport' | 'referral_ask' | 'followup' | 'feedback' | 'accept';
export const ARM_KINDS: readonly ArmKind[] = ['connect_note', 'role_ask', 'rapport', 'referral_ask', 'followup', 'feedback', 'accept'];

export interface ArmDeps {
  engine: Engine;
  intents: IntentStore;
  db: BetterSqlite3.Database;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  cfg: LinkedinConfig;
  factCheck: FactCheck;
  styleCfg: StyleConfig;
  screen: EngineDeps['screen'];
  stopFile?: string;
}

export interface ArmArgs { kind: ArmKind; profile_url: string; text?: string; job_id?: string; company?: string }

export interface ArmResult {
  status: 'armed' | 'refused' | 'halted' | 'rate_limited' | 'failed';
  code: string;
  reason?: string;
  intent_id?: string;
  expires_at?: string;
  class?: CommitClass;
  dry_run?: boolean;
  touch_id?: number;
  would?: { kind: string; chars: number; recipient: string };
}

export const INVITATIONS_URL = 'https://www.linkedin.com/mynetwork/invitation-manager/';

/** Connection status from a profile tree, through the one shared rule (connectionState). */
export function statusFromTree(tree: RawTree): { state: 'connected' | 'pending' | 'not_connected'; code: string } {
  const outside = tree.nodes.filter((x) => x.dialog === undefined);
  const actions: string[] = [];
  let pending = false;
  let hasBell = false;
  let degree: string | null = null;
  for (const x of outside) {
    if (x.role === 'button' || x.role === 'link' || x.role === 'menuitem') {
      const nm = normName(x.name);
      if (nm === 'connect' || /^invite .+ to connect$/.test(nm)) actions.push('Connect');
      if (/^pending\b|^withdraw\b/.test(nm)) pending = true;
      if (/^manage notifications/.test(nm)) hasBell = true;
    } else if (x.role === 'text' && degree === null) {
      const m = /^[\s·.]*(1st|2nd|3rd)\b/i.exec(x.text);
      if (m) degree = m[1].toLowerCase();
    }
  }
  return connectionState({ hasBell, pending, degree, actions });
}

const KIND_TO_GUARD: Record<ArmKind, Kind | null> = {
  connect_note: 'connect', role_ask: 'role_ask', rapport: 'rapport', referral_ask: 'referral_ask',
  followup: 'followup', feedback: 'feedback', accept: null,
};

export async function armLinkedinSend(deps: ArmDeps, a: ArmArgs): Promise<ArmResult> {
  const { db } = deps;
  bindTouchRelease(deps.intents, db);
  deps.intents.sweep();
  const now = () => deps.now();
  let touchId: number | undefined;
  let liveTouch = false;
  const fail = (status: ArmResult['status'], code: string, reason?: string): ArmResult => {
    if (liveTouch && touchId !== undefined) finishTouch(db, touchId, 'failed', now());
    return { status, code, ...(reason ? { reason } : {}) };
  };

  if (!ARM_KINDS.includes(a.kind)) return fail('refused', 'bad_kind', 'unknown kind');
  const k = killReason(deps);
  if (k) return fail('halted', k.startsWith('kill switch') ? 'killed' : 'halted', k);
  if (typeof a.profile_url !== 'string' || !isProfileUrl(a.profile_url)) return fail('refused', 'bad_url', 'not a LinkedIn profile URL');

  const isAccept = a.kind === 'accept';
  const cls: CommitClass = isAccept ? 'commit_accept_invite' : a.kind === 'connect_note' ? 'commit_connect_send' : 'commit_message_send';
  let person: PersonRow;
  let text: string | null = null;
  let dry = deps.cfg.dryRun;
  let factVerdict: 'pass' | 'warn' | 'block' = 'pass';

  if (isAccept) {
    const h = haltReason(db, 'linkedin');
    if (h !== null) return fail('halted', 'halted', `linkedin halted: ${h}`);
    const p = personByProfileKey(db, profileKeyOf(a.profile_url));
    if (!p) return fail('refused', 'unknown_recipient', 'recipient is not in people');
    if (!p.name || !p.name.trim()) return fail('refused', 'recipient_name_unknown', 'recipient name is unknown');
    if (p.paused_reason !== null || ['replied_negative', 'closed', 'cooldown'].includes(p.stage) || companyPaused(db, 'linkedin', p.company_key)) {
      return fail('refused', 'contact_paused', 'contact or company is paused');
    }
    person = p;
  } else {
    if (typeof a.text !== 'string') return fail('refused', 'empty_text', 'text is required');
    const g = preSendGuard({
      db, now: now(), env: deps.env, action: a.kind === 'connect_note' ? 'invite' : 'message', kind: KIND_TO_GUARD[a.kind] as Kind,
      profileUrl: a.profile_url, text: a.text, jobId: a.job_id ?? null, company: a.company,
      factCheck: deps.factCheck, styleCfg: deps.styleCfg, cfg: deps.cfg,
    });
    if (!g.ok) return fail(g.status, g.code, g.reason);
    person = g.person; text = g.text; dry = g.dryRun; touchId = g.touchId; factVerdict = g.factVerdict;
    liveTouch = !g.dryRun;
  }

  // Ceiling read: a spent ceiling refuses at arm (the commit path consumes it right before the click).
  if (!isAccept) {
    const key = a.kind === 'connect_note' ? 'linkedin_invite' : 'linkedin_message';
    const c = ceilings(db, loadOutreachConfig(deps.env), now())[key];
    if (!c.ok) return fail('rate_limited', 'rate_limited', `${c.used} of ${c.limit} this week`);
  }

  // Page verification from the page snapshot.
  // Already on the requested profile (the operator opened and snapshotted it): only re-read it. Arming must
  // never start a new epoch or navigate, so the operator's refs stay usable for the click that follows.
  const cur = await deps.engine.page();
  const onProfile = !isAccept && !!cur && profileKeyOf(cur.url()) === profileKeyOf(a.profile_url) && deps.engine.refs.hasSnapshot;
  const opened = onProfile
    ? await deps.engine.peek()
    : await deps.engine.open(isAccept ? INVITATIONS_URL : a.profile_url, { keepRefs: true });
  if (!opened.ok) {
    const halted = opened.code === 'halted' || opened.code === 'killed';
    return fail(halted ? 'halted' : 'failed', opened.code, opened.reason);
  }
  const tree = deps.engine.lastTree();
  const page = await deps.engine.page();
  if (!tree || !page) return fail('failed', 'no_snapshot', 'could not read the page');
  // Our own composer text is not page text: strip field values before the copy check and the screen.
  const pageText = renderTree(
    { ...tree, nodes: tree.nodes.map((x) => (x.composer && x.role === 'textbox' ? { ...x, value: undefined } : x)) },
    deps.engine.refs.epoch,
  );

  if (isAccept) {
    const slug = extractProfileSlug(a.profile_url);
    const accepts = tree.nodes.filter((x) => x.role === 'button' && /^accept\b/.test(normName(x.name)));
    const link = tree.nodes.find((x) => x.role === 'link' && extractProfileSlug(x.href ?? '') === slug && slug !== '');
    const acc = link ? accepts.find((x) => x.n > link.n) : undefined;
    const rowOk = !!link && !!acc && !accepts.some((x) => x.n > link.n && x.n < acc.n);
    if (!rowOk) return fail('refused', 'unknown_recipient', 'sender is not in the invitations list');
    if (link.name && !namesPlausiblyMatch(person.name ?? '', link.name)) return fail('refused', 'recipient_mismatch', 'invitation row names a different person');
  } else {
    if (!verifyProfileUrl(a.profile_url, page.url()).ok) return fail('refused', 'profile_url_mismatch', 'browser is not on the requested profile');
    const shown = profileHeadingName(tree) || extractExpectedNameFromTitle(tree.title);
    if (!shown) return fail('refused', 'recipient_name_unverified', 'could not read the profile name');
    if (!namesPlausiblyMatch(person.name ?? '', shown)) return fail('refused', 'recipient_mismatch', 'page shows a different person');
    const st = statusFromTree(tree);
    if (a.kind === 'connect_note' && st.state !== 'not_connected') return fail('refused', st.state === 'pending' ? 'already_pending' : 'already_connected', `status is ${st.state}`);
    if (a.kind !== 'connect_note' && st.state !== 'connected') return fail('refused', 'not_connected', `status is ${st.state}; messages need a 1st-degree connection`);
  }

  // Third-party page text: screen for sending, fail closed.
  const v = await deps.screen(pageText, 'send');
  if (v.blocked) {
    if (v.code === 'classifier_unavailable') return fail('failed', 'classifier_unavailable');
    pauseContact(db, person.id, 'injection_suspected', now());
    return fail('refused', 'injection_suspected', 'page text flagged by the input screen');
  }

  if (text !== null) {
    const og = gateOutbound(text, outputGateContext({
      person, actualProfileUrl: page.url(), rawPageText: pageText, cfg: deps.cfg, env: deps.env, factVerdict,
    }));
    if (!og.ok) return fail('refused', 'output_gate_page', `output gate: ${og.reasons.join(', ')}`);
  }

  const intent = deps.intents.arm({
    platform: 'linkedin', kind: a.kind, class: cls, profileKey: person.profile_key, text, personId: person.id,
    ...(touchId !== undefined ? { touchId } : {}),
    ...(a.job_id !== undefined ? { jobId: a.job_id } : {}),
    ...(a.company !== undefined ? { company: a.company } : {}),
    dry,
  });
  if (dry) {
    try {
      recordDryRun(db, {
        runId: null, action: 'linkedin_arm_send', platform: 'linkedin', personId: person.id,
        payload: { kind: a.kind, class: cls, chars: text?.length ?? 0, recipient: person.name },
      }, now(), deps.env);
    } catch { /* the dry intent is still armed */ }
  }
  return {
    status: 'armed', code: 'armed', intent_id: intent.id, expires_at: new Date(intent.expiresAt).toISOString(),
    class: cls, dry_run: dry, ...(touchId !== undefined ? { touch_id: touchId } : {}),
    would: { kind: a.kind, chars: text?.length ?? 0, recipient: person.name ?? '' },
  };
}
