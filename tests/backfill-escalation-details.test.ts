import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.js';
import { backfillEscalationDetails, BACKFILL_MAX_THREADS, BACKFILL_PAUSE_MS, extractThreadDetails } from '../scripts/backfill-escalation-details.js';
import type { ScreenVerdict } from '../src/safety/screen.js';

const clean = async (): Promise<ScreenVerdict> => ({ blocked: false, unscreened: false, text: '', flags: [], code: 'ok' });
const NOW = '2026-10-27T10:00:00.000Z';

function seed(n: number) {
  const db = openDb(':memory:');
  const ins = db.prepare("INSERT INTO escalations (platform, thread_ref, reason, detail, created_at) VALUES ('linkedin', ?, 'linkedin_reply_needed', ?, ?)");
  for (let i = 0; i < n; i++) ins.run(`2-t${i}_1`, 'Recruiter inquiry', NOW);
  return db;
}
const snap = (name: string | null, msgs: Array<['them' | 'me', string]>) => ({ messageHeaderName: name, messages: msgs.map(([from, text]) => ({ from, text })) });

describe('extractThreadDetails', () => {
  it('takes the header name and the latest message from them, ignoring my own replies', () => {
    const d = extractThreadDetails(snap('Sam Lee', [['them', 'first'], ['me', 'thanks'], ['them', 'Open to a $40/hr contract role?'], ['me', 'tell me more']]));
    expect(d).toEqual({ sender: 'Sam Lee', excerpt: 'Open to a $40/hr contract role?' });
  });
  it('returns nulls when the page shows nothing, and cleans control characters and length', () => {
    expect(extractThreadDetails(snap(null, []))).toEqual({ sender: null, excerpt: null });
    const d = extractThreadDetails(snap('A\u0007B', [['them', 'z'.repeat(4000)]]));
    expect(d.sender).toBe('AB');
    expect((d.excerpt ?? '').length).toBeLessThanOrEqual(1500);
  });
});

describe('backfillEscalationDetails', () => {
  const deps = (db: ReturnType<typeof seed>, over: Record<string, unknown> = {}) => ({
    db, screen: clean, stopped: () => false, sleep: vi.fn(async () => undefined), random: () => 0.5,
    open: vi.fn(async () => ({ ok: true as const, snapshot: snap('Sam Lee', [['them', 'Hi, we are hiring a smart contract role']]) })),
    ...over,
  });

  it('fills sender, excerpt, thread url and ask kind on every open row of a thread, with a pause between threads', async () => {
    const db = seed(2);
    const d = deps(db);
    const r = await backfillEscalationDetails(d);
    expect(r).toMatchObject({ candidates: 2, read: 2, updated: 2, flagged: 0, stopped: null });
    expect(d.open).toHaveBeenCalledWith('https://www.linkedin.com/messaging/thread/2-t0_1/');
    expect(d.sleep).toHaveBeenCalledTimes(1);
    const ms = (d.sleep.mock.calls[0] as unknown as number[])[0];
    expect(ms).toBeGreaterThanOrEqual(BACKFILL_PAUSE_MS[0]);
    expect(ms).toBeLessThanOrEqual(BACKFILL_PAUSE_MS[1]);
    expect(db.prepare('SELECT sender_name, message_excerpt, ask_kind, thread_url FROM escalations WHERE id = 1').get()).toEqual({
      sender_name: 'Sam Lee', message_excerpt: 'Hi, we are hiring a smart contract role', ask_kind: 'recruiter_inquiry', thread_url: 'https://www.linkedin.com/messaging/thread/2-t0_1/',
    });
    // idempotent: nothing left to do
    expect((await backfillEscalationDetails(deps(db))).candidates).toBe(0);
  });

  it('keeps blocked text only in raw_text', async () => {
    const db = seed(1);
    const r = await backfillEscalationDetails(deps(db, { screen: async () => ({ blocked: true, unscreened: false, text: '', flags: [], code: 'injection_suspected' }) }));
    expect(r).toMatchObject({ flagged: 1, updated: 1 });
    expect(db.prepare('SELECT message_excerpt, raw_text FROM escalations').get()).toEqual({ message_excerpt: null, raw_text: 'Hi, we are hiring a smart contract role' });
  });

  it('reads at most 15 threads, and --dry only counts', async () => {
    const db = seed(20);
    const d = deps(db);
    expect((await backfillEscalationDetails(d)).read).toBe(BACKFILL_MAX_THREADS);
    expect(d.open).toHaveBeenCalledTimes(BACKFILL_MAX_THREADS);
    const dry = seed(3);
    const dd = deps(dry, { dry: true });
    expect(await backfillEscalationDetails(dd)).toMatchObject({ candidates: 3, read: 0 });
    expect(dd.open).not.toHaveBeenCalled();
  });

  it('stops on a kill switch or halt, and on any open failure', async () => {
    const killed = deps(seed(3), { stopped: () => true });
    expect((await backfillEscalationDetails(killed)).stopped).toBe('killed_or_halted');
    expect(killed.open).not.toHaveBeenCalled();
    const db = seed(3);
    const failing = deps(db, { open: vi.fn(async () => ({ ok: false as const, code: 'halted' })) });
    expect(await backfillEscalationDetails(failing)).toMatchObject({ read: 0, stopped: 'halted' });
    expect(failing.open).toHaveBeenCalledTimes(1);
  });

  it('counts a thread with no readable message as unreadable and leaves the row alone', async () => {
    const db = seed(1);
    const r = await backfillEscalationDetails(deps(db, { open: async () => ({ ok: true as const, snapshot: snap(null, []) }) }));
    expect(r).toMatchObject({ unreadable: 1, updated: 0 });
    expect(db.prepare('SELECT message_excerpt FROM escalations').get()).toEqual({ message_excerpt: null });
  });
});
