// Typed accept_invite. Irreversible: restricted to known senders, row-scoped click, counter consumed
// right before the click, and any exit after the click without confirmation is 'unconfirmed'.
import { saveConnection } from '../db.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
import { haltReason } from '../outreach/limits.js';
import { SELECTORS } from './selectors.js';
import { gateField, MAX_FIELD_CHARS } from './state.js';
import { personByProfileKey } from './touches.js';
import { refusal, type ToolDeps, type TypedResult } from './toolDeps.js';
import { SNAPSHOT_SRC } from './snapshot.js';
import { effectiveDryRun } from './config.js';
import { isLinkedInUrl, isProfileUrl, isBlockedPath, profileKeyOf, classifyUrl } from './urls.js';
import { extractProfileSlug, namesPlausiblyMatch } from './verify.js';
import type { LiLocator, RawInvitation, RawSnapshot } from './types.js';

export const INVITATIONS_URL = 'https://www.linkedin.com/mynetwork/invitation-manager/';
// UNVERIFIED LIVE: one invitation row (an li with a profile link and an Accept control).
export const INVITATION_ROW = 'li:has(a[href*="/in/"]):has(button[aria-label^="Accept" i])';
const CLICK_TIMEOUT_MS = 2000;

export interface AcceptInviteOptions { confirmTimeoutMs?: number; confirmPollMs?: number }
export interface UnknownSender { name: string; headline: string; path: string }
export type AcceptResult = TypedResult & {
  unknown_senders?: UnknownSender[];
  input_flags?: string[];
  injection_suspected?: boolean;
  db_write_failed?: boolean;
};
const EMPTY_STATE_RE = /\bno (pending |new )?invitations\b/i;

const BLOCKED = '[blocked: injection suspected]';

