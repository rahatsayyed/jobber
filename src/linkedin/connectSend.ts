// Typed connect_send. Irreversible: every gate fails closed, the ceiling is consumed right before
// the Send click, and any exit after the click without confirmation is 'unconfirmed' (D9).
import { saveConnection } from '../db.js';
import { loadOutreachConfig } from '../outreach/config.js';
import { ceilings, haltReason, tryConsume } from '../outreach/limits.js';
import { gateOutbound } from '../safety/outputGate.js';
import { outputGateContext, preSendGuard } from './guard.js';
import { getProfileNamePoint, pickNearestLocator } from './proximity.js';
import { layoutGate } from './layoutGuard.js';
import { SELECTORS } from './selectors.js';
import { gateField, MAX_FIELD_CHARS } from './state.js';
import { finishTouch, pauseContact, type TouchStatus } from './touches.js';
import { refusal, type ToolDeps, type TypedResult } from './toolDeps.js';
import { SNAPSHOT_SRC } from './snapshot.js';
import type { LiPage, RawSnapshot } from './types.js';
import {
  extractDialogRecipientName, extractExpectedNameFromTitle, isLikelySendInvitationResponse,
  namesPlausiblyMatch, pickButtonShapedIndex, verifyProfileUrl, verifyRecipientName,
} from './verify.js';

export interface ConnectSendOptions {
  pendingConfirmationTimeoutMs?: number;
  pendingConfirmationPollMs?: number;
  networkConfirmationTimeoutMs?: number;
  stepTimeoutMs?: number;
}

const CLICK_TIMEOUT_MS = 2000;

