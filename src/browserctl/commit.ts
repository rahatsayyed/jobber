// browserctl commit path: the only code that lets a commit-class click (connect, message send, accept)
// reach the page. Reached from the engine's click, press_key and click_at when the guard classified the
// live element as commit_connect_send, commit_message_send or commit_accept_invite.
// Order: kill switch and halt -> armed intent -> fresh page read (profile key from the URL, recipient
// name in the dialog or row, live composer text) -> element unchanged -> halt again -> dry run (record,
// close dialog, disarm) or live (consume the intent, tryConsume the ceiling, arm the response watcher,
// click, confirm by response AND dialog gone) -> finishTouch, saveConnection, disarm.
// Anything after the click that cannot be confirmed is 'unconfirmed', never guessed.
import { saveConnection } from '../db.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
import { extractDialogRecipientName, extractProfileSlug, namesPlausiblyMatch, verifyProfileUrl } from '../linkedin/verify.js';
import { classifyUrl, profileKeyOf } from '../linkedin/urls.js';
import { finishTouch } from '../linkedin/touches.js';
import { loadOutreachConfig } from '../outreach/config.js';
import { tryConsume } from '../outreach/limits.js';
import { recordDryRun } from '../safety/dryRun.js';
import type { BcPage } from './driver.js';
import { killReason, type EngineDeps, type EngineResult } from './engineTypes.js';
import { dialogKindOf, normName, type CommitClass } from './guard.js';
import type { ArmedIntent } from './intent.js';
import { bindTouchRelease } from './intent.js';
import type { LiveNode, RawTree } from './snapshot.js';

export interface CommitInput {
  deps: EngineDeps;
  page: BcPage;
  cls: CommitClass;
  /** The target as re-read live by the engine just before this call. */
  live: LiveNode;
  /** Performs the click or key press (the only thing that touches the page). */
  act: () => Promise<void>;
  /** Re-reads the same target live (describe(n) or describeAt(x,y)). */
  redescribe: () => Promise<LiveNode | null>;
}

const GENERIC_HEADS = /^(messaging|messages|new message|conversation|chat|compose|compose message|write a message)$/i;

const sameTarget = (a: LiveNode, b: LiveNode): boolean =>
  a.role === b.role && a.name === b.name && a.dialogName === b.dialogName && (a.dialog === undefined) === (b.dialog === undefined);

/** Text of one dialog from a tree: its own name, headings and text nodes. */
export function dialogText(tree: RawTree, dlg: number): string {
  const d = tree.nodes.find((x) => x.n === dlg && x.role === 'dialog');
  const parts = [d?.name ?? ''];
  for (const x of tree.nodes) {
    if (x.dialog !== dlg) continue;
    if (x.role === 'text') parts.push(x.text);
    else if (x.role === 'heading') parts.push(x.name);
  }
  return parts.filter(Boolean).join('\n');
}

const INVITE_CONTROL_RE = /^(?:add a note|send without a note|send (?:an? )?invit\w*)$/;

/** Does this dialog hold the invite controls ("Add a note", "Send without a note", "Send invitation")? */
export function looksLikeInvite(tree: RawTree, dlg: number): boolean {
  const d = tree.nodes.find((x) => x.n === dlg && x.role === 'dialog');
  if (d && dialogKindOf(d.name) === 'message') return false;
  const ctl = tree.nodes.filter((x) => x.dialog === dlg && (x.role === 'button' || x.role === 'link')).map((x) => normName(x.name));
  if (ctl.some((c) => INVITE_CONTROL_RE.test(c))) return true;
  return ctl.includes('send') && /\binvit/i.test(dialogText(tree, dlg));
}

/** Kind of a dialog: by its name, or (when the name says nothing) by the invite controls inside it. */
export function effectiveDialogKind(tree: RawTree, dlg: number, name: string | null | undefined): 'invite' | 'message' | 'other' {
  const byName = dialogKindOf(name) ?? 'other';
  if (byName !== 'other') return byName;
  return looksLikeInvite(tree, dlg) ? 'invite' : 'other';
}

/** The page after a Connect click: an invite dialog (any name), or a navigated invite page with its controls. */
function inviteSurface(tree: RawTree, before: string): 'dialog' | 'page' | null {
  if (tree.nodes.some((x) => x.role === 'dialog' && effectiveDialogKind(tree, x.n, x.name) === 'invite')) return 'dialog';
  const moved = tree.url !== before;
  const ctl = tree.nodes.filter((x) => x.dialog === undefined && (x.role === 'button' || x.role === 'link')).map((x) => normName(x.name));
  const hasCtl = ctl.some((c) => INVITE_CONTROL_RE.test(c));
  return moved && hasCtl ? 'page' : null;
}

