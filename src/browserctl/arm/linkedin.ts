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
import { noteQuotaUntil } from '../../linkedin/noteQuota.js';
import { loadOutreachConfig } from '../../outreach/config.js';
import { ceilings, haltReason } from '../../outreach/limits.js';
import { companyPaused } from '../../outreach/people.js';
import { bindDraftTouch, getReplyDraft, type DraftView } from '../../outreach/replyDrafts.js';
import { ATTACH_KIND, ATTACH_KINDS, dmAttachAllowed, resolveJobResume, type ResolveDeps, type ResolvedAttachment } from '../../linkedin/attachment.js';
import { recordDryRun } from '../../safety/dryRun.js';
import { gateOutbound } from '../../safety/outputGate.js';
import type { StyleConfig } from '../../safety/styleGate.js';
import type { Engine } from '../act.js';
import { armEasyApply } from './linkedinEasyApply.js';
import { profileHeadingName } from '../commit.js';
import { killReason, type EngineDeps } from '../engineTypes.js';
import { normName, type CommitClass } from '../guard.js';
import type { IntentStore } from '../intent.js';
import { bindTouchRelease } from '../intent.js';
import { renderTree, type RawTree } from '../snapshot.js';
import { connectionStateOf, hasRegions } from '../topCard.js';

/** connect_plain is a note-less invite ("Send without a note"): no text, used while the monthly note quota is used up. */
export type ArmKind = 'connect_note' | 'connect_plain' | 'role_ask' | 'rapport' | 'referral_ask' | 'followup' | 'feedback' | 'accept' | 'reply' | 'easy_apply';
export const ARM_KINDS: readonly ArmKind[] = ['connect_note', 'connect_plain', 'role_ask', 'rapport', 'referral_ask', 'followup', 'feedback', 'accept', 'reply', 'easy_apply'];

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
  /** Attachment resolution seams (tests): repo root, resume re-render, and the resume.json name. */
  attach?: ResolveDeps;
}

export interface ArmArgs {
  kind: ArmKind; profile_url?: string; text?: string; job_id?: string; company?: string;
  /** `job_resume`: attach the tailored resume of the person's latest job. Replies (with attach_resume) always; role_ask, rapport and followup only when LINKEDIN_DM_ATTACH_RESUME is true. */
  attachment?: typeof ATTACH_KIND;
  /** Kind `reply` only: the owner-approved reply_drafts row. The text is read from it by code. */
  reply_draft_id?: number;
}

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
  /** Kind `reply`: the exact owner-approved text to type (it comes from the stored draft, not from the model). */
  text?: string;
  /** An armed attachment: the generic upload name and size. The next step is linkedin_attach_file inside the person's open message window. */
  attachment?: { name: string; bytes: number };
}

export const INVITATIONS_URL = 'https://www.linkedin.com/mynetwork/invitation-manager/';

