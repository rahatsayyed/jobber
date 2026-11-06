import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb, saveJob, enqueueOutreach } from '../src/db.js';
import { funnelStats } from '../src/funnel.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { isLinkedInEasyApplyCandidate } from '../src/apply/easyApplyRows.js';
import { buildManualQueue, manualApplyLine, markDone, markSkip } from '../src/manual/manualApply.js';
import { buildSnapshot } from '../src/status/snapshot.js';
import { renderWorking } from '../src/status/render.js';
import { renderEscalations } from '../src/status/escalations.js';
import { run as manualCli } from '../scripts/apply-manual.js';

const OFF: NodeJS.ProcessEnv = { APPLY_LINKEDIN_EASY: 'false' };
const ON: NodeJS.ProcessEnv = { APPLY_LINKEDIN_EASY: 'true' };
const NOW = new Date('2026-11-02T10:00:00.000Z');

let db: BetterSqlite3.Database;
beforeEach(() => { db = openDb(':memory:'); });
afterEach(() => { db.close(); });

function job(id: string, o: { source?: string; url?: string; apply_url?: string; company?: string } = {}): void {
  saveJob(db, {
    id, source: o.source ?? 'linkedin-jobs', title: `Dev ${id}`, company: o.company ?? `Acme ${id}`,
    url: o.url ?? `https://www.linkedin.com/jobs/view/${id}/`, apply_url: o.apply_url ?? `https://www.linkedin.com/jobs/view/${id}/`, description: 'x',
  });
}
function queue(id: string, o: { status?: string | null; platform?: string; url?: string | null; note?: string; pdf?: string } = {}): number {
  const qid = enqueueOutreach(db, {
    job_id: id, resume_pdf_path: o.pdf ?? null, email_subject: null, email_body: null, email_to: null, connect_note: null, connect_profile_url: null,
    connect_category: null, connect_company: null, apply_platform: o.platform ?? 'none', apply_url: o.url === undefined ? `https://www.linkedin.com/jobs/view/${id}/` : o.url,
  });
  if (o.status !== undefined || o.note) db.prepare('UPDATE outreach_queue SET apply_status = ?, apply_note = ? WHERE id = ?').run(o.status ?? null, o.note ?? null, qid);
  return qid;
}

describe('manual apply queue building', () => {
  it('lists LinkedIn Easy Apply rows when the flag is off and hands them to the drip lane when on', () => {
    job('1001');
    const q = queue('1001');
    const off = buildManualQueue(db, OFF);
    expect(off.count).toBe(1);
    expect(off.easyApplyOff).toBe(1);
    expect(off.items[0]).toMatchObject({ id: q, job_id: '1001', platform: 'linkedin', reason: 'easy_apply_off', open_url: 'https://www.linkedin.com/jobs/view/1001/' });
    expect(buildManualQueue(db, ON).count).toBe(0);
    // flipping back loses nothing
    expect(buildManualQueue(db, OFF).count).toBe(1);
    const row = { apply_url: 'https://www.linkedin.com/jobs/view/1001/', source: 'linkedin-jobs', apply_status: null };
    expect(isLinkedInEasyApplyCandidate(row, OFF)).toBe(true);
    expect(isLinkedInEasyApplyCandidate(row, ON)).toBe(true);
    expect(isLinkedInEasyApplyCandidate({ ...row, external_apply_url: 'https://boards.greenhouse.io/x/jobs/1' }, ON)).toBe(false);
    expect(isLinkedInEasyApplyCandidate({ ...row, apply_status: 'submitted' }, ON)).toBe(false);
    expect(isLinkedInEasyApplyCandidate({ ...row, excluded_reason: 'veto' }, ON)).toBe(false);
  });

  it('a LinkedIn row whose company-site link was resolved is not an Easy Apply entry', () => {
    job('1002');
    queue('1002');
    db.prepare("UPDATE jobs SET external_apply_url = 'https://boards.greenhouse.io/acme/jobs/9' WHERE id = '1002'").run();
    expect(buildManualQueue(db, OFF).count).toBe(0);
  });

  it('lists needs_owner and manual_review rows with a usable address, never needs_answer or needs_human', () => {
    job('2001', { source: 'remotive', url: 'https://remotive.com/job/2001', apply_url: 'https://boards.greenhouse.io/acme/jobs/2001' });
    job('2002', { source: 'remotive', url: 'https://remotive.com/job/2002', apply_url: 'https://jobs.lever.co/acme/2002' });
    job('2003', { source: 'remotive', url: 'https://remotive.com/job/2003', apply_url: 'https://jobs.ashbyhq.com/acme/2003' });
    job('2004', { source: 'remotive', url: 'https://remotive.com/job/2004', apply_url: 'https://acme.example.com/careers/2004' });
    queue('2001', { status: 'needs_owner', platform: 'greenhouse', url: 'https://boards.greenhouse.io/acme/jobs/2001' });
    queue('2002', { status: 'needs_answer', platform: 'lever', url: 'https://jobs.lever.co/acme/2002' });
    queue('2003', { status: 'needs_human', platform: 'ashby', url: 'https://jobs.ashbyhq.com/acme/2003' });
    queue('2004', { status: 'manual_review', platform: 'none', note: 'external:host_unknown', url: 'https://acme.example.com/careers/2004' });
    const v = buildManualQueue(db, ON);
    expect(v.items.map((i) => [i.job_id, i.reason]).sort()).toEqual([['2001', 'company_site_form'], ['2004', 'company_site_form']]);
  });

  it('drops non-https and look-alike hosts', () => {
    job('3001', { source: 'remotive', url: 'https://remotive.com/job/3001', apply_url: 'http://acme.example.com/a' });
    job('3002', { source: 'remotive', url: 'https://remotive.com/job/3002', apply_url: 'https://evil-greenhouse.io/x' });
    job('3003', { source: 'remotive', url: 'https://remotive.com/job/3003', apply_url: 'https://jobs.lever.co/acme/3003' });
    queue('3001', { status: 'needs_owner', url: 'http://acme.example.com/a' });
    queue('3002', { status: 'needs_owner', url: 'https://evil-greenhouse.io/x' });
    queue('3003', { status: 'needs_owner', url: 'https://jobs.lever.co/acme/3003' });
    db.prepare("UPDATE jobs SET url = 'http://acme.example.com/a', apply_url = 'http://acme.example.com/a' WHERE id = '3001'").run();
    db.prepare("UPDATE jobs SET url = 'https://evil-greenhouse.io/x', apply_url = 'https://evil-greenhouse.io/x' WHERE id = '3002'").run();
    expect(buildManualQueue(db, ON).items.map((i) => i.job_id)).toEqual(['3003']);
  });

  it('one entry per job, vetoed and applied jobs hidden', () => {
    job('4001'); job('4002'); job('4003');
    queue('4001'); queue('4002'); queue('4003');
    db.prepare("UPDATE jobs SET excluded_reason = 'veto' WHERE id = '4002'").run();
    db.prepare("INSERT INTO applications (job_id, platform, status) VALUES ('4003', 'linkedin', 'submitted')").run();
    expect(buildManualQueue(db, OFF).items.map((i) => i.job_id)).toEqual(['4001']);
  });
});

