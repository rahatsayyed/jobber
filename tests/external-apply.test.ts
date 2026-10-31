import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueOutreach, openDb, saveJob, setExternalApply, getExternalApplyUrl, externalApplyDuplicate } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { NAUKRI_POLICY } from '../src/browserctl/policy.js';
import {
  createExternalState, pickExternalControl, resolveExternalApply, resolveHrefTarget, trimExternalUrl, type ExternalDeps,
} from '../src/browserctl/externalApply.js';
import { classifyApplyUrl } from '../src/apply/registry.js';
import type { RawNode, RawTree } from '../src/browserctl/snapshot.js';

const PAGE = 'https://www.naukri.com/job-listings-full-stack-developer-acme-pune-2-to-5-years-130226502853';
const JOB = 'naukri:130226502853';
const node = (o: Partial<RawNode>): RawNode => ({ n: 1, role: 'button', name: '', text: '', disabled: false, ...o });
const tree = (nodes: RawNode[], url = PAGE): RawTree => ({ url, title: 't', nodes });

function setup(opts: { nodes?: RawNode[]; popups?: string[]; env?: NodeJS.ProcessEnv; pageUrl?: string; clicks?: string[] } = {}) {
  const db = openDb(':memory:');
  saveJob(db, { id: JOB, source: 'naukri', title: 'Full Stack Developer', company: 'Acme', url: PAGE, apply_url: PAGE, description: 'd', posted_at: null } as any);
  enqueueOutreach(db, { job_id: JOB, resume_pdf_path: '/x.pdf', email_subject: null, email_body: null, email_to: null, connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: 'naukri', apply_tier: 'agent', apply_url: PAGE, resume_json: '{}' } as any);
  db.prepare("UPDATE outreach_queue SET apply_status = 'manual_review'").run();
  const nodes = opts.nodes ?? [node({ n: 5, name: 'Apply on company site' })];
  const clicks = opts.clicks ?? [];
  let closed = 0;
  const page = {
    url: () => opts.pageUrl ?? PAGE,
    waitMs: async () => undefined,
    clickNode: async (n: number) => { clicks.push(`c${n}`); },
    diag: async () => null,
    watch: () => ({ popups: () => (opts.popups ?? []).map((url) => ({ url })), responses: () => [], adopt: async () => false, closePopups: async () => { closed++; }, stop: () => undefined }),
  };
  const t = tree(nodes, opts.pageUrl ?? PAGE);
  const engine = { page: async () => page, peek: async () => ({ ok: true, code: 'ok' }), lastTree: () => t, refs: { epoch: 1 } };
  const env = { ...(opts.env ?? {}) } as NodeJS.ProcessEnv;
  const deps: ExternalDeps = {
    engine: engine as never, db, now: () => new Date('2026-10-30T10:00:00Z'), env, cfg: loadOutreachConfig(env), policy: NAUKRI_POLICY,
    screen: async (text) => ({ blocked: false, unscreened: false, text, flags: [], code: 'ok' }) as never,
    state: createExternalState(), stopFile: join(mkdtempSync(join(tmpdir(), 'ext-')), 'STOP'), diagDir: mkdtempSync(join(tmpdir(), 'diag-')),
    sleep: async () => undefined, random: () => 0, popupWaitMs: 2000, popupPollMs: 500,
  };
  return { db, deps, clicks, closed: () => closed };
}
const row = (db: ReturnType<typeof openDb>) => db.prepare('SELECT apply_platform p, apply_tier t, apply_url u, apply_status s, apply_note n FROM outreach_queue').get() as any;