export async function connectSend(
  a: { profile_url: string; note: string; kind?: 'connect'; job_id?: string; company?: string; dry_run?: boolean },
  deps: ToolDeps,
  opts: ConnectSendOptions = {},
): Promise<TypedResult> {
  const { rt, db, now, cfg, env } = deps;
  const pendingTimeout = opts.pendingConfirmationTimeoutMs ?? 90000;
  const pendingPoll = opts.pendingConfirmationPollMs ?? 5000;
  const netTimeout = opts.networkConfirmationTimeoutMs ?? 12000;
  const stepTimeout = opts.stepTimeoutMs ?? 8000;

  const g = preSendGuard({
    db, now: now(), env, action: 'invite', kind: 'connect', profileUrl: a.profile_url, text: a.note,
    jobId: a.job_id ?? null, company: a.company, factCheck: deps.factCheck, styleCfg: deps.styleCfg, cfg,
    callDryRun: a.dry_run,
  });
  if (!g.ok) {
    if (g.code === 'already_sent') return { status: 'already_sent', code: 'already_sent', reason: g.reason };
    return refusal(g.status, g.code, g.reason);
  }

  const { person, text, touchId } = g;
  let clickIssued = false;
  const done = (touch: TouchStatus, r: TypedResult): TypedResult => {
    finishTouch(db, touchId, touch, now());
    return { ...r, touch_id: touchId };
  };
  const fail = (code: string, reason: string) => done('failed', refusal('failed', code, reason));
  const refuse = (code: string, reason: string) => done('refused', refusal('refused', code, reason));

  try {
    // Step 2: open (the runtime serializes and halts on block pages).
    const opened = await rt.open(a.profile_url);
    if (!opened.ok) {
      if (opened.code === 'halted') return done('refused', refusal('halted', 'halted', 'linkedin halted'));
      return fail(opened.code, opened.reason);
    }

    return await rt.serial(async (): Promise<TypedResult> => {
      const page = rt.page();
      if (!page) return fail('no_session', 'browser session is not open');
      // open() released the queue before this block: never trust its snapshot, take a fresh one.
      const takeSnap = () => page.evaluate<RawSnapshot>(SNAPSHOT_SRC).then((s) => s ?? null, () => null);
      const haltIfBlocked = async (): Promise<TypedResult | null> => {
        const s = await takeSnap();
        if (!s) return fail('no_snapshot', 'could not read the page');
        return rt.afterNavigation(s) ? done('refused', refusal('halted', 'halted', 'linkedin block page')) : null;
      };
      const snap = await takeSnap();
      if (!snap) return fail('no_snapshot', 'could not read the page');
      if (rt.afterNavigation(snap)) return done('refused', refusal('halted', 'halted', 'linkedin block page'));
      if (!verifyProfileUrl(a.profile_url, page.url()).ok) {
        return fail('profile_url_mismatch', 'page is not the requested profile');
      }
      // Step 3: title name must plausibly match the seeded person.
      const titleName = extractExpectedNameFromTitle(snap.title);
      if (!namesPlausiblyMatch(person.name ?? '', titleName)) {
        return refuse('recipient_mismatch', 'profile name does not match the seeded recipient');
      }
      // Step 4: status re-check on the same page.
      const p = snap.profile;
      if (!p) return fail('no_profile', 'profile header not found');
      if (p.hasBell) return refuse('already_connected', 'recipient is already a connection');
      if (p.pending) return refuse('already_pending', 'an invitation is already pending');
      // Layout precondition: after the recipient and status guards, before any gate cost or ceiling.
      const lay = layoutGate('connect_send', deps);
      if (!lay.ok) return refuse(lay.code, lay.reason);
      // Step 5: injection gate over visible profile fields, then the page-dependent output gate.
      const fields: Array<[string, number]> = [
        [snap.title, MAX_FIELD_CHARS.headline], [p.name, MAX_FIELD_CHARS.name],
        [p.headline, MAX_FIELD_CHARS.headline], [p.location, MAX_FIELD_CHARS.location],
        [p.about ?? '', MAX_FIELD_CHARS.about],
      ];
      if (fields.some(([s, max]) => s && gateField(s, max).blocked)) {
        pauseContact(db, person.id, 'injection_suspected', now());
        return refuse('injection_suspected', 'profile text looks like an injection attempt');
      }
      {
        const sv = await deps.screen(fields.map(([t]) => t).filter(Boolean).join('\n'), 'send');
        if (sv.blocked) {
          if (sv.code === 'classifier_unavailable') return fail('classifier_unavailable', 'classifier is unavailable');
          pauseContact(db, person.id, 'injection_suspected', now());
          return refuse('injection_suspected', 'profile text looks like an injection attempt');
        }
      }
      const og = gateOutbound(
        text,
        outputGateContext({
          person, actualProfileUrl: page.url(), rawPageText: snap.bodyText, cfg, env, factVerdict: g.factVerdict,
        }),
      );
      if (!og.ok) return refuse('output_gate_page', `output gate: ${og.reasons.join(', ')}`);

      // Step 6: dry run stops here, before any click or menu.
      if (g.dryRun) {
        return done('dry_run', {
          status: 'dry_run', code: 'dry_run',
          would_send: { kind: 'connect', chars: text.length, recipient: person.profile_key },
        });
      }
      if (haltReason(db, 'linkedin')) return done('refused', refusal('halted', 'halted', 'linkedin halted'));

      // Step 7: open the invite dialog (direct Connect near the name, else the More menu).
      const alt = [person.name ?? ''];
      const namePoint = await getProfileNamePoint(page, titleName, alt);
      if (namePoint === null) {
        await page.keyboard.press('Escape').catch(() => undefined);
        return fail('name_position_unknown', 'could not locate the profile name on the page');
      }
      const direct = await pickNearestLocator(page, SELECTORS.directConnectButton, namePoint);
      if ((await direct.count()) > 0) {
        const aria = await direct.evaluateAll((els) => els.map((el) => String(el.getAttribute('aria-label') ?? '')));
        const target = /^Invite (.+) to connect$/i.exec((aria[0] ?? '').trim())?.[1] ?? '';
        if (!target || !namesPlausiblyMatch(person.name ?? '', target)) {
          return fail('connect_target_mismatch', 'Connect control names a different person');
        }
        await direct.click({ timeout: CLICK_TIMEOUT_MS });
        const hb = await haltIfBlocked();
        if (hb) return hb;
      } else {
        const mores = page.locator(SELECTORS.moreButton);
        const boxes = (await mores.count()) > 0
          ? await mores.evaluateAll((els) => els.map((el) => ({ height: el.getBoundingClientRect().height })))
          : [];
        const mi = pickButtonShapedIndex(boxes);
        if (mi === -1) return fail('more_button_not_found', 'More button not found');
        await mores.nth(mi).click({ timeout: CLICK_TIMEOUT_MS });
        await page.locator(SELECTORS.connectMenuItem).first()
          .waitFor({ state: 'visible', timeout: stepTimeout }).catch(() => undefined);
        const hm = await haltIfBlocked();
        if (hm) return hm;
        // Exact `Connect` only: a menu with just "Remove connection" never matches.
        const item = page.locator(SELECTORS.connectMenuItem);
        if ((await item.count()) === 0) {
          await page.keyboard.press('Escape').catch(() => undefined);
          return fail('connect_menu_item_missing', 'no exact Connect item in the More menu');
        }
        await item.first().click({ timeout: CLICK_TIMEOUT_MS });
        const hi = await haltIfBlocked();
        if (hi) return hi;
      }

      // Step 8: dialog verification, fail closed.
      const dlg = page.locator(SELECTORS.noteDialogContainer);
      await dlg.first().waitFor({ state: 'visible', timeout: stepTimeout }).catch(() => undefined);
      const hd = await haltIfBlocked();
      if (hd) return hd;
      const close = () => page.keyboard.press('Escape').catch(() => undefined);
      if (!verifyProfileUrl(a.profile_url, page.url()).ok) {
        await close();
        return fail('profile_url_mismatch', 'browser left the requested profile');
      }
      if ((await dlg.count()) === 0) return fail('dialog_not_found', 'invite dialog did not open');
      const dialogText = (await dlg.first().textContent()) ?? '';
      if (!extractDialogRecipientName(dialogText)) {
        await close();
        return refuse('dialog_name_unverified', 'could not read the dialog recipient name');
      }
      if (!verifyRecipientName(person.name ?? '', dialogText).ok) {
        await close();
        return refuse('dialog_recipient_mismatch', 'dialog addresses a different person');
      }

      // Step 9: add the note; never send without it.
      // Everything below is scoped to the verified invite dialog, never the page.
      const dialog = dlg.first();
      const area = dialog.locator(SELECTORS.noteTextarea);
      if ((await area.count()) === 0) {
        const add = dialog.locator(SELECTORS.addNoteButton);
        if ((await add.count()) > 0) {
          await add.first().click({ timeout: CLICK_TIMEOUT_MS });
          await area.first().waitFor({ state: 'visible', timeout: stepTimeout }).catch(() => undefined);
        }
      }
      if ((await area.count()) === 0) {
        await close();
        return fail('note_field_missing', 'note field not found');
      }
      await area.first().fill(text, { timeout: stepTimeout });
      const send = dialog.locator(SELECTORS.sendButton);
      if ((await send.count()) === 0) {
        await close();
        return fail('send_button_missing', 'Send button not found');
      }

      // Step 10: consume the ceiling immediately before the click, never earlier.
      const ocfg = loadOutreachConfig(env);
      if (!tryConsume(db, 'linkedin_invite', ocfg, now())) {
        await close();
        const c = ceilings(db, ocfg, now()).linkedin_invite;
        return done('refused', {
          status: 'rate_limited', code: 'rate_limited', reason: `${c.used} of ${c.limit} this week`,
        });
      }

      // Step 11: listen first, then click Send.
      const net = page
        .waitForResponse((r) => isLikelySendInvitationResponse(r), { timeout: netTimeout })
        .then(() => true)
        .catch(() => false);
      clickIssued = true;
      await send.first().click({ timeout: CLICK_TIMEOUT_MS });

      // Step 12: confirm by response, else by the Pending control after a reload.
      let confirmed = await net;
      if (!confirmed) confirmed = await pollPending(page, a.profile_url, titleName, alt, pendingTimeout, pendingPoll, async () => {
          const s = await takeSnap();
          return !s || rt.afterNavigation(s) !== null;
        });
      if (!confirmed) {
        return done('unconfirmed', {
          status: 'unconfirmed', code: 'unconfirmed', reason: 'Send clicked but not confirmed; verify manually',
        });
      }
      finishTouch(db, touchId, 'sent', now());
      try {
        saveConnection(db, {
          job_id: a.job_id ?? null, company: a.company ?? null, profile_url: a.profile_url,
          headline: null, note: text, status: 'sent', sent_at: now().toISOString(),
        });
      } catch { /* legacy table only; the touch row is authoritative */ }
      return { status: 'sent', code: 'sent', touch_id: touchId };
    });
  } catch {
    // A throw before the click is a failure; after it the send may have gone out (D9).
    return clickIssued
      ? done('unconfirmed', { status: 'unconfirmed', code: 'unconfirmed', reason: 'error after Send click; verify manually' })
      : fail('error', 'unexpected error before sending');
  }
}

async function pollPending(
  page: LiPage, url: string, name: string, alt: string[], timeoutMs: number, pollMs: number,
  blocked: () => Promise<boolean>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    try {
      await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
      if (await blocked()) return false;
      if (verifyProfileUrl(url, page.url()).ok) {
        const point = await getProfileNamePoint(page, name, alt);
        if (point === null) return false; // no proximity anchor: only the response can confirm
        const loc = await pickNearestLocator(page, SELECTORS.pendingButton, point);
        if ((await loc.count()) > 0) {
          const seen = await loc.waitFor({ state: 'visible', timeout: pollMs }).then(() => true, () => false);
          if (seen) return true;
        }
      }
    } catch { /* keep polling until the deadline */ }
    await page.waitForTimeout(pollMs).catch(() => undefined);
  } while (Date.now() < deadline);
  return false;
}