describe('done and skip', () => {
  it('done marks every row, counts in the funnel and leaves the list', () => {
    job('5001');
    const q = queue('5001');
    const before = funnelStats(db).contacted;
    expect(markDone(db, 999, OFF)).toMatchObject({ ok: false });
    expect(markDone(db, q, OFF, NOW)).toMatchObject({ ok: true, job_id: '5001' });
    expect(db.prepare('SELECT apply_status FROM outreach_queue WHERE id = ?').get(q)).toEqual({ apply_status: 'submitted_by_owner' });
    expect(db.prepare("SELECT platform, method, status FROM applications WHERE job_id = '5001'").all()).toEqual([{ platform: 'linkedin', method: 'manual', status: 'submitted' }]);
    expect(funnelStats(db).contacted).toBe(before + 1);
    expect(buildManualQueue(db, OFF).count).toBe(0);
    expect(markDone(db, q, OFF)).toMatchObject({ ok: false });
  });

  it('skip removes the row for good, also when the flag flips', () => {
    job('5002');
    const q = queue('5002');
    expect(markSkip(db, q, OFF)).toMatchObject({ ok: true });
    expect(buildManualQueue(db, OFF).count).toBe(0);
    expect(buildManualQueue(db, ON).count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM applications WHERE job_id = '5002'").get()).toEqual({ n: 0 });
  });
});

describe('surfaces', () => {
  it('snapshot, working, escalations and the line', () => {
    job('6001');
    queue('6001');
    const snap = buildSnapshot(db, loadOutreachConfig({}), NOW, OFF);
    expect(snap.manualApply.count).toBe(1);
    expect(snap.manualApply.items[0].reason).toBe('easy_apply_off');
    expect(buildSnapshot(db, loadOutreachConfig({}), NOW, ON).manualApply.count).toBe(0);
    const line = '1 job waits for you to apply by hand (Easy Apply is off): npm run apply:manual -- list';
    expect(manualApplyLine(snap.manualApply)).toBe(line);
    expect(manualApplyLine({ count: 3, easyApplyOff: 0 })).toBe('3 jobs wait for you to apply by hand: npm run apply:manual -- list');
    expect(manualApplyLine({ count: 0 })).toBeNull();
    expect(renderWorking(snap)).toContain(line);
    expect(renderEscalations([], { open: 0, snoozed: 0 } as never, NOW, [line])).toContain(line);
  });
});

describe('apply:manual CLI', () => {
  let root: string;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-apply-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it('lists with open url and resume, then done, and rejects bad usage', async () => {
    job('7001');
    const dir = path.join(root, 'renderer', 'automation', 'j7001');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'resume.pdf'), '%PDF-1.4 fake');
    const q = queue('7001', { pdf: 'renderer/automation/j7001/resume.pdf' });
    const resolve = { root, resumeName: () => 'Test Person' };
    const l = await manualCli(['list'], { db, env: OFF, resolve });
    expect(l.code).toBe(0);
    const text = l.lines.join('\n');
    expect(text).toContain(`#${q} Dev 7001`);
    expect(text).toContain('open: https://www.linkedin.com/jobs/view/7001/');
    expect(text).toContain(path.join(dir, 'resume.pdf'));
    expect((await manualCli(['done', String(q)], { db, env: OFF, now: () => NOW })).code).toBe(0);
    expect((await manualCli(['list'], { db, env: OFF, resolve })).lines[0]).toMatch(/Nothing waits/);
    expect((await manualCli(['done', 'abc'], { db, env: OFF })).code).toBe(2);
    expect((await manualCli(['done', '12345'], { db, env: OFF })).code).toBe(1);
    expect((await manualCli([], { db, env: OFF })).code).toBe(2);
  });
});