/** Connection status from a profile tree, through the one shared rule (connectionState). */
export function statusFromTree(tree: RawTree): { state: 'connected' | 'pending' | 'not_connected'; code: string } {
  // On a profile page only the top card and its More menu count: a sidebar card's Connect, Pending or degree is another person's.
  const regional = hasRegions(tree);
  const outside = tree.nodes.filter((x) => x.dialog === undefined && (!regional || x.region === 'topcard' || x.region === 'menu'));
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
  connect_note: 'connect', connect_plain: 'connect', role_ask: 'role_ask', rapport: 'rapport', referral_ask: 'referral_ask',
  followup: 'followup', feedback: 'feedback', accept: null, reply: 'reply', easy_apply: null,
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
  // Kind easy_apply names a JOB (its page URL comes from SQLite), not a person: its own arm path.
  if (a.kind === 'easy_apply') return armEasyApply(deps, { job_id: a.job_id });
  if (typeof a.profile_url !== 'string' || !isProfileUrl(a.profile_url)) return fail('refused', 'bad_url', 'not a LinkedIn profile URL');

  const isAccept = a.kind === 'accept';
  const isConnect = a.kind === 'connect_note' || a.kind === 'connect_plain';
  const isReply = a.kind === 'reply';
  const cls: CommitClass = isAccept ? 'commit_accept_invite' : isConnect ? 'commit_connect_send' : 'commit_message_send';

  // Kind `reply` sends ONLY an owner-approved reply_drafts row: the text comes from the stored draft (code), never from the model.
  let draft: DraftView | null = null;
  if (isReply) {
    if (!Number.isInteger(a.reply_draft_id)) return fail('refused', 'reply_draft_required', 'a reply needs the id of an approved reply draft');
    draft = getReplyDraft(db, a.reply_draft_id as number);
    if (!draft) return fail('refused', 'reply_draft_unknown', 'no such reply draft');
    if (draft.status !== 'approved') return fail('refused', 'reply_not_approved', `the reply draft is ${draft.status}; only an owner-approved draft is sent`);
    if (!draft.escalation_open) return fail('refused', 'reply_escalation_closed', 'the escalation of this reply is already handled');
    if (a.text !== undefined && a.text.trim() !== draft.body.trim()) return fail('refused', 'reply_text_mismatch', 'the text differs from the approved draft; omit text and use the draft');
  } else if (a.reply_draft_id !== undefined) {
    return fail('refused', 'reply_draft_not_allowed', 'reply_draft_id is only for kind reply');
  }
  // Attachment: only the tailored resume, resolved by code below. Replies carry it when the draft says so; first DMs only when the owner allows it.
  let wantAttach = isReply && draft?.attach_resume === 1;
  if (a.attachment !== undefined) {
    if (a.attachment !== ATTACH_KIND) return fail('refused', 'bad_attachment', 'the only attachment is job_resume');
    if (!ATTACH_KINDS.includes(a.kind)) return fail('refused', 'attachment_not_allowed', 'this kind never carries a file');
    if (isReply) {
      if (draft?.attach_resume !== 1) return fail('refused', 'attachment_not_approved', 'this reply draft was not approved with the resume attached');
    } else if (!dmAttachAllowed(deps.env)) {
      return fail('refused', 'attachment_disabled', 'LINKEDIN_DM_ATTACH_RESUME is not true; first messages carry no file');
    }
    wantAttach = true;
  }
  const argText = isReply ? (draft as DraftView).body : a.text;
  let person: PersonRow;
  let text: string | null = null;
  let dry = deps.cfg.dryRun;
  let factVerdict: 'pass' | 'warn' | 'block' = 'pass';
  let attachment: ResolvedAttachment | undefined;

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
    const plain = a.kind === 'connect_plain';
    if (plain && a.text !== undefined) return fail('refused', 'text_not_allowed', 'a note-less invite carries no text');
    if (!plain && typeof argText !== 'string') return fail('refused', 'empty_text', 'text is required');
    if (a.kind === 'connect_note' && noteQuotaUntil(db, now()) !== null) {
      return fail('refused', 'note_quota_exhausted', 'the monthly quota of invite notes is used up; arm connect_plain (no note) for this person');
    }
    const g = preSendGuard({
      db, now: now(), env: deps.env, action: isConnect ? 'invite' : 'message', kind: KIND_TO_GUARD[a.kind] as Kind,
      profileUrl: a.profile_url, text: argText ?? '', plain, jobId: a.job_id ?? null, company: a.company,
      factCheck: deps.factCheck, styleCfg: deps.styleCfg, cfg: deps.cfg,
    });
    if (!g.ok) return fail(g.status, g.code, g.reason);
    person = g.person; text = plain ? null : g.text; dry = g.dryRun; touchId = g.touchId; factVerdict = g.factVerdict;
    liveTouch = !g.dryRun;
    if (isReply && draft && g.person.id !== draft.person_id) return fail('refused', 'reply_recipient_mismatch', 'the profile is not the person this reply draft answers');
    if (wantAttach) {
      const r = await resolveJobResume(db, g.person.id, deps.attach);
      if (!r.ok) return fail('refused', r.code, r.reason);
      attachment = r.attachment;
    }
    if (isReply && draft && !g.dryRun) bindDraftTouch(db, draft.id, g.touchId);
  }

  // Ceiling read: a spent ceiling refuses at arm (the commit path consumes it right before the click).
  if (!isAccept) {
    const key = isConnect ? 'linkedin_invite' : 'linkedin_message';
    const c = ceilings(db, loadOutreachConfig(deps.env), now())[key];
    if (!c.ok) return fail('rate_limited', 'rate_limited', `${c.used} of ${c.limit} today`);
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
    if (isConnect && st.state !== 'not_connected') return fail('refused', st.state === 'pending' ? 'already_pending' : 'already_connected', `status is ${st.state}`);
    if (isConnect) {
      // The owner's rule: Connect in the top card, else Connect or Personalize invite in its More menu, else not connectable.
      const cs = connectionStateOf(tree);
      if (cs?.state === 'already_pending') return fail('refused', 'already_pending', cs.reason);
      if (cs?.state === 'not_connectable') return fail('refused', 'not_connectable', cs.reason);
      if (cs?.state === 'check_more') return fail('refused', 'more_not_checked', cs.reason);
    }
    if (!isConnect && st.state !== 'connected') return fail('refused', 'not_connected', `status is ${st.state}; messages need a 1st-degree connection`);
  }

  // Third-party page text: screen for sending, fail closed.
  const v = await deps.screen(pageText, 'send');
  if (v.blocked) {
    if (v.code === 'classifier_unavailable') return fail('failed', 'classifier_unavailable');
    pauseContact(db, person.id, 'injection_suspected', now());
    return fail('refused', 'injection_suspected', 'page text flagged by the input screen');
  }

  if (text !== null) {
    // Our own earlier messages and notes: the Messaging dock on the page previews them back, which is not a page copy.
    // The text being armed is excluded: its touch row is already reserved with this body, so it would excuse itself.
    const ownTexts = [
      ...(db.prepare("SELECT body FROM touches WHERE body IS NOT NULL AND body <> '' ORDER BY id DESC LIMIT 200").all() as { body: string }[]).map((r) => r.body),
      ...(db.prepare("SELECT note FROM connections WHERE note IS NOT NULL AND note <> '' ORDER BY id DESC LIMIT 200").all() as { note: string }[]).map((r) => r.note),
    ].filter((t) => t !== text);
    const og = gateOutbound(text, outputGateContext({
      person, actualProfileUrl: page.url(), rawPageText: pageText, cfg: deps.cfg, env: deps.env, factVerdict, ownTexts,
    }));
    if (!og.ok) return fail('refused', 'output_gate_page', `output gate: ${og.reasons.join(', ')}`);
  }

  const intent = deps.intents.arm({
    platform: 'linkedin', kind: a.kind, class: cls, profileKey: person.profile_key, text, personId: person.id,
    ...(touchId !== undefined ? { touchId } : {}),
    ...(a.job_id !== undefined ? { jobId: a.job_id } : {}),
    ...(a.company !== undefined ? { company: a.company } : {}),
    ...(attachment ? { attachment: { path: attachment.path, name: attachment.name, bytes: attachment.bytes, attached: false } } : {}),
    ...(isReply && draft ? { replyDraftId: draft.id } : {}),
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
    ...(isReply && text !== null ? { text } : {}),
    ...(attachment ? { attachment: { name: attachment.name, bytes: attachment.bytes } } : {}),
  };
}