/** Recipient name shown in an invite dialog ("invitation to X" or an "Invite X to connect" heading), '' when none. */
export function inviteDialogName(tree: RawTree, dlg: number): string {
  const text = dialogText(tree, dlg);
  const a = extractDialogRecipientName(text);
  if (a) return a;
  for (const line of text.split('\n')) {
    const m = /^\s*invite\s+(.+?)\s+to connect\s*$/i.exec(line);
    if (m) return m[1].trim();
  }
  return '';
}

/** Recipient name in a message overlay: its first non-generic heading (or the dialog name), '' when none. */
export function messageDialogName(tree: RawTree, dlg: number): string {
  const d = tree.nodes.find((x) => x.n === dlg && x.role === 'dialog');
  const cands = [...tree.nodes.filter((x) => x.dialog === dlg && x.role === 'heading').map((x) => x.name), d?.name ?? ''];
  for (const c of cands) {
    const s = c.replace(/^(?:new message to|message to|messaging with|conversation with|message)\s+/i, '').trim();
    if (s && !GENERIC_HEADS.test(s)) return s;
  }
  return '';
}

/** Name of the person on a profile page: the first heading, '' when none. */
export function profileHeadingName(tree: RawTree): string {
  return tree.nodes.find((x) => x.role === 'heading' && x.dialog === undefined && x.name)?.name ?? '';
}

const acceptCount = (tree: RawTree): number =>
  tree.nodes.filter((x) => x.role === 'button' && /^accept\b/.test(normName(x.name))).length;

