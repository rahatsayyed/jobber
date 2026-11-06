import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { enqueueOutreach, saveJob } from '../src/db.js';
import { funnelStats } from '../src/funnel.js';
import { buildManualQueue } from '../src/manual/manualApply.js';
import { ATTACH_MAX_BYTES } from '../src/linkedin/attachment.js';
import { run as manualCli } from '../scripts/apply-manual.js';
import { makeHarness, type Harness } from './helpers/webHarness.js';

let h: Harness | null = null;
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-manual-')); });
afterEach(async () => {
  if (h) await h.close();
  h = null;
  fs.rmSync(root, { recursive: true, force: true });
});

function job(db: BetterSqlite3.Database, id: string): void {
  saveJob(db, { id, source: 'linkedin-jobs', title: `Dev ${id}`, company: `Acme ${id}`, url: `https://www.linkedin.com/jobs/view/${id}/`, apply_url: `https://www.linkedin.com/jobs/view/${id}/`, description: 'x' });
}
function queue(db: BetterSqlite3.Database, id: string, pdf: string | null = null): number {
  return enqueueOutreach(db, {
    job_id: id, resume_pdf_path: pdf, email_subject: null, email_body: null, email_to: null, connect_note: null, connect_profile_url: null,
    connect_category: null, connect_company: null, apply_platform: 'none', apply_url: `https://www.linkedin.com/jobs/view/${id}/`,
  });
}
function pdf(rel: string, body: string | Buffer = '%PDF-1.4 fake'): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
}

const OFFENV: NodeJS.ProcessEnv = { APPLY_LINKEDIN_EASY: 'false' };
async function setup(env: NodeJS.ProcessEnv = OFFENV) {
  h = await makeHarness({
    env,
    manualApply: { write: (fn) => fn(h!.data), resumeName: () => 'Rahat Sayyed', root },
  });
  const { cookie } = await h.login();
  const s = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body) as { csrf: string };
  const origin = `http://127.0.0.1:${h.port}`;
  const post = (p: string, body: unknown, extra: Record<string, string> = {}) =>
    h!.call('POST', p, { headers: { cookie, 'x-csrf-token': s.csrf, origin, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
  const get = (p: string) => h!.call('GET', p, { headers: { cookie } });
  return { cookie, post, get, origin, csrf: s.csrf, env };
}
const j = (r: { body: string }) => JSON.parse(r.body) as Record<string, any>;
const auditRows = (): { kind: string; note: string | null }[] => h!.auth.prepare('SELECT kind, note FROM audit_log ORDER BY id').all() as { kind: string; note: string | null }[];

describe('manual-apply API: auth, CSRF and validation', () => {
  it('refuses unauthenticated reads, downloads and writes', async () => {
    await setup();
    job(h!.data, '1'); const q = queue(h!.data, '1');
    const hdr = { origin: `http://127.0.0.1:${h!.port}`, 'content-type': 'application/json' };
    expect((await h!.call('GET', '/api/manual-apply')).status).toBe(401);
    expect((await h!.call('GET', `/api/manual-apply/${q}/resume`)).status).toBe(401);
    for (const p of ['done', 'skip']) expect((await h!.call('POST', `/api/manual-apply/${p}`, { headers: hdr, body: JSON.stringify({ ids: [q] }) })).status).toBe(401);
    expect(buildManualQueue(h!.data, OFFENV).count).toBe(1);
  });

  it('writes need the CSRF token and a same-origin Origin', async () => {
    const s = await setup();
    job(h!.data, '1'); const q = queue(h!.data, '1');
    const base = { cookie: s.cookie, 'content-type': 'application/json' };
    const body = JSON.stringify({ ids: [q] });
    expect((await h!.call('POST', '/api/manual-apply/done', { headers: { ...base, origin: s.origin }, body })).status).toBe(403);
    expect((await h!.call('POST', '/api/manual-apply/done', { headers: { ...base, 'x-csrf-token': 'wrong', origin: s.origin }, body })).status).toBe(403);
    expect((await h!.call('POST', '/api/manual-apply/skip', { headers: { ...base, 'x-csrf-token': s.csrf, origin: 'http://evil.example' }, body })).status).toBeGreaterThanOrEqual(400);
    expect(buildManualQueue(h!.data, OFFENV).count).toBe(1);
  });

  it('rejects bad bodies and audits the reject without the content', async () => {
    const s = await setup();
    job(h!.data, '1'); const q = queue(h!.data, '1');
    for (const body of [{}, { ids: [] }, { ids: 'x' }, { ids: [0] }, { ids: [-1] }, { ids: [1.5] }, { ids: ['1'] }, { ids: Array.from({ length: 101 }, (_, i) => i + 1) },
      { ids: [q], note: 5 }, { ids: [q], note: 'x'.repeat(501) }]) {
      expect((await s.post('/api/manual-apply/done', body)).status).toBe(400);
      expect((await s.post('/api/manual-apply/skip', body)).status).toBe(400);
    }
    expect((await h!.call('POST', '/api/manual-apply/done', { headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: s.origin, 'content-type': 'text/plain' }, body: 'ids=1' })).status).toBe(415);
    expect(buildManualQueue(h!.data, OFFENV).count).toBe(1);
    expect(auditRows().some((a) => a.kind === 'manual_apply_reject')).toBe(true);
  });

  it('answers a write failure when no writer is configured', async () => {
    h = await makeHarness({ env: OFFENV });
    const { cookie } = await h.login();
    const s = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body) as { csrf: string };
    job(h.data, '1'); const q = queue(h.data, '1');
    const r = await h.call('POST', '/api/manual-apply/done', { headers: { cookie, 'x-csrf-token': s.csrf, origin: `http://127.0.0.1:${h.port}`, 'content-type': 'application/json' }, body: JSON.stringify({ ids: [q] }) });
    expect(r.status).toBe(422);
    expect(j(r).error).toBe('write failed');
    expect(buildManualQueue(h.data, OFFENV).count).toBe(1);
  });
});