export async function acceptInvite(
  a: { profile_url: string; dry_run?: boolean },
  deps: ToolDeps,
  opts: AcceptInviteOptions = {},
): Promise<AcceptResult> {
  const { rt, db, now, cfg } = deps;
  const confirmTimeout = opts.confirmTimeoutMs ?? 8000;
  const confirmPoll = opts.confirmPollMs ?? 1000;

  const halt = haltReason(db, 'linkedin');
  if (halt !== null) return refusal('halted', 'halted', 'linkedin halted');
  const url = a.profile_url;
  if (typeof url !== 'string' || !isLinkedInUrl(url) || !isProfileUrl(url) || isBlockedPath(url).blocked) {
    return refusal('refused', 'bad_url', 'not a LinkedIn profile URL');
  }
  const slug = extractProfileSlug(url);
  if (!slug) return refusal('refused', 'bad_url', 'profile slug not found');
  const person = personByProfileKey(db, profileKeyOf(url));
  const dryRun = effectiveDryRun(cfg, a.dry_run);
  let clickIssued = false;

  try {
    const opened = await rt.open(INVITATIONS_URL);
    if (!opened.ok) {
      if (opened.code === 'halted') return refusal('halted', 'halted', 'linkedin halted');
      return refusal('failed', opened.code, opened.reason);
    }

    return await rt.serial(async (): Promise<AcceptResult> => {
      const page = rt.page();
      if (!page) return refusal('failed', 'no_session', 'browser session is not open');
      // open() released the queue before this block: never trust its snapshot, take a fresh one.
      const takeSnap = () => page.evaluate<RawSnapshot>(SNAPSHOT_SRC).then((s) => s ?? null, () => null);
      const snap = await takeSnap();
      if (!snap) return refusal('failed', 'no_snapshot', 'could not read the page');
      if (rt.afterNavigation(snap)) return refusal('halted', 'halted', 'linkedin block page');
      if (classifyUrl(page.url()) !== 'invitations') {
        return refusal('failed', 'wrong_page', 'browser is not on the invitation manager');
      }

      // Row resolution: exact slug on the DOM rows, never name-only.
      const rows = page.locator(INVITATION_ROW);
      const rowCount = await rows.count();
      // All distinct /in/ slugs in the row: exactly one is required (a mutual-connection link or a
      // nested row makes attribution ambiguous).
      const slugsOfRow = async (r: LiLocator): Promise<string[]> => {
        const hrefs = await r.locator(SELECTORS.profileLink).evaluateAll((els) =>
          els.map((e) => String(e.getAttribute('href') ?? '')));
        return [...new Set(hrefs.map((h) => extractProfileSlug(h)).filter(Boolean))];
      };
      const matches: number[] = [];
      let multi = false;
      for (let i = 0; i < rowCount; i++) {
        const ss = await slugsOfRow(rows.nth(i));
        if (!ss.includes(slug)) continue;
        if (ss.length > 1) multi = true;
        matches.push(i);
      }
      const snapMatches = snap.invitations.filter((v) => extractProfileSlug(v.href) === slug);
      if (multi || matches.length > 1 || snapMatches.length > 1) {
        return refusal('refused', 'invitation_ambiguous', 'more than one invitation matches this profile');
      }
      if (matches.length === 0) return refusal('failed', 'invitation_not_found', 'no invitation from this profile');
      const rowIndex = matches[0];
      const inv: RawInvitation | undefined = snapMatches[0];

      // Unknown sender (not in people) and acceptUnknown off: list the sender for the owner, no click.
      if (!person && !cfg.acceptUnknown) {
        const flags = new Set<string>();
        let injection = false;
        const gated = (s: string, max: number): string => {
          const g = gateField(s, max);
          for (const f of g.flags) flags.add(f);
          if (g.blocked) { injection = true; return BLOCKED; }
          return g.text;
        };
        const sender: UnknownSender = {
          name: gated(inv?.name ?? '', MAX_FIELD_CHARS.name),
          headline: gated(inv?.headline ?? '', MAX_FIELD_CHARS.headline),
          path: `/in/${slug}`,
        };
        return {
          ...refusal('refused', 'unknown_recipient', 'sender is not in people'),
          unknown_senders: [sender],
          input_flags: [...flags].sort(),
          injection_suspected: injection,
        };
      }
      if (person) {
        const rowName = inv?.name ?? '';
        if (!rowName.trim()) return refusal('failed', 'row_name_unreadable', 'could not read the invitation sender name');
        if (person.name && !namesPlausiblyMatch(person.name, rowName)) {
          return refusal('refused', 'recipient_mismatch', 'invitation sender name does not match the known person');
        }
      }
      // Injection gate over the sender fields, also for known senders and acceptUnknown.
      for (const [s, max] of [
        [inv?.name ?? '', MAX_FIELD_CHARS.name], [inv?.headline ?? '', MAX_FIELD_CHARS.headline],
      ] as const) {
        if (s && gateField(s, max).blocked) {
          return refusal('refused', 'injection_suspected', 'invitation text looks like an injection attempt');
        }
      }

      if (dryRun) {
        return {
          status: 'dry_run', code: 'dry_run',
          would_send: { kind: 'accept', chars: 0, recipient: profileKeyOf(url) },
        };
      }
      if (haltReason(db, 'linkedin')) return refusal('halted', 'halted', 'linkedin halted');

      // Accept control: first visible one INSIDE the matched row only.
      const row = rows.nth(rowIndex);
      const accepts = row.locator(SELECTORS.invitationAcceptButton);
      if ((await accepts.count()) === 0) {
        return refusal('failed', 'accept_control_missing', 'no Accept control in the invitation row');
      }
      const vis = await accepts.evaluateAll((els) =>
        els.map((e) => Number(e.offsetWidth) > 0 && Number(e.offsetHeight) > 0));
      const vi = vis.findIndex(Boolean);
      if (vi === -1) return refusal('failed', 'accept_control_missing', 'no visible Accept control in the invitation row');
      // The row must still be the same sender right before the click.
      const again = await slugsOfRow(row);
      if (again.length !== 1 || again[0] !== slug) {
        return refusal('failed', 'invitation_not_found', 'invitation list changed before the click');
      }

      if (!checkAndIncrement(db, 'linkedin_accept', cfg.maxAcceptsPerDay)) {
        return { status: 'rate_limited', code: 'rate_limited', reason: 'daily accept limit reached' };
      }
      clickIssued = true;
      try {
        await accepts.nth(vi).click({ timeout: CLICK_TIMEOUT_MS });

        // Confirm by fresh snapshot: row gone (on the invitation page) or an accepted/connected notice.
        const nameLow = (inv?.name ?? '').trim().toLowerCase();
        const deadline = Date.now() + confirmTimeout;
        let confirmed = false;
        let blocked = false;
        do {
          const s = await takeSnap();
          if (s) {
            if (rt.afterNavigation(s)) { blocked = true; break; }
            const gone = classifyUrl(s.url) === 'invitations' &&
              !s.invitations.some((v) => extractProfileSlug(v.href) === slug);
            const noticed = s.notices.some((n) => {
              const low = n.toLowerCase();
              return /\b(accepted|connected)\b/i.test(n) && (low.includes(slug) || (nameLow !== '' && low.includes(nameLow)));
            });
            // Documented heuristic: an explicit empty-state text, or another invitation still listed.
            const listOk = s.invitations.length > 0 || EMPTY_STATE_RE.test(s.bodyText);
            if (noticed || (gone && listOk)) { confirmed = true; break; }
          }
          await page.waitForTimeout(confirmPoll).catch(() => undefined);
        } while (Date.now() < deadline);

        if (blocked) {
          return { status: 'unconfirmed', code: 'unconfirmed', reason: 'block page after Accept click; linkedin halted' };
        }
        if (!confirmed) {
          return { status: 'unconfirmed', code: 'unconfirmed', reason: 'Accept clicked but not confirmed; verify manually' };
        }
        let dbFailed = false;
        try {
          saveConnection(db, {
            job_id: null, company: person?.company ?? null, profile_url: url,
            headline: null, note: '', status: 'accepted', sent_at: now().toISOString(),
          } as unknown as Parameters<typeof saveConnection>[1]);
        } catch { dbFailed = true; }
        if (person) {
          try {
            db.prepare("UPDATE contact_state SET stage='active' WHERE person_id=? AND stage='new'").run(person.id);
          } catch { dbFailed = true; }
        }
        return { status: 'sent', code: 'accepted', ...(dbFailed ? { db_write_failed: true } : {}) };
      } catch {
        // click or confirmation threw: a block page must still halt the platform.
        const s = await takeSnap();
        if (s) rt.afterNavigation(s);
        return { status: 'unconfirmed', code: 'unconfirmed', reason: 'error after Accept click; verify manually' };
      }
    });
  } catch {
    return clickIssued
      ? { status: 'unconfirmed', code: 'unconfirmed', reason: 'error after Accept click; verify manually' }
      : refusal('failed', 'error', 'unexpected error before accepting');
  }
}
