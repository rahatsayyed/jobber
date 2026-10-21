// Typed send_message to an existing 1st-degree connection. Irreversible: every gate fails closed,
// the ceiling is consumed right before the Send click, and any exit after the click without
// confirmation is 'unconfirmed' (D9).
import { saveConnection } from '../db.js';
import { loadOutreachConfig } from '../outreach/config.js';
import { ceilings, haltReason, tryConsume } from '../outreach/limits.js';
import { gateOutbound } from '../safety/outputGate.js';
import { outputGateContext, preSendGuard, type Kind } from './guard.js';
import { getProfileNamePoint, pickNearestLocator } from './proximity.js';
import { layoutGate } from './layoutGuard.js';
import { SELECTORS } from './selectors.js';
import { gateField, MAX_FIELD_CHARS } from './state.js';
import { finishTouch, pauseContact, type TouchStatus } from './touches.js';
import { refusal, type ToolDeps, type TypedResult } from './toolDeps.js';
import { SNAPSHOT_SRC } from './snapshot.js';
import type { LiLocator, RawSnapshot } from './types.js';
import { extractExpectedNameFromTitle, namesPlausiblyMatch, verifyProfileUrl } from './verify.js';
import { connectionState } from './connectionState.js';

export interface SendMessageOptions {
  composeClearTimeoutMs?: number;
  composeClearPollMs?: number;
  networkConfirmationTimeoutMs?: number;
  stepTimeoutMs?: number;
}

const CLICK_TIMEOUT_MS = 2000;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

// Best-effort heuristic, not verified live: a 2xx POST to a voyager messaging endpoint.
function isLikelySendMessageResponse(r: any): boolean {
  try {
    const url = String(r.url()).toLowerCase();
    return url.includes('voyager') && /messag/.test(url) && r.request().method() === 'POST'
      && r.status() >= 200 && r.status() < 300;
  } catch { return false; }
}

const ALLOWED_KINDS = ['role_ask', 'rapport', 'referral_ask', 'followup', 'feedback'];

// Indexes of matches that are actually visible (non-zero box).
async function visibleIndexes(loc: LiLocator): Promise<number[]> {
  const flags = await loc.evaluateAll((els) =>
    els.map((el) => Boolean(el.offsetWidth || el.offsetHeight || (el.getClientRects && el.getClientRects().length))));
  const out: number[] = [];
  flags.forEach((f, i) => { if (f) out.push(i); });
  return out;
}