describe('pure helpers', () => {
  it('finds the Naukri control and ignores a native Apply', () => {
    expect(pickExternalControl('naukri', tree([node({ name: 'Apply on company site' })]))?.name).toBe('Apply on company site');
    expect(pickExternalControl('naukri', tree([node({ name: 'Apply' })]))).toBeNull();
    expect(pickExternalControl('wellfound', tree([node({ name: 'Apply externally' })]))).not.toBeNull();
  });
  it('LinkedIn: externalApply link wins, Easy Apply page has none', () => {
    const l = node({ role: 'link', name: 'Apply', href: '/jobs/view/externalApply/123?url=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F1' });
    expect(pickExternalControl('linkedin', tree([l]))).toBe(l);
    expect(pickExternalControl('linkedin', tree([node({ name: 'Easy Apply' }), node({ name: 'Apply' })]))).toBeNull();
    expect(pickExternalControl('linkedin', tree([node({ name: 'Apply' })]))?.name).toBe('Apply');
  });
  it('decodes an embedded target and passes a direct external href', () => {
    const pg = 'https://www.linkedin.com/jobs/view/123/';
    expect(resolveHrefTarget('linkedin', '/jobs/view/externalApply/123?url=https%3A%2F%2Fjobs.lever.co%2Facme%2Fabc', pg)).toBe('https://jobs.lever.co/acme/abc');
    expect(resolveHrefTarget('linkedin', 'https://jobs.lever.co/acme/abc', pg)).toBe('https://jobs.lever.co/acme/abc');
    expect(resolveHrefTarget('linkedin', '/jobs/view/123/apply', pg)).toBeNull();
    expect(resolveHrefTarget('linkedin', undefined, pg)).toBeNull();
    expect(resolveHrefTarget('linkedin', 'javascript:void(0)', pg)).toBeNull();
  });
  it('trims a long tracking url to job id params', () => {
    const long = `https://boards.greenhouse.io/acme/jobs/1?gh_jid=77&utm=${'x'.repeat(600)}`;
    expect(trimExternalUrl(long)).toBe('https://boards.greenhouse.io/acme/jobs/1?gh_jid=77');
  });
});

