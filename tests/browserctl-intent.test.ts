import { describe, it, expect } from 'vitest';
import { IntentStore, INTENT_TTL_MS, type IntentInput } from '../src/browserctl/intent.js';

const base: IntentInput = {
  platform: 'linkedin', kind: 'connect_note', class: 'commit_connect_send',
  profileKey: 'jane-example', text: 'Hi Jane, I saw the role.', personId: 7, touchId: 3,
};

function store() {
  let t = 1_000_000;
  const s = new IntentStore(() => t);
  return { s, advance: (ms: number) => { t += ms; } };
}

describe('IntentStore', () => {
  it('refuses with no armed intent', () => {
    const { s } = store();
    expect(s.check('linkedin', 'commit_connect_send', 'x')).toEqual({ ok: false, code: 'no_armed_intent' });
    expect(s.peek('linkedin')).toBeNull();
  });

  it('passes with matching class and exact text', () => {
    const { s } = store();
    const it = s.arm(base);
    expect(it.expiresAt - 1_000_000).toBe(INTENT_TTL_MS);
    expect(INTENT_TTL_MS).toBe(120_000);
    const r = s.check('linkedin', 'commit_connect_send', 'Hi Jane, I saw the role.');
    expect(r.ok && r.intent.id).toBe(it.id);
  });

  it('refuses a wrong class', () => {
    const { s } = store();
    s.arm(base);
    expect(s.check('linkedin', 'commit_message_send', base.text)).toEqual({ ok: false, code: 'intent_class_mismatch' });
    expect(s.check('linkedin', 'commit_accept_invite', null)).toEqual({ ok: false, code: 'intent_class_mismatch' });
  });

  it('refuses wrong or missing text', () => {
    const { s } = store();
    s.arm(base);
    expect(s.check('linkedin', 'commit_connect_send', 'Hi Jane, I saw the role!')).toEqual({ ok: false, code: 'intent_text_mismatch' });
    expect(s.check('linkedin', 'commit_connect_send')).toEqual({ ok: false, code: 'intent_text_mismatch' });
    expect(s.check('linkedin', 'commit_connect_send', null)).toEqual({ ok: false, code: 'intent_text_mismatch' });
  });

  it('text-less intents (accept, apply) need no text', () => {
    const { s } = store();
    s.arm({ platform: 'naukri', kind: 'apply', class: 'naukri_apply', jobId: 12, text: null });
    expect(s.check('naukri', 'naukri_apply').ok).toBe(true);
  });

  it('expires after 120 s', () => {
    const { s, advance } = store();
    s.arm(base);
    advance(119_999);
    expect(s.check('linkedin', 'commit_connect_send', base.text).ok).toBe(true);
    advance(1);
    expect(s.check('linkedin', 'commit_connect_send', base.text)).toEqual({ ok: false, code: 'intent_expired' });
    expect(s.peek('linkedin')).toBeNull();
  });

  it('is single use', () => {
    const { s } = store();
    const it = s.arm(base);
    expect(s.consume('linkedin', it.id).ok).toBe(true);
    expect(s.consume('linkedin', it.id)).toEqual({ ok: false, code: 'intent_used' });
    expect(s.check('linkedin', 'commit_connect_send', base.text)).toEqual({ ok: false, code: 'no_armed_intent' });
  });

  it('consume refuses a stale id and an expired intent', () => {
    const { s, advance } = store();
    const a = s.arm(base);
    const b = s.arm({ ...base, text: 'Second' });
    expect(s.consume('linkedin', a.id)).toEqual({ ok: false, code: 'no_armed_intent' });
    advance(INTENT_TTL_MS);
    expect(s.consume('linkedin', b.id)).toEqual({ ok: false, code: 'intent_expired' });
  });

  it('holds one intent per platform and arming replaces the earlier one', () => {
    const { s } = store();
    const a = s.arm(base);
    const n = s.arm({ platform: 'naukri', kind: 'role_ask', class: 'naukri_send', threadRef: 'abc123', text: 'Hello' });
    expect(s.peek('linkedin')?.id).toBe(a.id);
    expect(s.peek('naukri')?.id).toBe(n.id);
    const a2 = s.arm({ ...base, text: 'Newer' });
    expect(s.peek('linkedin')?.id).toBe(a2.id);
    expect(s.check('linkedin', 'commit_connect_send', base.text)).toEqual({ ok: false, code: 'intent_text_mismatch' });
  });

  it('disarm drops the intent', () => {
    const { s } = store();
    s.arm(base);
    s.disarm('linkedin');
    expect(s.peek('linkedin')).toBeNull();
  });
});
