// browserctl commit path: the only code that lets a commit-class click (connect, message send, accept)
// reach the page. Reached from the engine's click, press_key and click_at when the guard classified the
// live element as commit_connect_send, commit_message_send or commit_accept_invite.
// Order: kill switch and halt -> armed intent -> fresh page read (profile key from the URL, recipient
// name in the dialog or row, live composer text) -> element unchanged -> halt again -> dry run (record,
// close dialog, disarm) or live (consume the intent, tryConsume the ceiling, arm the response watcher,
// click, re-read up to CONFIRM_POLL_MS: sent = dialog gone AND (Pending or sent toast, or a 2xx POST with no error text);
// an error or limit message on the page = failed) -> finishTouch, saveConnection, disarm.
// Anything after the click that cannot be confirmed is 'unconfirmed', never guessed.
import { saveConnection } from '../db.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
import { extractDialogRecipientName, extractProfileSlug, namesPlausiblyMatch, verifyProfileUrl } from '../linkedin/verify.js';
import { markNoteQuotaExhausted } from '../linkedin/noteQuota.js';
import { classifyUrl, profileKeyOf } from '../linkedin/urls.js';
import { finishTouch, finishTouchSentNoNote, releaseNoDialog } from '../linkedin/touches.js';
import { loadOutreachConfig } from '../outreach/config.js';
import { recordEvent, tryConsume } from '../outreach/limits.js';
import { recordDryRun } from '../safety/dryRun.js';
import { diagNote, writeCommitDiag } from './diag.js';
import type { BcPage } from './driver.js';
import { killReason, type EngineDeps, type EngineResult } from './engineTypes.js';
import { dialogKindOf, normName, type CommitClass } from './guard.js';
import type { ArmedIntent } from './intent.js';
import { OPEN_CEILING_MS } from './locatorDialogs.js';
import { bindTouchRelease } from './intent.js';
import type { LiveNode, RawTree } from './snapshot.js';
import { CONFIRM_POLL_MS, CONFIRM_POLL_STEP_MS, errorSignalOf, noteQuotaModal, type ErrorSignal } from './sendSignals.js';
import { connectionStateOf, directSendSeen } from './topCard.js';

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

/** The code of a platform-level stop: the monthly quota of personalized invite notes is used up (not a failure of that person). */
export const NOTE_QUOTA_CODE = 'custom_note_limit_reached';
/** The only button a note-less invite (arm kind connect_plain) may click inside the invite dialog. */
const PLAIN_SEND_BUTTON = 'send without a note';

/**
 * The note-quota upsell is on screen: close it, remember the quota is used up (until the 1st of next month, IST), release any
 * still-armed touch as failed (disarm) and tell the operator to switch to connect_plain. Never a failure of that person.
 */
export async function stopOnNoteQuota(deps: Pick<EngineDeps, 'db' | 'now' | 'intents'>, page: BcPage): Promise<EngineResult> {
  await page.press('Escape').catch(() => undefined);
  markNoteQuotaExhausted(deps.db, deps.now());
  deps.intents.disarm('linkedin');
  return {
    ok: false, status: 'failed', code: NOTE_QUOTA_CODE,
    reason: 'LinkedIn showed its Premium upsell for personalized notes: the monthly note quota is used up, nothing was sent. Re-arm this same person ONCE with kind connect_plain (no note); use connect_plain for every later invite until the quota resets.',
  };
}

const GENERIC_HEADS =/^(messaging|messages|new message|conversation|chat|compose|compose message|write a message)$/i;

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

const hasControls = (tree: RawTree, dlg: number): boolean =>
  tree.nodes.some((x) => x.dialog === dlg && (x.role === 'button' || x.role === 'link' || x.role === 'textbox'));

