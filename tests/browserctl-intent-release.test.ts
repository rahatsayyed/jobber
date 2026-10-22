import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { reserveTouch } from '../src/linkedin/touches.js';
import { IntentStore, INTENT_TTL_MS, bindTouchRelease, type IntentInput } from '../src/browserctl/intent.js';

const base: IntentInput = {
  platform: 'linkedin', kind: 'connect_note', class: 'commit_connect_send',
  profileKey: 'jane-example', text: 'Hi Jane, I saw the role.', personId: 1,
};

function world() {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO people (id, platform, profile_key, name, company, company_key, category) VALUES (1,'linkedin','jane-example','Jane','Acme','acme','recruiter')").run();
  let t = 1_000_000;
  const s = new IntentStore(() => t);
  bindTouchRelease(s, db);
  const status = (id: number) => (db.prepare('SELECT status FROM touches WHERE id = ?').get(id) as { status: string }).status;
  const reserve = (key = 'li:connect:jane-example:x') => reserveTouch(db, { personId: 1, kind: 'connect', body: 'hi', key, now: new Date(t), dryRun: false });
  const reserved = (key?: string) => (reserve(key) as { touchId: number }).touchId;
  const armWith = (touchId: number | undefined, extra: Partial<IntentInput> = {}) => s.arm({ ...base, touchId, ...extra });
  return { db, s, status, reserve, reserved, armWith, advance: (ms: number) => { t += ms; } };
}

describe('IntentStore releases the reserved touch', () => {
  it('expiry without a commit moves sending to failed (lazily, on peek) so a retry can reserve', () => {
    const w = world();
    const id = w.reserved();
    w.armWith(id);
    expect(w.status(id)).toBe('sending');
    expect(w.reserve()).toMatchObject({ ok: false, reason: 'in_progress' });
    w.advance(INTENT_TTL_MS + 1);
    expect(w.s.peek('linkedin')).toBeNull();
    expect(w.status(id)).toBe('failed');
    expect(w.reserve()).toMatchObject({ ok: true, touchId: id });
  });

  it('expiry is also released by check, consume, sweep and the next arm', () => {
    for (const how of ['check', 'consume', 'sweep', 'arm'] as const) {
      const w = world();
      const id = w.reserved();
      const it = w.armWith(id);
      w.advance(INTENT_TTL_MS + 1);
      if (how === 'check') expect(w.s.check('linkedin', 'commit_connect_send', base.text)).toEqual({ ok: false, code: 'intent_expired' });
      if (how === 'consume') expect(w.s.consume('linkedin', it.id)).toEqual({ ok: false, code: 'intent_expired' });
      if (how === 'sweep') w.s.sweep();
      if (how === 'arm') w.armWith(undefined);
      expect(w.status(id), how).toBe('failed');
    }
  });

  it('disarm without a commit releases; a consumed intent is left to the commit path', () => {
    const w = world();
    const id = w.reserved();
    w.armWith(id);
    w.s.disarm('linkedin');
    expect(w.status(id)).toBe('failed');

    const id2 = w.reserved();
    const it = w.armWith(id2);
    expect(w.s.consume('linkedin', it.id).ok).toBe(true);
    w.s.disarm('linkedin');
    w.advance(INTENT_TTL_MS + 1);
    w.s.sweep();
    expect(w.status(id2)).toBe('sending');
  });

  it('replacing an armed intent releases the old touch; re-arming the same touch keeps it', () => {
    const w = world();
    const id = w.reserved();
    w.armWith(id);
    w.armWith(id);
    expect(w.status(id)).toBe('sending');
    w.armWith(undefined);
    expect(w.status(id)).toBe('failed');
  });

  it('never moves a sent row back, and a dry intent releases nothing', () => {
    const w = world();
    const id = w.reserved();
    w.db.prepare("UPDATE touches SET status = 'sent' WHERE id = ?").run(id);
    w.armWith(id);
    w.s.disarm('linkedin');
    expect(w.status(id)).toBe('sent');

    const w2 = world();
    const id2 = w2.reserved();
    w2.armWith(id2, { dry: true });
    w2.s.disarm('linkedin');
    expect(w2.status(id2)).toBe('sending');
  });
});