describe('resolveExternalApply (Naukri popup path)', () => {
  it('routes an ATS popup to the generic applier, closes the popup, returns no url', async () => {
    const s = setup({ popups: ['https://boards.greenhouse.io/acme/jobs/9'] });
    const r = await resolveExternalApply(s.deps, 'naukri', { job_id: JOB });
    expect(r).toMatchObject({ status: 'resolved', platform: 'greenhouse', tier: 'fast' });
    expect(JSON.stringify(r)).not.toContain('greenhouse.io');
    expect(s.clicks).toEqual(['c5']);
    expect(s.closed()).toBe(1);
    expect(row(s.db)).toMatchObject({ p: 'greenhouse', t: 'fast', u: 'https://boards.greenhouse.io/acme/jobs/9', s: null });
    expect(getExternalApplyUrl(s.db, JOB)).toBe('https://boards.greenhouse.io/acme/jobs/9');
    expect(s.db.prepare("SELECT COUNT(*) n FROM rate_events WHERE key='external_resolve'").get()).toEqual({ n: 1 });
  });
  it('unknown host stays manual_review with a visible note unless unknown hosts are allowed', async () => {
    const s = setup({ popups: ['https://careers.acme-corp.example/jobs/9'] });
    const r = await resolveExternalApply(s.deps, 'naukri', { job_id: JOB });
    expect(r).toMatchObject({ status: 'manual_review', code: 'host_unknown' });
    expect(row(s.db)).toMatchObject({ p: 'naukri', s: 'manual_review', n: 'external:host_unknown' });
    const s2 = setup({ popups: ['https://careers.acme-corp.example/jobs/9'], env: { APPLY_ALLOW_UNKNOWN_HOSTS: 'true' } });
    expect(await resolveExternalApply(s2.deps, 'naukri', { job_id: JOB })).toMatchObject({ status: 'resolved', platform: 'browser' });
  });
  it('a popup that stays about:blank or on the platform is manual_review', async () => {
    expect((await resolveExternalApply(setup({ popups: ['about:blank'] }).deps, 'naukri', { job_id: JOB })).code).toBe('no_popup'.replace('no_popup', 'still_on_platform'));
    expect((await resolveExternalApply(setup({ popups: [] }).deps, 'naukri', { job_id: JOB })).code).toBe('no_popup');
  });
  it('a look-alike host is refused as none', async () => {
    const r = await resolveExternalApply(setup({ popups: ['https://evil-greenhouse.io/x/jobs/1'] }).deps, 'naukri', { job_id: JOB });
    expect(r).toMatchObject({ status: 'manual_review' });
  });
  it('refuses on Applied text, expired text, wrong page, no control, duplicate', async () => {
    const ap = setup({ nodes: [node({ role: 'text', text: 'Applied' }), node({ n: 5, name: 'Apply on company site' })], popups: ['https://boards.greenhouse.io/a/jobs/1'] });
    expect((await resolveExternalApply(ap.deps, 'naukri', { job_id: JOB })).code).toBe('applied_on_platform');
    const ex = setup({ nodes: [node({ role: 'text', text: 'expired' }), node({ n: 5, name: 'Apply on company site' })] });
    expect((await resolveExternalApply(ex.deps, 'naukri', { job_id: JOB })).code).toBe('job_expired');
    const wp = setup({ pageUrl: 'https://www.naukri.com/job-listings-other-role-999999999999' });
    expect((await resolveExternalApply(wp.deps, 'naukri', { job_id: JOB })).code).toBe('job_url_mismatch');
    const nc = setup({ nodes: [node({ name: 'Save' })] });
    expect((await resolveExternalApply(nc.deps, 'naukri', { job_id: JOB })).code).toBe('no_external_control');
    const du = setup({ popups: ['https://boards.greenhouse.io/a/jobs/1'] });
    du.db.prepare("INSERT INTO applications (job_id, platform, method, status) VALUES (?, 'naukri', 'browser', 'submitted')").run(JOB);
    expect((await resolveExternalApply(du.deps, 'naukri', { job_id: JOB })).code).toBe('already_applied');
    expect(du.clicks).toEqual([]);
  });
  it('same company and title submitted elsewhere in 90 days is a duplicate', () => {
    const s = setup();
    saveJob(s.db, { id: 'gh:1', source: 'greenhouse', title: 'Full Stack Developer', company: 'Acme', url: 'https://x.example/1', apply_url: 'https://boards.greenhouse.io/acme/jobs/1', description: 'd', posted_at: null } as any);
    s.db.prepare("INSERT INTO applications (job_id, platform, method, status, applied_at) VALUES ('gh:1', 'greenhouse', 'browser', 'submitted', datetime('now'))").run();
    expect(externalApplyDuplicate(s.db, JOB)).toBe('duplicate_application');
  });
  it('dry run, kill switch, ceiling and session cap stop before any click', async () => {
    const d = setup({ popups: ['https://boards.greenhouse.io/a/jobs/1'], env: { JOBBER_DRY_RUN: '1' } });
    expect((await resolveExternalApply(d.deps, 'naukri', { job_id: JOB })).status).toBe('dry_run');
    expect(d.clicks).toEqual([]);
    const k = setup({ popups: ['https://boards.greenhouse.io/a/jobs/1'], env: { JOBBER_KILL: '1' } });
    expect((await resolveExternalApply(k.deps, 'naukri', { job_id: JOB })).status).toBe('halted');
    const c = setup({ popups: ['https://boards.greenhouse.io/a/jobs/1'], env: { APPLY_MAX_EXTERNAL_RESOLVES_PER_DAY: '0' } });
    expect((await resolveExternalApply(c.deps, 'naukri', { job_id: JOB })).code).toBe('rate_limited');
    const sc = setup({ popups: ['https://boards.greenhouse.io/a/jobs/1'] });
    sc.deps.state.resolves = 5;
    expect((await resolveExternalApply(sc.deps, 'naukri', { job_id: JOB })).code).toBe('session_cap');
    expect(sc.clicks).toEqual([]);
  });
  it('a control href resolves with no click', async () => {
    const s = setup({ nodes: [node({ n: 5, role: 'link', name: 'Apply on company site', href: 'https://jobs.ashbyhq.com/acme/1' })] });
    expect(await resolveExternalApply(s.deps, 'naukri', { job_id: JOB })).toMatchObject({ status: 'resolved', platform: 'ashby' });
    expect(s.clicks).toEqual([]);
  });
});

describe('storage and routing', () => {
  it('setExternalApply routes to the generic platform and apply_open class stays code-decided', () => {
    const s = setup();
    const cls = classifyApplyUrl('https://jobs.lever.co/acme/1', 'naukri', {});
    expect(setExternalApply(s.db, JOB, 'https://jobs.lever.co/acme/1', cls)).toBe(1);
    expect(row(s.db)).toMatchObject({ p: 'lever', u: 'https://jobs.lever.co/acme/1', s: null });
    expect(classifyApplyUrl('https://www.linkedin.com/jobs/view/1/', 'linkedin-jobs', {})).toMatchObject({ platform: 'linkedin', reason: 'external_resolve' });
    expect(classifyApplyUrl('https://www.linkedin.com/jobs/view/1/', 'remotive', {}).platform).toBe('none');
  });
  it('submitted rows are left alone', () => {
    const s = setup();
    s.db.prepare("UPDATE outreach_queue SET apply_status = 'submitted'").run();
    expect(setExternalApply(s.db, JOB, 'https://jobs.lever.co/acme/1', { platform: 'lever', tier: 'fast' })).toBe(0);
  });
});