export async function sendMessage(
  a: {
    profile_url: string; text: string; kind: Exclude<Kind, 'connect'>;
    job_id?: string; company?: string; dry_run?: boolean;
  },
  deps: ToolDeps,
  opts: SendMessageOptions = {},
): Promise<TypedResult> {
  const { rt, db, now, cfg, env } = deps;
  const clearTimeoutMs = opts.composeClearTimeoutMs ?? 5000;
  const clearPoll = opts.composeClearPollMs ?? 300;
  const netTimeout = opts.networkConfirmationTimeoutMs ?? 12000;
  const stepTimeout = opts.stepTimeoutMs ?? 8000;

  if (!ALLOWED_KINDS.includes(String(a.kind))) {
    return refusal('refused', 'bad_kind', 'kind is not a message kind');
  }
  const g = preSendGuard({
    db, now: now(), env, action: 'message', kind: a.kind, profileUrl: a.profile_url, text: a.text,
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
  const unconfirmed = (reason: string) => done('unconfirmed', { status: 'unconfirmed', code: 'unconfirmed', reason });

  try {
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
      const close = () => page.keyboard.press('Escape').catch(() => undefined);
      const blockedResult = (): TypedResult =>
        clickIssued
          ? unconfirmed('linkedin block page after Send; verify manually')
          : done('refused', refusal('halted', 'halted', 'linkedin block page'));
      // Fresh snapshot after any navigation or click; a result is returned on block or unreadable page.
      const check = async (): Promise<{ snap: RawSnapshot } | { result: TypedResult }> => {
        const s = await takeSnap();
        if (!s) {
          return {
            result: clickIssued
              ? unconfirmed('page unreadable after Send; verify manually')
              : fail('no_snapshot', 'could not read the page'),
          };
        }
        if (rt.afterNavigation(s)) return { result: blockedResult() };
        return { snap: s };
      };

      const first = await check();
      if ('result' in first) return first.result;
      const snap = first.snap;
      if (!verifyProfileUrl(a.profile_url, page.url()).ok) {
        return fail('profile_url_mismatch', 'page is not the requested profile');
      }
      const titleName = extractExpectedNameFromTitle(snap.title);
      if (!namesPlausiblyMatch(person.name ?? '', titleName)) {
        return refuse('recipient_mismatch', 'profile name does not match the seeded recipient');
      }
      const p = snap.profile;
      if (!p) return fail('no_profile', 'profile header not found');
      // 1st-degree requirement: LinkedIn shows Message to some non-connections.
      if (connectionState(p).state !== 'connected') return refuse('not_connected', 'recipient is not a 1st-degree connection');
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
      // Layout precondition: after the injection gates (a drifted injection page still pauses the
      // contact), before the output gate, any click and any ceiling.
      const lay = layoutGate('send_message', deps);
      if (!lay.ok) return refuse(lay.code, lay.reason);
      const og = gateOutbound(
        text,
        outputGateContext({
          person, actualProfileUrl: page.url(), rawPageText: snap.bodyText, cfg, env, factVerdict: g.factVerdict,
        }),
      );
      if (!og.ok) return refuse('output_gate_page', `output gate: ${og.reasons.join(', ')}`);

      if (g.dryRun) {
        return done('dry_run', {
          status: 'dry_run', code: 'dry_run',
          would_send: { kind: a.kind, chars: text.length, recipient: person.profile_key },
        });
      }
      if (haltReason(db, 'linkedin')) return done('refused', refusal('halted', 'halted', 'linkedin halted'));

      // Open the overlay: the Message control nearest the profile's own name.
      const alt = [person.name ?? ''];
      const namePoint = await getProfileNamePoint(page, titleName, alt);
      if (namePoint === null) return fail('name_position_unknown', 'could not locate the profile name on the page');
      const msgBtn = await pickNearestLocator(page, SELECTORS.messageButton, namePoint);
      if ((await msgBtn.count()) === 0) return fail('message_button_not_found', 'Message button not found');
      const aria = await msgBtn.evaluateAll((els) => els.map((el) => String(el.getAttribute('aria-label') ?? '')));
      const label = (aria[0] ?? '').trim();
      if (label) {
        const target = /^Message (.+)$/i.exec(label)?.[1] ?? '';
        if (!target || !namesPlausiblyMatch(person.name ?? '', target)) {
          return fail('message_target_mismatch', 'Message control names a different person');
        }
      }
      await msgBtn.click({ timeout: CLICK_TIMEOUT_MS });
      // Everything is anchored on ONE visible conversation bubble (not the dock, not minimized ones).
      const bubbleAll = page.locator(SELECTORS.conversationBubble);
      await bubbleAll.first().waitFor({ state: 'visible', timeout: stepTimeout }).catch(() => undefined);
      const ov = await check();
      if ('result' in ov) return ov.result;
      if (!verifyProfileUrl(a.profile_url, page.url()).ok) {
        await close();
        return fail('profile_url_mismatch', 'browser left the requested profile');
      }
      const visBubbles = await visibleIndexes(bubbleAll);
      if (visBubbles.length === 0) {
        await close();
        return fail('overlay_not_open', 'message overlay did not open');
      }
      if (visBubbles.length > 1) {
        await close();
        return refuse('overlay_ambiguous', 'more than one conversation overlay is visible');
      }
      const bubble = bubbleAll.nth(visBubbles[0]);
      const headers = bubble.locator(SELECTORS.conversationBubbleHeader);
      const visHdr = await visibleIndexes(headers);
      const header = visHdr.length > 0
        ? ((await headers.nth(visHdr[0]).textContent({ timeout: stepTimeout }).catch(() => null)) ?? '').trim()
        : '';
      if (!header || gateField(header, MAX_FIELD_CHARS.name).blocked) {
        await close();
        return refuse('overlay_name_unverified', 'could not read the message overlay recipient name');
      }
      if (!namesPlausiblyMatch(person.name ?? '', header)) {
        await close();
        return refuse('recipient_mismatch', 'message overlay addresses a different person');
      }
      const composeAll = bubble.locator(SELECTORS.messageComposeTextarea);
      const visCompose = await visibleIndexes(composeAll);
      if (visCompose.length === 0) {
        await close();
        return fail('compose_missing', 'message compose box not found in the verified overlay');
      }
      const compose = composeAll.nth(visCompose[0]);
      const items = bubble.locator(SELECTORS.conversationBubbleMessages);
      const lastMe = async (): Promise<string> => {
        try {
          const rows = await items.evaluateAll((els) => els.map((el) => ({
            me: Boolean(el.classList && el.classList.contains('me')),
            text: String(el.innerText || el.textContent || ''),
          })));
          const m = [...rows].reverse().find((r) => r.me);
          return m ? norm(m.text) : '';
        } catch { return ''; }
      };
      const baseMeText = await lastMe();

      const clearBox = async () => { await compose.fill('', { timeout: stepTimeout }).catch(() => undefined); };
      await compose.fill(text, { timeout: stepTimeout });
      const sendAll = bubble.locator(SELECTORS.messageSendButton);
      const sendVis = await visibleIndexes(sendAll);
      const send = sendAll.nth(sendVis[0] ?? 0);
      if (sendVis.length === 0) {
        await clearBox();
        await close();
        return fail('send_button_missing', 'Send button not found');
      }

      // Consume the ceiling immediately before the click, never earlier.
      const ocfg = loadOutreachConfig(env);
      if (!tryConsume(db, 'linkedin_message', ocfg, now())) {
        await clearBox();
        await close();
        const c = ceilings(db, ocfg, now()).linkedin_message;
        return done('refused', {
          status: 'rate_limited', code: 'rate_limited', reason: `${c.used} of ${c.limit} this week`,
        });
      }

      const net = page
        .waitForResponse((r) => isLikelySendMessageResponse(r), { timeout: netTimeout })
        .then(() => true, () => false);
      clickIssued = true;
      await send.click({ timeout: CLICK_TIMEOUT_MS });

      // Confirmation (D9): compose box cleared AND (echo as last 'me' message OR a 2xx POST).
      const deadline = Date.now() + clearTimeoutMs;
      let state: 'text' | 'cleared' | 'detached' = 'text';
      do {
        state = await compose.textContent({ timeout: Math.max(1, clearPoll) })
          .then((t): 'text' | 'cleared' => ((t ?? '').trim().length > 0 ? 'text' : 'cleared'),
            (): 'detached' => 'detached');
        if (state !== 'text') break;
        await page.waitForTimeout(clearPoll).catch(() => undefined);
      } while (Date.now() < deadline);
      const after = await check();
      if ('result' in after) return after.result;
      if (state === 'text') return unconfirmed('Send clicked but the compose box did not clear; verify manually');
      const sent = norm(text);
      const mineText = await lastMe();
      const echo = mineText !== '' && mineText !== baseMeText &&
        (mineText === sent || (mineText.length >= 40 && sent.startsWith(mineText)));
      // A detached compose node is not proof of a clear: only the echo confirms then.
      if (state === 'detached' ? !echo : (!echo && !(await net))) {
        return unconfirmed('compose cleared but no echo or network confirmation; verify manually');
      }

      finishTouch(db, touchId, 'sent', now());
      try {
        saveConnection(db, {
          job_id: a.job_id ?? null, company: a.company ?? null, profile_url: a.profile_url,
          headline: null, note: text, status: 'messaged', sent_at: now().toISOString(),
        });
      } catch { /* legacy table only; the touch row is authoritative */ }
      return { status: 'sent', code: 'sent', touch_id: touchId };
    });
  } catch {
    // A throw before the click is a failure; after it the send may have gone out (D9).
    return clickIssued
      ? unconfirmed('error after Send click; verify manually')
      : fail('error', 'unexpected error before sending');
  }
}