describe('manual-apply API: list and counts', () => {
  it('lists items with labels, never a disk path, and the Easy Apply flag', async () => {
    const s = await setup();
    job(h!.data, '1');
    pdf('renderer/automation/j1/resume.pdf');
    const q = queue(h!.data, '1', 'renderer/automation/j1/resume.pdf');
    job(h!.data, '2'); const q2 = queue(h!.data, '2'); // no resume
    const r = j(await s.get('/api/manual-apply'));
    expect(r).toMatchObject({ count: 2, easyApplyOff: 2, easyApplyEnabled: false });
    expect(r.items[0]).toMatchObject({
      id: q, job_id: '1', title: 'Dev 1', company: 'Acme 1', platform: 'linkedin', reason: 'easy_apply_off', reason_label: 'Easy Apply is off',
      open_url: 'https://www.linkedin.com/jobs/view/1/', resume_pdf: 'Rahat-Sayyed-Resume.pdf', resume_download: `/api/manual-apply/${q}/resume`,
    });
    expect(r.items[1]).toMatchObject({ id: q2, resume_pdf: null, resume_download: null });
    expect(JSON.stringify(r)).not.toContain(root);
    expect(JSON.stringify(r)).not.toContain('renderer/automation');
  });

  it('with Easy Apply on the LinkedIn rows belong to the drip lane and are not listed', async () => {
    const s = await setup({ APPLY_LINKEDIN_EASY: 'true' });
    job(h!.data, '1'); queue(h!.data, '1');
    expect(j(await s.get('/api/manual-apply'))).toMatchObject({ count: 0, easyApplyEnabled: true, items: [] });
  });

  it('the Inbox badge includes the manual jobs and agrees with the snapshot and the CLI', async () => {
    const s = await setup();
    job(h!.data, '1'); queue(h!.data, '1');
    job(h!.data, '2'); queue(h!.data, '2');
    const c = j(await s.get('/api/escalations/count'));
    expect(c).toMatchObject({ manualApply: 2, badge: 2 });
    const status = j(await s.get('/api/status'));
    expect(status.manualApply.count).toBe(2);
    const cli = await manualCli(['list'], { db: h!.data, env: s.env, resolve: { root } });
    expect(cli.lines[0]).toBe('2 jobs to apply by hand:');
  });
});

