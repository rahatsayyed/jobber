// browserctl intent: the armed intent that lets one commit-class action through. Held in process
// memory, one per platform, 120 s expiry, single use. The arm tools (task 3) create it after the code
// gates have passed; the commit path checks it right before the click.
import { randomUUID } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { textMatches, type CommitClass } from './guard.js';
import { finishTouch } from '../linkedin/touches.js';

export const INTENT_TTL_MS = 120_000;
export type IntentPlatform = 'linkedin' | 'naukri' | 'wellfound';

export interface ArmedIntent {
  id: string;
  platform: IntentPlatform;
  /** Touch kind: connect_note, role_ask, rapport, referral_ask, followup, feedback, accept, apply ... */
  kind: string;
  class: CommitClass;
  profileKey?: string;
  threadRef?: string;
  jobId?: number | string;
  /** Naukri or Wellfound apply: the job key (`naukri:<n>`, `wellfound:<n>`) the live page URL must carry. */
  pageKey?: string;
  /** Exact outbound text (null for accept and apply; a Wellfound apply may carry its armed note). */
  text: string | null;
  personId?: number;
  touchId?: number;
  company?: string;
  /** Armed in a dry run: the commit path records instead of clicking. */
  dry?: boolean;
  /**
   * LinkedIn: set by the engine's own Connect click that opened the invite dialog (never by the model): the profile key
   * of the page it was clicked on and the person name its top card showed just before the click. It stands in for the
   * recipient name that the live invite dialog does not show. Cleared by any navigation of the engine.
   */
  inviteOpened?: { profileKey: string; name: string };
  expiresAt: number;
}
export type IntentInput = Omit<ArmedIntent, 'id' | 'expiresAt'>;

export type IntentCheck =
  | { ok: true; intent: ArmedIntent }
  | { ok: false; code: 'no_armed_intent' | 'intent_expired' | 'intent_class_mismatch' | 'intent_text_mismatch' | 'intent_used' };

export class IntentStore {
  private armed = new Map<IntentPlatform, ArmedIntent>();
  private used = new Set<string>();
  private releaser: ((touchId: number, at: Date) => void) | null = null;

  constructor(private now: () => number = () => Date.now(), private ttlMs: number = INTENT_TTL_MS) {}

  /**
   * Bind the callback that moves a reserved touch row out of 'sending' (to 'failed') when its intent
   * expires, is replaced or is disarmed WITHOUT a commit, so a retry can reserve again. The arm and
   * commit entry points bind it (the db is at hand there). A consumed intent is never released here.
   */
  bindReleaser(fn: (touchId: number, at: Date) => void): void { this.releaser = fn; }

  private release(it: ArmedIntent): void {
    if (it.touchId === undefined || it.dry || !this.releaser) return;
    try { this.releaser(it.touchId, new Date(this.now())); } catch { /* never block the caller */ }
  }

  /** Drop expired intents and release their touches (lazy: runs on arm, peek, check and consume). */
  sweep(): void {
    for (const [pl, it] of [...this.armed]) {
      if (this.now() >= it.expiresAt) { this.armed.delete(pl); this.release(it); }
    }
  }

  /** Arm an intent; it replaces any earlier one for the platform (one at a time). */
  arm(input: IntentInput): ArmedIntent {
    this.sweep();
    const prev = this.armed.get(input.platform);
    if (prev && prev.touchId !== input.touchId) this.release(prev);
    const intent: ArmedIntent = { ...input, id: randomUUID(), expiresAt: this.now() + this.ttlMs };
    this.armed.set(input.platform, intent);
    return intent;
  }

  /** The armed intent, or null (an expired one is dropped). */
  peek(platform: IntentPlatform): ArmedIntent | null {
    this.sweep();
    return this.armed.get(platform) ?? null;
  }

  /**
   * May this commit-class action proceed? `cls` is the class the guard returned; `liveText` is the text
   * read from the live composer (omit for accept and apply). Does not consume the intent.
   */
  check(platform: IntentPlatform, cls: CommitClass, liveText?: string | null): IntentCheck {
    const it = this.armed.get(platform);
    if (!it) return { ok: false, code: 'no_armed_intent' };
    if (this.now() >= it.expiresAt) { this.armed.delete(platform); this.release(it); return { ok: false, code: 'intent_expired' }; }
    if (this.used.has(it.id)) return { ok: false, code: 'intent_used' };
    if (it.class !== cls) return { ok: false, code: 'intent_class_mismatch' };
    if (it.text !== null && (liveText === undefined || liveText === null || !textMatches(it.text, liveText))) {
      return { ok: false, code: 'intent_text_mismatch' };
    }
    return { ok: true, intent: it };
  }

  /** Use the intent up (call right before the click). A second consume of the same id fails. */
  consume(platform: IntentPlatform, id: string): IntentCheck {
    if (this.used.has(id)) return { ok: false, code: 'intent_used' };
    const it = this.armed.get(platform);
    if (!it || it.id !== id) return { ok: false, code: 'no_armed_intent' };
    if (this.now() >= it.expiresAt) { this.armed.delete(platform); this.release(it); return { ok: false, code: 'intent_expired' }; }
    this.used.add(id);
    this.armed.delete(platform);
    return { ok: true, intent: it };
  }

  /** Record what the engine saw when its own Connect click opened the invite dialog (see ArmedIntent.inviteOpened). */
  markInviteOpened(platform: IntentPlatform, facts: { profileKey: string; name: string }): void {
    const it = this.armed.get(platform);
    if (it) it.inviteOpened = facts;
  }

  /** Forget the opened-dialog facts (the engine navigated, so the dialog is no longer the one it opened). */
  clearInviteOpened(platform: IntentPlatform): void {
    const it = this.armed.get(platform);
    if (it) delete it.inviteOpened;
  }

  /** Drop the armed intent without using it (dry run, dialog closed, refusal). */
  disarm(platform: IntentPlatform): void {
    const it = this.armed.get(platform);
    this.armed.delete(platform);
    if (it) this.release(it);
  }
}

// Bind the release of a never-committed intent to the db: its reserved touch row goes sending -> failed.
export function bindTouchRelease(intents: IntentStore, db: BetterSqlite3.Database): void {
  intents.bindReleaser((touchId, at) => finishTouch(db, touchId, 'failed', at));
}
