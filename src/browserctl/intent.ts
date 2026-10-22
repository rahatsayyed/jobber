// browserctl intent: the armed intent that lets one commit-class action through. Held in process
// memory, one per platform, 120 s expiry, single use. The arm tools (task 3) create it after the code
// gates have passed; the commit path checks it right before the click.
import { randomUUID } from 'node:crypto';
import { textMatches, type CommitClass } from './guard.js';

export const INTENT_TTL_MS = 120_000;
export type IntentPlatform = 'linkedin' | 'naukri';

export interface ArmedIntent {
  id: string;
  platform: IntentPlatform;
  /** Touch kind: connect_note, role_ask, rapport, referral_ask, followup, feedback, accept, apply ... */
  kind: string;
  class: CommitClass;
  profileKey?: string;
  threadRef?: string;
  jobId?: number | string;
  /** Exact outbound text (null for accept and apply). */
  text: string | null;
  personId?: number;
  touchId?: number;
  company?: string;
  /** Armed in a dry run: the commit path records instead of clicking. */
  dry?: boolean;
  expiresAt: number;
}
export type IntentInput = Omit<ArmedIntent, 'id' | 'expiresAt'>;

export type IntentCheck =
  | { ok: true; intent: ArmedIntent }
  | { ok: false; code: 'no_armed_intent' | 'intent_expired' | 'intent_class_mismatch' | 'intent_text_mismatch' | 'intent_used' };

export class IntentStore {
  private armed = new Map<IntentPlatform, ArmedIntent>();
  private used = new Set<string>();

  constructor(private now: () => number = () => Date.now(), private ttlMs: number = INTENT_TTL_MS) {}

  /** Arm an intent; it replaces any earlier one for the platform (one at a time). */
  arm(input: IntentInput): ArmedIntent {
    const intent: ArmedIntent = { ...input, id: randomUUID(), expiresAt: this.now() + this.ttlMs };
    this.armed.set(input.platform, intent);
    return intent;
  }

  /** The armed intent, or null (an expired one is dropped). */
  peek(platform: IntentPlatform): ArmedIntent | null {
    const it = this.armed.get(platform);
    if (!it) return null;
    if (this.now() >= it.expiresAt) { this.armed.delete(platform); return null; }
    return it;
  }

  /**
   * May this commit-class action proceed? `cls` is the class the guard returned; `liveText` is the text
   * read from the live composer (omit for accept and apply). Does not consume the intent.
   */
  check(platform: IntentPlatform, cls: CommitClass, liveText?: string | null): IntentCheck {
    const it = this.armed.get(platform);
    if (!it) return { ok: false, code: 'no_armed_intent' };
    if (this.now() >= it.expiresAt) { this.armed.delete(platform); return { ok: false, code: 'intent_expired' }; }
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
    if (this.now() >= it.expiresAt) { this.armed.delete(platform); return { ok: false, code: 'intent_expired' }; }
    this.used.add(id);
    this.armed.delete(platform);
    return { ok: true, intent: it };
  }

  /** Drop the armed intent without using it (dry run, dialog closed, refusal). */
  disarm(platform: IntentPlatform): void { this.armed.delete(platform); }
}
