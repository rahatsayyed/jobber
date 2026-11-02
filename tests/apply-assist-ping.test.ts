import { afterEach, describe, expect, it } from 'vitest';
import { handleEscalate } from '../src/applier/escalate.js';
import { handleOpen } from '../src/applier/tools/open.js';
import { ASSIST_PING_GAP_MS, pingAssist, type AssistNotifier } from '../src/applier/assistPing.js';
import { openDb } from '../src/db.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { listEscalations } from '../src/outreach/escalations.js';
import { makeApplier, type ApplierHarness } from './helpers/applierHarness.js';

let h: ApplierHarness | null = null;
afterEach(async () => { await h?.close(); h = null; });

function sender(o: { photo?: boolean; fail?: boolean } = {}) {
  const sent: string[] = [];
  const photos: string[] = [];
  const n: AssistNotifier = {
    send: async (t) => { sent.push(t); return { ok: !o.fail, detail: 'x' }; },
    ...(o.photo ? { sendPhoto: async (_p: Buffer, c: string) => { photos.push(c); return { ok: true, detail: 'x' }; } } : {}),
  };
  return { n, sent, photos };
}

const seed = () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO jobs (id, source, title, company, apply_url) VALUES ('j1','x','Backend Engineer','Acme','https://careers.acme.example.com/a')").run();
  return db;
};
const NOW = new Date('2026-11-02T10:00:00Z');

describe('needs_human Telegram ping', () => {
  it('sends host, job, and the exact command once per host per 6 hours', async () => {
    const db = seed(); const s = sender();
    const p = { host: 'careers.acme.example.com', jobId: 'j1', reason: 'captcha', notifier: s.n, now: NOW, env: {} };
    expect(await pingAssist(db, p)).toBe('sent');
    expect(s.sent[0]).toContain('careers.acme.example.com');
    expect(s.sent[0]).toContain('Backend Engineer at Acme');
    expect(s.sent[0]).toContain('npm run apply:assist -- j1');
    expect(await pingAssist(db, { ...p, now: new Date(NOW.getTime() + ASSIST_PING_GAP_MS - 1000) })).toBe('deduped');
    expect(await pingAssist(db, { ...p, host: 'other.example.org' })).toBe('sent');
    expect(await pingAssist(db, { ...p, now: new Date(NOW.getTime() + ASSIST_PING_GAP_MS + 1000) })).toBe('sent');
    expect(s.sent).toHaveLength(3);
  });

  it('sends nothing in a dry run and does not use the dedupe slot', async () => {
    const db = seed(); const s = sender();
    const p = { host: 'careers.acme.example.com', jobId: 'j1', reason: 'mfa', notifier: s.n, now: NOW };
    expect(await pingAssist(db, { ...p, env: { JOBBER_DRY_RUN: '1' } })).toBe('dry_run');
    expect(s.sent).toHaveLength(0);
    expect(await pingAssist(db, { ...p, env: {} })).toBe('sent');
  });

  it('a failed send is retried next time; the screenshot is taken only when the sender can attach it, and its failure never blocks the text', async () => {
    const db = seed();
    const bad = sender({ fail: true });
    const p = { host: 'careers.acme.example.com', jobId: 'j1', reason: 'captcha', now: NOW, env: {} };
    expect(await pingAssist(db, { ...p, notifier: bad.n })).toBe('send_failed');
    let shots = 0;
    const text = sender();
    expect(await pingAssist(db, { ...p, notifier: text.n, screenshot: async () => { shots += 1; return Buffer.from('png'); } })).toBe('sent');
    expect(shots).toBe(0); // the shipped sender is text only: no screenshot is even taken
    const db2 = seed();
    const photo = sender({ photo: true });
    expect(await pingAssist(db2, { ...p, notifier: photo.n, screenshot: async () => { throw new Error('page gone'); } })).toBe('sent');
    expect(photo.sent).toHaveLength(1);
    expect(photo.photos).toHaveLength(0);
    const db3 = seed(); const ok = sender({ photo: true });
    expect(await pingAssist(db3, { ...p, notifier: ok.n, screenshot: async () => Buffer.from('png') })).toBe('sent');
    expect(ok.photos).toHaveLength(1);
    expect(ok.photos[0]).toContain('npm run apply:assist -- j1');
  });
});

describe('apply_escalate parks needs_human', () => {
  it('two jobs on one host raise ONE escalation card and ONE ping; the park happens even if Telegram fails', async () => {
    h = makeApplier({});
    h.db.prepare("INSERT INTO jobs (id, source, title, company, apply_url) VALUES ('job-2','x','Other role','Acme','https://boards.greenhouse.io/acme/jobs/2')").run();
    h.db.prepare("INSERT INTO outreach_queue (job_id, apply_platform, apply_url) VALUES ('job-2','greenhouse','https://boards.greenhouse.io/acme/jobs/2')").run();
    const s = sender();
    const x = { notify: () => undefined, styleCfg: DEFAULT_STYLE_CONFIG, runId: 'r1', telegram: s.n };
    await handleOpen({ job_id: 'job-1' }, h.deps);
    expect(await handleEscalate({ job_id: 'job-1', reason: 'captcha' }, h.deps, x)).toMatchObject({ status: 'needs_human', code: 'escalated' });
    expect(await handleEscalate({ job_id: 'job-2', reason: 'login_failed' }, h.deps, x)).toMatchObject({ status: 'needs_human' });
    const q = (id: string) => (h!.db.prepare('SELECT apply_status FROM outreach_queue WHERE job_id = ?').get(id) as { apply_status: string }).apply_status;
    expect([q('job-1'), q('job-2')]).toEqual(['needs_human', 'needs_human']);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toContain('npm run apply:assist -- job-1');
    const { items } = listEscalations(h.db, { now: new Date() });
    expect(items).toHaveLength(1);
    expect(items[0].label).toContain('log in');
    expect(items[0].assistCommand).toMatch(/^npm run apply:assist -- job-\d$/);
    // Telegram down: the park still happens
    h.db.prepare("INSERT INTO jobs (id, source, title, company, apply_url) VALUES ('job-3','x','Third','Acme','https://other.example.org/j')").run();
    h.db.prepare("INSERT INTO outreach_queue (job_id, apply_platform, apply_url) VALUES ('job-3','browser','https://other.example.org/j')").run();
    const down = sender({ fail: true });
    expect(await handleEscalate({ job_id: 'job-3', reason: 'mfa' }, h.deps, { ...x, telegram: down.n })).toMatchObject({ status: 'needs_human' });
    expect(q('job-3')).toBe('needs_human');
  });

  it('a dry run parks the job but sends no ping', async () => {
    h = makeApplier({ env: { JOBBER_DRY_RUN: '1' } });
    const s = sender();
    await handleEscalate({ job_id: 'job-1', reason: 'captcha' }, h.deps, { notify: () => undefined, styleCfg: DEFAULT_STYLE_CONFIG, runId: 'r', telegram: s.n });
    expect(s.sent).toHaveLength(0);
    expect((h.db.prepare('SELECT apply_status FROM outreach_queue WHERE job_id = ?').get('job-1') as { apply_status: string }).apply_status).toBe('needs_human');
  });
});