/** Kind of a dialog that lists no control: by its name, else by its text ("invitation"), else unknown. */
function emptyDialogKind(tree: RawTree, d: { n: number; name: string }): 'invite' | 'message' | 'other' | 'unknown' {
  const byName = dialogKindOf(d.name);
  if (byName && byName !== 'other') return byName;
  if (/\binvit/i.test(dialogText(tree, d.n))) return 'invite';
  return byName ?? 'unknown';
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
  // Live dialog: "Personalize your invitation to <name> by adding a note." where the name is its own element, so the text
  // reads "invitation to by adding a note" and the name is the next short text node. Never take "by adding a note" as a name.
  if (a && !/^by adding a note\b/i.test(a)) return a;
  const lines = text.split('\n');
  const gap = lines.findIndex((l) => /invitation to\s+by adding a note\b/i.test(l));
  if (gap >= 0) {
    const next = lines.slice(gap + 1).find((l) => {
      const t = l.trim();
      return t !== '' && t.length <= 50 && t.split(/\s+/).length <= 5 && !/[.?!:]/.test(t);
    });
    if (next) return next.trim();
  }
  for (const line of lines) {
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

/** Name of the person on a profile page: the first heading of the top card, else the first heading; '' when none. */
export function profileHeadingName(tree: RawTree): string {
  const heads = tree.nodes.filter((x) => x.role === 'heading' && x.dialog === undefined && x.name);
  return (heads.find((x) => x.region === 'topcard') ?? heads[0])?.name ?? '';
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
  let topCardName = '';
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
      // Connection state from the top card and the More menu: a pending or non-connectable profile is never invited.
      const cs = connectionStateOf(tree);
      if (cs?.state === 'already_pending') return abort('already_pending', cs.reason);
      if (cs?.state === 'not_connectable') return abort('not_connectable', cs.reason);
      topCardName = head;
      openStep = true;
    } else {
      if (effectiveDialogKind(tree, dlg, live.dialogName) !== wantKind) return abort('wrong_dialog', 'dialog is not the expected kind', { close: true });
      // A note-less invite clicks only "Send without a note": never Send, Send invitation, Add a note or a typed field.
      if (intent.kind === 'connect_plain' && normName(live.name) !== PLAIN_SEND_BUTTON) {
        return abort('plain_invite_send_only', 'a note-less invite may only click "Send without a note"', { close: true });
      }
      let shown = wantKind === 'invite' ? inviteDialogName(tree, dlg) : messageDialogName(tree, dlg);
      // The live invite dialog names nobody. The recipient is then the person of the profile the engine's own Connect click
      // opened it on: same page (checked above), top card name read now or, when the modal hides it, captured before the click.
      if (!shown && wantKind === 'invite' && intent.inviteOpened?.profileKey === intent.profileKey) {
        shown = profileHeadingName(tree) || intent.inviteOpened.name;
      }
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
    const settle = deps.settleMs ?? 800;
    await page.waitMs(settle).catch(() => undefined);
    // From the click on the opening is polled here, by this one loop (the page does not wait on its own meanwhile).
    if (openStep) page.setOpenWatch?.(true);
    let after = await page.snapshot();
    // Block page after the click: the platform is halted by the engine's next read; the send is unresolved.
    if (openStep) {
      // LinkedIn may open the modal seconds late and fill it in later still: one ceiling from the click, polled until the
      // invite dialog (any name) lists its controls, or a navigated invite page shows, or the page sent the invite directly.
      const pollMs = 400;
      const ceiling = deps.dialogWaitMs ?? OPEN_CEILING_MS;
      const t0 = Date.now();
      let waited = settle;
      const elapsed = (): number => Math.max(waited, Date.now() - t0);
      let surface = inviteSurface(after, url);
      // A dialog that is open but lists none of its controls.
      const bareOf = (t: RawTree, sf: 'dialog' | 'page' | null) => (sf === 'page' ? undefined : t.nodes.find((x) => x.role === 'dialog' && !hasControls(t, x.n)
        && (sf === 'dialog' ? effectiveDialogKind(t, x.n, x.name) === 'invite' : t.url === url)));
      let bare = bareOf(after, surface);
      while (!(surface === 'page' || (surface === 'dialog' && !bare)) && elapsed() < ceiling) {
        if (!surface && directSendSeen(after) && !directSendSeen(tree)) break;
        await page.waitMs(pollMs).catch(() => undefined);
        waited += pollMs;
        after = await page.snapshot();
        surface = inviteSurface(after, url);
        bare = bareOf(after, surface);
      }
      const waitFacts = { waitedMs: elapsed() };
      // A dialog is open but none of its controls could be read within the ceiling: nothing can be clicked or typed, so
      // this is not dialog_opened. The dialog is left open for a screenshot.
      if (bare) {
        if (intent?.touchId !== undefined && !intent.dry) releaseNoDialog(db, intent.touchId, now());
        const kind = emptyDialogKind(after, bare);
        const dg = await writeCommitDiag(deps, page, { platform, code: 'dialog_controls_missing', live, urlBefore: url, after, wait: waitFacts });
        return { ok: false, status: 'failed', code: 'dialog_controls_missing', reason: `Connect clicked and a dialog is open (dialog kind: ${kind}), but its buttons and text field could not be read; nothing was sent. Take one linkedin_screenshot to see it, escalate once and move to the next contact.${diagNote(dg)}` };
      }
      if (surface === 'dialog') {
        keepArmed = true;
        deps.intents.markInviteOpened(platform, { profileKey: intent.profileKey!, name: topCardName });
        return { ok: true, code: 'dialog_opened', reason: intent.kind === 'connect_plain' ? 'invite dialog is open; click "Send without a note" (nothing is typed)' : 'invite dialog is open; type the armed note and click Send' };
      }
      if (surface === 'page') { keepArmed = true; return { ok: true, code: 'invite_page_opened', reason: 'LinkedIn opened an invite page; take a snapshot and continue only if it shows the armed person' }; }
      // No dialog, but the page now shows the invitation went out (Pending in the top card, or an "Invitation sent"
      // toast): LinkedIn sent it directly, without a note. Record it as sent and never retry this person.
      if (directSendSeen(after) && !directSendSeen(tree)) {
        if (intent?.touchId !== undefined) finishTouchSentNoNote(db, intent.touchId, now());
        recordEvent(db, 'linkedin_invite', now());
        try {
          saveConnection(db, {
            job_id: intent?.jobId === undefined ? null : String(intent.jobId), company: intent?.company ?? null, profile_url: profileUrl,
            headline: null, note: '', status: 'sent', sent_at: now().toISOString(),
          });
        } catch { /* legacy table only; the touch row is authoritative */ }
        return { ok: true, status: 'sent', code: 'sent_without_note', reason: 'LinkedIn sent the invitation directly, without a note; recorded as sent. Never retry this person; move to the next company.', ...(intent?.touchId !== undefined ? { touch_id: intent.touchId } : {}) };
      }
      if (intent?.touchId !== undefined && !intent.dry) releaseNoDialog(db, intent.touchId, now());
      const dg = await writeCommitDiag(deps, page, { platform, code: 'no_dialog_after_connect', live, urlBefore: url, after, wait: waitFacts });
      return { ok: false, status: 'failed', code: 'no_dialog_after_connect', reason: `Connect clicked but no invite dialog appeared; nothing was sent. Escalate once and move to the next contact.${diagNote(dg)}` };
    }
    const dialogGoneOf = (t: RawTree): boolean => cls === 'commit_accept_invite' ? acceptCount(t) < acceptBefore
      : cls === 'commit_connect_send' ? !t.nodes.some((x) => x.role === 'dialog' && x.name === live.dialogName)
        : (() => {
          const d = t.nodes.find((x) => x.role === 'dialog' && x.name === live.dialogName);
          if (!d) return true;
          const box = t.nodes.find((x) => x.dialog === d.n && x.role === 'textbox' && x.composer);
          return !!box && !box.value;
        })();
    // The dialog going away is not proof: an error modal can replace it, and any LinkedIn POST satisfies the network half.
    // Re-read for a while: stop at once on an error signal, or when the dialog is gone and the page shows the invite as
    // sent (Pending or a sent toast, connect only).
    const read = (t: RawTree): { dialogGone: boolean; strong: boolean; signal: ErrorSignal } => ({
      dialogGone: dialogGoneOf(t),
      strong: cls === 'commit_connect_send' && directSendSeen(t),
      signal: errorSignalOf(tree, t),
    });
    let seen = read(after);
    let polledMs = 0;
    while (seen.signal === 'none' && !(seen.dialogGone && seen.strong) && polledMs < CONFIRM_POLL_MS) {
      await page.waitMs(CONFIRM_POLL_STEP_MS).catch(() => undefined);
      polledMs += CONFIRM_POLL_STEP_MS;
      after = await page.snapshot();
      seen = read(after);
    }
    const { dialogGone, strong, signal } = seen;
    const facts = { strong, network: confirmedNet, dialogGone, signal, polledMs };
    // The note-quota upsell is a platform fact, not a refusal of this person (and its text would read as a generic limit).
    if (cls === 'commit_connect_send' && noteQuotaModal(after)) {
      release('failed');
      return stopOnNoteQuota(deps, page);
    }
    if (signal !== 'none') {
      // A refusal on the page: never sent, the modal is closed. A limit message is a platform signal (the operator stops the task).
      await page.press('Escape').catch(() => undefined);
      release('failed');
      const code = signal === 'limit' ? 'invite_limit_reached' : 'send_error_modal';
      const dgE = await writeCommitDiag(deps, page, { platform, code, live, urlBefore: url, after, send: facts });
      return { ok: false, status: 'failed', code, reason: `clicked, but the page shows ${signal === 'limit' ? 'a limit message; nothing was sent, stop this task' : 'an error message; nothing was sent'}${diagNote(dgE)}`, ...(intent.touchId !== undefined ? { touch_id: intent.touchId } : {}) };
    }
    if (dialogGone && (strong || confirmedNet)) {
      if (cls !== 'commit_accept_invite' && intent.touchId !== undefined) {
        if (intent.kind === 'connect_plain') finishTouchSentNoNote(db, intent.touchId, now());
        else finishTouch(db, intent.touchId, 'sent', now());
      }
      try {
        saveConnection(db, {
          job_id: intent.jobId === undefined ? null : String(intent.jobId), company: intent.company ?? null, profile_url: profileUrl,
          headline: null, note: intent.text ?? '', status: cls === 'commit_connect_send' ? 'sent' : cls === 'commit_message_send' ? 'messaged' : 'sent',
          sent_at: now().toISOString(),
        });
      } catch { /* legacy table only; the touch row is authoritative */ }
      const dgOk = await writeCommitDiag(deps, page, { platform, code: 'sent', live, urlBefore: url, after, send: facts });
      return { ok: true, status: 'sent', code: 'sent', ...(dgOk ? { reason: `confirmed by ${strong ? 'the page' : 'the network response only'}${diagNote(dgOk)}` } : {}), ...(intent.touchId !== undefined ? { touch_id: intent.touchId } : {}) };
    }
    release('unconfirmed');
    const dg2 = await writeCommitDiag(deps, page, { platform, code: 'unconfirmed', live, urlBefore: url, after, send: facts });
    return { ok: false, status: 'unconfirmed', code: 'unconfirmed', reason: `clicked but not confirmed (${confirmedNet ? 'response seen' : 'no response'}, ${dialogGone ? 'dialog gone' : 'dialog still open'}); verify manually${diagNote(dg2)}`, ...(intent.touchId !== undefined ? { touch_id: intent.touchId } : {}) };
  } catch {
    // A throw before the click is a failure; after it the send may have gone out.
    if (clickIssued) {
      release('unconfirmed');
      const dg3 = await writeCommitDiag(deps, page, { platform, code: 'unconfirmed', live, urlBefore: url, after: null });
      return { ok: false, status: 'unconfirmed', code: 'unconfirmed', reason: `error after the click; verify manually${diagNote(dg3)}` };
    }
    release('failed');
    return { ok: false, status: 'failed', code: 'error', reason: 'unexpected error before sending' };
  } finally {
    page.setOpenWatch?.(false);
    if (!keepArmed) deps.intents.disarm(platform);
  }
}