describe('manual-apply API: done and skip parity with the CLI', () => {
  it('done: submitted_by_owner, one applications row, funnel counts it, a note is kept, a repeat fails', async () => {
    const s = await setup();
    job(h!.data, '1'); const q = queue(h!.data, '1');
    const before = funnelStats(h!.data).contacted;
    const r = await s.post('/api/manual-apply/done', { ids: [q, q], note: 'applied on <b>their site</b>' });
    expect(r.status).toBe(200);
    expect(j(r)).toMatchObject({ ok: true, results: [{ id: q, ok: true }], counts: { count: 0 } });
    expect(h!.data.prepare('SELECT apply_status, apply_note FROM outreach_queue WHERE id = ?').get(q)).toEqual({ apply_status: 'submitted_by_owner', apply_note: 'owner: applied on b their site /b' });
    expect(h!.data.prepare("SELECT platform, method, status, reason FROM applications WHERE job_id = '1'").all()).toEqual([{ platform: 'linkedin', method: 'manual', status: 'submitted', reason: 'submitted_by_owner' }]);
    expect(funnelStats(h!.data).contacted).toBe(before + 1);
    const again = await s.post('/api/manual-apply/done', { ids: [q] });
    expect(again.status).toBe(422);
    expect(j(again).results[0].ok).toBe(false);
    expect(h!.data.prepare("SELECT COUNT(*) AS n FROM applications WHERE job_id = '1'").get()).toEqual({ n: 1 });
  });

  it('web and CLI leave identical rows for done and for skip', async () => {
    const s = await setup();
    job(h!.data, '1'); job(h!.data, '2'); job(h!.data, '3'); job(h!.data, '4');
    const [a, b, c, d] = ['1', '2', '3', '4'].map((id) => queue(h!.data, id));
    expect((await s.post('/api/manual-apply/done', { ids: [a] })).status).toBe(200);
    expect((await manualCli(['done', String(b)], { db: h!.data, env: s.env, now: () => h!.now() })).code).toBe(0);
    expect((await s.post('/api/manual-apply/skip', { ids: [c] })).status).toBe(200);
    expect((await manualCli(['skip', String(d)], { db: h!.data, env: s.env })).code).toBe(0);
    const st = (id: number) => h!.data.prepare('SELECT apply_status, apply_note FROM outreach_queue WHERE id = ?').get(id);
    expect(st(a)).toEqual(st(b));
    expect(st(c)).toEqual(st(d));
    const app = (id: string) => h!.data.prepare('SELECT platform, method, account, status, reason FROM applications WHERE job_id = ?').all(id);
    expect(app('1')).toEqual(app('2'));
    expect(app('3')).toEqual([]);
    expect(app('4')).toEqual([]);
    expect(buildManualQueue(h!.data, OFFENV).count).toBe(0);
  });

  it('bulk skip handles every id, reports a stale id and audits ids only', async () => {
    const s = await setup();
    job(h!.data, '1'); job(h!.data, '2');
    const [a, b] = [queue(h!.data, '1'), queue(h!.data, '2')];
    const r = await s.post('/api/manual-apply/skip', { ids: [a, b, 9999], note: 'secret note text' });
    expect(r.status).toBe(200);
    expect(j(r)).toMatchObject({ ok: false, results: [{ id: a, ok: true }, { id: b, ok: true }, { id: 9999, ok: false }] });
    expect(h!.data.prepare("SELECT COUNT(*) AS n FROM applications").get()).toEqual({ n: 0 });
    const rows = auditRows().filter((x) => x.kind === 'manual_apply_skip');
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe(`2 of 3; ids ${a},${b},9999`);
    expect(JSON.stringify(auditRows())).not.toContain('secret note text');
  });
});

