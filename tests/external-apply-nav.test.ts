import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueOutreach, openDb, saveJob } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { NAUKRI_POLICY } from '../src/browserctl/policy.js';
import { createExternalState, resolveExternalApply, type ExternalDeps } from '../src/browserctl/externalApply.js';
import type { RawNode, RawTree } from '../src/browserctl/snapshot.js';
import { buildManualQueue, manualReasonLabel } from '../src/manual/manualApply.js';
import { run as requeue } from '../scripts/apply-requeue-company-site.js';

const PAGE = 'https://www.naukri.com/job-listings-full-stack-developer-acme-pune-2-to-5-years-130226502853';
const INTERSTITIAL = 'https://www.naukri.com/myapply/showAcp';
const JOB = 'naukri:130226502853';
const node = (o: Partial<RawNode>): RawNode => ({ n: 1, role: 'button', name: '', text: '', disabled: false, ...o });
const tree = (nodes: RawNode[], url: string): RawTree => ({ url, title: 't', nodes });

// clickUrls: the URL the tab shows after the 1st, 2nd... click. interstitialNodes: what the interstitial page shows.
function setup(opts: { clickUrls?: string[]; interstitialNodes?: RawNode[]; popups?: string[]; env?: NodeJS.ProcessEnv } = {}) {
  const db = openDb(':memory:');
  saveJob(db, { id: JOB, source: 'naukri', title: 'Full Stack Developer', company: 'Acme', url: PAGE, apply_url: PAGE, description: 'd', posted_at: null } as any);
  enqueueOutreach(db, { job_id: JOB, resume_pdf_path: '/x.pdf', email_subject: null, email_body: null, email_to: null, connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: 'naukri', apply_tier: 'agent', apply_url: PAGE, resume_json: '{}' } as any);
  let url = PAGE;
  let clicks = 0;
  const gotos: string[] = [];
  let current = tree([node({ n: 5, name: 'Apply on company site' })], PAGE);
  const page = {
    url: () => url,
    waitMs: async () => undefined,
    clickNode: async () => { const u = opts.clickUrls?.[clicks]; clicks++; if (u) url = u; },
    goto: async (u: string) => { gotos.push(u); url = u; },
    diag: async () => null,
    watch: () => ({ popups: () => (opts.popups ?? []).map((u) => ({ url: u })), responses: () => [], adopt: async () => false, closePopups: async () => undefined, stop: () => undefined }),
  };
  const engine = {
    page: async () => page,
    peek: async () => { if (url === INTERSTITIAL) current = tree(opts.interstitialNodes ?? [], INTERSTITIAL); return { ok: true, code: 'ok' }; },
    lastTree: () => current,
    refs: { epoch: 1 },
  };
  const env = { ...(opts.env ?? {}) } as NodeJS.ProcessEnv;
  const deps: ExternalDeps = {
    engine: engine as never, db, now: () => new Date('2026-10-30T10:00:00Z'), env, cfg: loadOutreachConfig(env), policy: NAUKRI_POLICY,
    screen: async (text) => ({ blocked: false, unscreened: false, text, flags: [], code: 'ok' }) as never,
    state: createExternalState(), stopFile: join(mkdtempSync(join(tmpdir(), 'ext-')), 'STOP'), diagDir: mkdtempSync(join(tmpdir(), 'diag-')),
    sleep: async () => undefined, random: () => 0, popupWaitMs: 2000, popupPollMs: 500,
  };
  return { db, deps, gotos, getUrl: () => url, clicks: () => clicks };
}
const row = (db: ReturnType<typeof openDb>) => db.prepare('SELECT apply_platform p, apply_url u, apply_status s, apply_note n FROM outreach_queue').get() as any;