export async function commitAction(i: CommitInput): Promise<EngineResult> {
  const { deps, page, cls, live } = i;
  const { db } = deps;
  bindTouchRelease(deps.intents, db);
  deps.intents.sweep();
  const now = () => deps.now();
  const platform = 'linkedin' as const;
  let intent: ArmedIntent | null = deps.intents.peek(platform);
  let clickIssued = false;
  let keepArmed = false;

  const release = (status: 'failed' | 'unconfirmed' | 'refused'): void => {
    if (intent?.touchId !== undefined && !intent.dry) finishTouch(db, intent.touchId, status, now());
  };
  const closeDialog = async (): Promise<void> => {
    if (live.dialog !== undefined) await page.press('Escape').catch(() => undefined);
  };
  const abort = async (code: string, reason: string, o: { status?: EngineResult['status']; close?: boolean; keepTouch?: boolean } = {}): Promise<EngineResult> => {
    if (o.close) await closeDialog();
    if (!o.keepTouch) release('failed');
    deps.intents.disarm(platform);
    return { ok: false, status: o.status ?? 'refused', code, reason };
  };

  // 1. kill switch and halt
  const k0 = killReason(deps);
  if (k0) return abort('halted', k0, { status: 'halted' });

  // 2. armed intent of the right class
  if (!intent) return { ok: false, status: 'refused', code: 'no_armed_intent', reason: 'arm the send with linkedin_arm_send first' };
  const early = deps.intents.check(platform, cls, intent.text);
  if (!early.ok) return abort(early.code, `armed intent refused: ${early.code}`, { close: true });

  // 3. recipient on file, consistent with the intent
  const person = intent.personId === undefined ? undefined
    : (db.prepare('SELECT name, profile_key FROM people WHERE id = ?').get(intent.personId) as { name: string | null; profile_key: string } | undefined);
  if (!person || !person.name || !intent.profileKey || person.profile_key !== intent.profileKey) {
    return abort('unknown_recipient', 'armed recipient is not a known person', { close: true });
  }
  const expectedName = person.name;

  // 4. fresh page read
  let tree: RawTree;
  try { tree = await page.snapshot(); } catch { return abort('no_snapshot', 'could not read the page', { close: true }); }
  const fresh = live.n >= 0 ? tree.nodes.find((x) => x.n === live.n) : undefined;
  if (live.n >= 0 && (!fresh || !sameTarget(fresh, live))) {
    return abort('target_changed', 'page changed under the action; nothing clicked', { close: true });
  }
  const url = page.url();
  const profileUrl = `https://www.${intent.profileKey}/`;
  const isAccept = cls === 'commit_accept_invite';
  if (!isAccept) {
    if (!verifyProfileUrl(profileUrl, url).ok || profileKeyOf(url) !== intent.profileKey) {
      return abort('profile_url_mismatch', 'browser is not on the armed profile', { close: true });
    }
  }

  let liveText: string | undefined;
  let openStep = false;
  let acceptBefore = 0;
  const dlg = live.dialog;

  if (cls === 'commit_connect_send' || cls === 'commit_message_send') {
    const wantKind = cls === 'commit_connect_send' ? 'invite' : 'message';
    if (dlg === undefined) {
      if (cls === 'commit_message_send') return abort('wrong_dialog', 'message send outside a message dialog', { close: true });
      // The profile Connect button (or More menu item): it only opens the invite dialog. Name and page checks apply.
      const m = /^invite (.+) to connect$/.exec(normName(live.name));
      if (m && !namesPlausiblyMatch(expectedName, m[1])) return abort('recipient_mismatch', 'Connect control names a different person');
      const head = profileHeadingName(tree);
      if (!head || !namesPlausiblyMatch(expectedName, head)) return abort('recipient_mismatch', 'page does not show the armed person');
      openStep = true;
    } else {
      if (effectiveDialogKind(tree, dlg, live.dialogName) !== wantKind) return abort('wrong_dialog', 'dialog is not the expected kind', { close: true });
      const shown = wantKind === 'invite' ? inviteDialogName(tree, dlg) : messageDialogName(tree, dlg);
      if (!shown) return abort('dialog_name_unverified', 'could not read the recipient name in the dialog', { close: true });
      if (!namesPlausiblyMatch(expectedName, shown)) return abort('dialog_recipient_mismatch', 'dialog addresses a different person', { close: true });
      const boxes = tree.nodes.filter((x) => x.dialog === dlg && x.role === 'textbox' && x.composer && !x.secret);
      if (boxes.length > 1) return abort('ambiguous_composer', 'more than one text field in the dialog', { close: true });
      if (boxes.length === 1) {
        const ln = await page.describe(boxes[0].n).catch(() => null);
        liveText = ln?.value;
      }
    }
  } else {
    // accept: the Accept button must belong to the armed sender's row (nearest preceding profile link, same row)
    if (classifyUrl(url) !== 'invitations') return abort('wrong_page', 'not on the invitations page');
    const slug = extractProfileSlug(profileUrl);
    const link = [...tree.nodes].reverse().find((x) => x.n < live.n && x.role === 'link' && /\/in\//.test(x.href ?? ''));
    const between = tree.nodes.filter((x) => link && x.n > link.n && x.n < live.n && x.role === 'button' && /^accept\b/.test(normName(x.name)));
    if (!link || between.length > 0 || extractProfileSlug(link.href ?? '') !== slug) return abort('row_mismatch', 'Accept is not in the armed sender row');
    if (link.name && !namesPlausiblyMatch(expectedName, link.name)) return abort('row_mismatch', 'row names a different person');
    acceptBefore = acceptCount(tree);
  }

  // 5. intent re-check with the live text (no text for accept; the open step cannot read a composer)
  const chk = deps.intents.check(platform, cls, openStep ? intent.text : liveText);
  if (!chk.ok) return abort(chk.code, `armed intent refused: ${chk.code}`, { close: true });
  intent = chk.intent;

  // 6. element unchanged, halt again
  const again = await i.redescribe().catch(() => null);
  if (!again || !sameTarget(again, live)) return abort('target_changed', 'page changed under the action; nothing clicked', { close: true });
  const k1 = killReason(deps);
  if (k1) return abort('halted', k1, { status: 'halted', close: true });

  // 7. dry run
  if (intent.dry || deps.cfg.dryRun) {
    recordDryRun(db, {
      runId: null, action: `linkedin_${cls}`, platform, personId: intent.personId ?? null,
      payload: { kind: intent.kind, chars: intent.text?.length ?? 0, recipient: expectedName, open_step: openStep },
    }, now(), deps.env);
    await closeDialog();
    deps.intents.disarm(platform);
    return { ok: true, status: 'dry_run', code: 'dry_run', ...(intent.touchId !== undefined ? { touch_id: intent.touchId } : {}) };
  }

  // 8. live: single-use intent, ceiling right before the click
  if (!openStep) {
    const used = deps.intents.consume(platform, intent.id);
    if (!used.ok) return abort(used.code, `armed intent refused: ${used.code}`, { close: true });
  }
  const ocfg = loadOutreachConfig(deps.env);
  if (!openStep) {
    const okCeil = cls === 'commit_connect_send' ? tryConsume(db, 'linkedin_invite', ocfg, now())
      : cls === 'commit_message_send' ? tryConsume(db, 'linkedin_message', ocfg, now())
        : checkAndIncrement(db, 'linkedin_accept', deps.cfg.maxAcceptsPerDay);
    if (!okCeil) {
      await closeDialog();
      release('refused');
      return { ok: false, status: 'rate_limited', code: 'rate_limited', reason: 'ceiling spent' };
    }
  }

  const isLinkedInHost = (r: unknown): boolean => {
    try {
      const x = r as { url(): string; status(): number; request(): { method(): string } };
      const h = new URL(x.url()).hostname.toLowerCase();
      return (h === 'linkedin.com' || h.endsWith('.linkedin.com')) && x.request().method() === 'POST' && x.status() >= 200 && x.status() < 300;
    } catch { return false; }
  };
  const timeout = deps.confirmTimeoutMs ?? 8000;
  const net = openStep ? Promise.resolve(false)
    : page.waitForResponse(isLinkedInHost, timeout).then(() => true, () => false);
  try {
    clickIssued = true;
    await i.act();
    const confirmedNet = await net;
    await page.waitMs(deps.settleMs ?? 800).catch(() => undefined);
    let after = await page.snapshot();
    // Block page after the click: the platform is halted by the engine's next read; the send is unresolved.
    if (openStep) {
      // LinkedIn may open the modal late: poll (bounded) for an invite dialog of any name, or a navigated invite page.
      const pollMs = 400;
      const polls = Math.max(0, Math.ceil((deps.dialogWaitMs ?? 4000) / pollMs));
      let surface = inviteSurface(after, url);
      for (let i = 0; i < polls && !surface; i++) {
        await page.waitMs(pollMs).catch(() => undefined);
        after = await page.snapshot();
        surface = inviteSurface(after, url);
      }
      if (surface === 'dialog') { keepArmed = true; return { ok: true, code: 'dialog_opened', reason: 'invite dialog is open; type the armed note and click Send' }; }
      if (surface === 'page') { keepArmed = true; return { ok: true, code: 'invite_page_opened', reason: 'LinkedIn opened an invite page; take a snapshot and continue only if it shows the armed person' }; }
      release('unconfirmed');
      return { ok: false, status: 'unconfirmed', code: 'no_dialog_after_connect', reason: 'Connect clicked but no invite dialog appeared; verify manually' };
    }
    const dialogGone = cls === 'commit_accept_invite' ? acceptCount(after) < acceptBefore
      : cls === 'commit_connect_send' ? !after.nodes.some((x) => x.role === 'dialog' && x.name === live.dialogName)
        : (() => {
          const d = after.nodes.find((x) => x.role === 'dialog' && x.name === live.dialogName);
          if (!d) return true;
          const box = after.nodes.find((x) => x.dialog === d.n && x.role === 'textbox' && x.composer);
          return !!box && !box.value;
        })();
    if (confirmedNet && dialogGone) {
      if (cls !== 'commit_accept_invite' && intent.touchId !== undefined) finishTouch(db, intent.touchId, 'sent', now());
      try {
        saveConnection(db, {
          job_id: intent.jobId === undefined ? null : String(intent.jobId), company: intent.company ?? null, profile_url: profileUrl,
          headline: null, note: intent.text ?? '', status: cls === 'commit_connect_send' ? 'sent' : cls === 'commit_message_send' ? 'messaged' : 'sent',
          sent_at: now().toISOString(),
        });
      } catch { /* legacy table only; the touch row is authoritative */ }
      return { ok: true, status: 'sent', code: 'sent', ...(intent.touchId !== undefined ? { touch_id: intent.touchId } : {}) };
    }
    release('unconfirmed');
    return { ok: false, status: 'unconfirmed', code: 'unconfirmed', reason: `clicked but not confirmed (${confirmedNet ? 'response seen' : 'no response'}, ${dialogGone ? 'dialog gone' : 'dialog still open'}); verify manually`, ...(intent.touchId !== undefined ? { touch_id: intent.touchId } : {}) };
  } catch {
    // A throw before the click is a failure; after it the send may have gone out.
    if (clickIssued) { release('unconfirmed'); return { ok: false, status: 'unconfirmed', code: 'unconfirmed', reason: 'error after the click; verify manually' }; }
    release('failed');
    return { ok: false, status: 'failed', code: 'error', reason: 'unexpected error before sending' };
  } finally {
    if (!keepArmed) deps.intents.disarm(platform);
  }
}