describe('manual-apply resume download', () => {
  it('streams the resolver file as an attachment with the generic name', async () => {
    const s = await setup();
    job(h!.data, '1');
    pdf('renderer/automation/j1/resume.pdf', '%PDF-1.4 hello');
    const q = queue(h!.data, '1', 'renderer/automation/j1/resume.pdf');
    const r = await s.get(`/api/manual-apply/${q}/resume`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['content-disposition']).toBe('attachment; filename="Rahat-Sayyed-Resume.pdf"');
    expect(r.headers['content-length']).toBe(String(Buffer.byteLength('%PDF-1.4 hello')));
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.body).toBe('%PDF-1.4 hello');
    expect(auditRows().find((a) => a.kind === 'manual_apply_resume')?.note).toBe(`id ${q}`);
  });

  it('404 for a missing file (no re-render), an unknown id, a row not on the list, and no file at all', async () => {
    const s = await setup();
    job(h!.data, '1'); job(h!.data, '2'); job(h!.data, '3');
    const missing = queue(h!.data, '1', 'renderer/automation/j1/resume.pdf'); // file not on disk, resume.html neither
    const none = queue(h!.data, '2');
    pdf('renderer/automation/j3/resume.pdf');
    const done = queue(h!.data, '3', 'renderer/automation/j3/resume.pdf');
    await s.post('/api/manual-apply/done', { ids: [done] });
    expect((await s.get(`/api/manual-apply/${missing}/resume`)).status).toBe(404);
    expect((await s.get(`/api/manual-apply/${none}/resume`)).status).toBe(404);
    expect((await s.get('/api/manual-apply/99999/resume')).status).toBe(404);
    expect((await s.get(`/api/manual-apply/${done}/resume`)).status).toBe(404);
    expect(j(await s.get('/api/manual-apply')).items.every((i: any) => i.resume_download === null)).toBe(true);
  });

  it('refuses files outside renderer/automation, non-PDF content, oversize files and symlink escapes', async () => {
    const s = await setup();
    job(h!.data, '1'); job(h!.data, '2'); job(h!.data, '3'); job(h!.data, '4');
    pdf('secrets/resume.pdf');
    const outside = queue(h!.data, '1', 'secrets/resume.pdf');
    const dotdot = queue(h!.data, '2', 'renderer/automation/../../secrets/resume.pdf');
    pdf('renderer/automation/j3/resume.pdf', 'not a pdf at all');
    const notPdf = queue(h!.data, '3', 'renderer/automation/j3/resume.pdf');
    pdf('renderer/automation/j4/resume.pdf', Buffer.concat([Buffer.from('%PDF'), Buffer.alloc(ATTACH_MAX_BYTES)]));
    const big = queue(h!.data, '4', 'renderer/automation/j4/resume.pdf');
    for (const id of [outside, dotdot, notPdf, big]) expect((await s.get(`/api/manual-apply/${id}/resume`)).status).toBe(404);

    job(h!.data, '5');
    pdf('secrets/real.pdf');
    fs.mkdirSync(path.join(root, 'renderer/automation/j5'), { recursive: true });
    fs.symlinkSync(path.join(root, 'secrets/real.pdf'), path.join(root, 'renderer/automation/j5/resume.pdf'));
    const link = queue(h!.data, '5', 'renderer/automation/j5/resume.pdf');
    expect((await s.get(`/api/manual-apply/${link}/resume`)).status).toBe(404);
  });

  it('accepts no path or file parameter from the client and rejects a bad id', async () => {
    const s = await setup();
    job(h!.data, '1');
    pdf('secrets/x.pdf', '%PDF-1.4 secret');
    pdf('renderer/automation/j1/resume.pdf', '%PDF-1.4 mine');
    const q = queue(h!.data, '1', 'renderer/automation/j1/resume.pdf');
    for (const p of [`/api/manual-apply/${q}/resume?path=${encodeURIComponent(path.join(root, 'secrets/x.pdf'))}`, `/api/manual-apply/${q}/resume?file=../../secrets/x.pdf`]) {
      const r = await s.get(p);
      expect(r.status).toBe(200);
      expect(r.body).toBe('%PDF-1.4 mine');
    }
    for (const bad of ['abc', '1%2F..%2Fsecrets', '..', '1.5', '12345678901234']) expect((await s.get(`/api/manual-apply/${bad}/resume`)).status).toBeGreaterThanOrEqual(400);
    expect((await s.get('/api/manual-apply/%2e%2e/resume')).status).toBeGreaterThanOrEqual(400);
  });
});