describe('resolveExternalApply: same-tab navigation', () => {
  it('interstitial with a company link: reads the link from the Naukri page, goes back to the job page', async () => {
    const s = setup({ clickUrls: [INTERSTITIAL], interstitialNodes: [node({ n: 2, role: 'link', name: 'Continue to company website', href: 'https://boards.greenhouse.io/acme/jobs/9' })] });
    const r = await resolveExternalApply(s.deps, 'naukri', { job_id: JOB });
    expect(r).toMatchObject({ status: 'resolved', platform: 'greenhouse' });
    expect(JSON.stringify(r)).not.toContain('greenhouse.io');
    expect(row(s.db)).toMatchObject({ p: 'greenhouse', u: 'https://boards.greenhouse.io/acme/jobs/9', s: null, n: null });
    expect(s.gotos).toEqual([PAGE]);
    expect(s.getUrl()).toBe(PAGE);
  });

  it('interstitial with a control but no href: one more code click leads to the company page', async () => {
    const s = setup({ clickUrls: [INTERSTITIAL, 'https://jobs.lever.co/acme/abc'], interstitialNodes: [node({ n: 3, name: 'Apply on company website' })] });
    const r = await resolveExternalApply(s.deps, 'naukri', { job_id: JOB });
    expect(r).toMatchObject({ status: 'resolved', platform: 'lever' });
    expect(s.clicks()).toBe(2);
    expect(s.gotos).toEqual([PAGE]);
  });

  it('interstitial without any company link: manual_review interstitial_no_link, note written, page restored', async () => {
    const s = setup({ clickUrls: [INTERSTITIAL], interstitialNodes: [node({ n: 2, role: 'link', name: 'Home', href: '/' })] });
    const r = await resolveExternalApply(s.deps, 'naukri', { job_id: JOB });
    expect(r).toMatchObject({ status: 'manual_review', code: 'interstitial_no_link' });
    expect(row(s.db)).toMatchObject({ s: 'manual_review', n: 'external:interstitial_no_link' });
    expect(s.gotos).toEqual([PAGE]);
  });

  it('same tab goes straight to a company host: takes the URL, then returns to the job page', async () => {
    const s = setup({ clickUrls: ['https://jobs.ashbyhq.com/acme/1'] });
    const r = await resolveExternalApply(s.deps, 'naukri', { job_id: JOB });
    expect(r).toMatchObject({ status: 'resolved', platform: 'ashby' });
    expect(row(s.db)).toMatchObject({ u: 'https://jobs.ashbyhq.com/acme/1', s: null });
    expect(s.gotos).toEqual([PAGE]);
  });

  it('popup path is unchanged and needs no goto', async () => {
    const s = setup({ popups: ['https://boards.greenhouse.io/acme/jobs/9'] });
    expect(await resolveExternalApply(s.deps, 'naukri', { job_id: JOB })).toMatchObject({ status: 'resolved', platform: 'greenhouse' });
    expect(s.gotos).toEqual([]);
  });

  it('a click that goes nowhere records no_popup with the note', async () => {
    const s = setup();
    expect(await resolveExternalApply(s.deps, 'naukri', { job_id: JOB })).toMatchObject({ status: 'manual_review', code: 'no_popup' });
    expect(row(s.db)).toMatchObject({ s: 'manual_review', n: 'external:no_popup' });
    expect(s.gotos).toEqual([]);
  });
});

describe('manual_review codes always leave a note', () => {
  it('no_external_control, host_unknown, invalid_url and still_on_platform', async () => {
    const nc = setup();
    nc.deps.engine.lastTree = () => tree([node({ name: 'Save' })], PAGE);
    expect(await resolveExternalApply(nc.deps, 'naukri', { job_id: JOB })).toMatchObject({ code: 'no_external_control' });
    expect(row(nc.db)).toMatchObject({ s: 'manual_review', n: 'external:no_external_control' });

    const hu = setup({ popups: ['https://careers.acme-corp.example/jobs/9'] });
    await resolveExternalApply(hu.deps, 'naukri', { job_id: JOB });
    expect(row(hu.db).n).toBe('external:host_unknown');

    const iv = setup({ popups: ['https://user:pw@boards.greenhouse.io/acme/jobs/9'] });
    expect(await resolveExternalApply(iv.deps, 'naukri', { job_id: JOB })).toMatchObject({ code: 'invalid_url' });
    expect(row(iv.db).n).toBe('external:invalid_url');
  });

  it('a dry run writes nothing', async () => {
    const s = setup({ env: { JOBBER_DRY_RUN: '1' } });
    expect((await resolveExternalApply(s.deps, 'naukri', { job_id: JOB })).status).toBe('dry_run');
    expect(row(s.db)).toMatchObject({ s: null, n: null });
  });
});

describe('manual queue reasons', () => {
  it('unresolved codes get company_site_unresolved, host/form codes stay company_site_form', () => {
    expect(manualReasonLabel('company_site_unresolved')).toBe('Could not read the company site link');
    const db = openDb(':memory:');
    for (const [id, note] of [['1', 'external:no_popup'], ['2', 'external:host_unknown']] as const) {
      saveJob(db, { id, source: 'naukri', title: id, company: id, url: `https://www.naukri.com/job-listings-x-${id}00000000000`, apply_url: `https://www.naukri.com/job-listings-x-${id}00000000000`, description: 'd', posted_at: null } as any);
      enqueueOutreach(db, { job_id: id, resume_pdf_path: '/x.pdf', email_subject: null, email_body: null, email_to: null, connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: 'naukri', apply_tier: 'agent', apply_url: `https://www.naukri.com/job-listings-x-${id}00000000000`, resume_json: '{}' } as any);
      db.prepare("UPDATE outreach_queue SET apply_status = 'manual_review', apply_note = ? WHERE job_id = ?").run(note, id);
    }
    const v = buildManualQueue(db, {} as NodeJS.ProcessEnv);
    expect(v.items.map((i) => [i.job_id, i.reason]).sort()).toEqual([['1', 'company_site_unresolved'], ['2', 'company_site_form']]);
  });
});

describe('apply:requeue-company-site', () => {
  it('requeues only note-less naukri manual_review rows without a resolved url, is idempotent, honours --dry', () => {
    const db = openDb(':memory:');
    const mk = (id: string, platform: string, status: string, note: string | null, ext: string | null) => {
      saveJob(db, { id, source: 'naukri', title: id, company: id, url: `https://x.example/${id}`, apply_url: `https://x.example/${id}`, description: 'd', posted_at: null } as any);
      enqueueOutreach(db, { job_id: id, resume_pdf_path: '/x.pdf', email_subject: null, email_body: null, email_to: null, connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: platform, apply_tier: 'agent', apply_url: `https://x.example/${id}`, resume_json: '{}' } as any);
      db.prepare('UPDATE outreach_queue SET apply_status = ?, apply_note = ? WHERE job_id = ?').run(status, note, id);
      if (ext) db.prepare('UPDATE jobs SET external_apply_url = ? WHERE id = ?').run(ext, id);
    };
    mk('a', 'naukri', 'manual_review', null, null);
    mk('b', 'naukri', 'manual_review', '', null);
    mk('c', 'naukri', 'manual_review', 'external:host_unknown', 'https://x.example/c');
    mk('d', 'naukri', 'manual_review', null, 'https://x.example/d');
    mk('e', 'greenhouse', 'manual_review', null, null);
    mk('f', 'naukri', 'submitted', null, null);
    expect(requeue(['--dry'], { db }).lines.join()).toContain('2 Naukri');
    expect(db.prepare("SELECT COUNT(*) n FROM outreach_queue WHERE apply_status IS NULL").get()).toEqual({ n: 0 });
    expect(requeue([], { db }).lines.join()).toContain('requeued 2');
    expect(requeue([], { db }).lines.join()).toContain('requeued 0');
    const s = db.prepare('SELECT job_id, apply_status FROM outreach_queue ORDER BY job_id').all();
    expect(s).toEqual([
      { job_id: 'a', apply_status: null }, { job_id: 'b', apply_status: null }, { job_id: 'c', apply_status: 'manual_review' },
      { job_id: 'd', apply_status: 'manual_review' }, { job_id: 'e', apply_status: 'manual_review' }, { job_id: 'f', apply_status: 'submitted' },
    ]);
    expect(requeue(['--x'], { db }).code).toBe(2);
  });
});
