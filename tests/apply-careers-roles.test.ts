import { afterEach, describe, expect, it } from 'vitest';
import { handleOpen } from '../src/applier/tools/open.js';
import { handleState } from '../src/applier/tools/state.js';
import { handleListRoles, handleOpenRole, OpenRoleInput } from '../src/applier/tools/roles.js';
import { handleEscalate } from '../src/applier/escalate.js';
import { createApplierState } from '../src/applier/tools/common.js';
import { buildManualQueue } from '../src/manual/manualApply.js';
import { extractRoles, roleRelevance } from '../src/apply/careersRoles.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { loadFixture } from './helpers/fixtureSite.js';
import { count, makeApplier, type ApplierHarness } from './helpers/applierHarness.js';

let h: ApplierHarness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const RESUME = {
  name: 'Jane Fixture', jobTitle: 'Full Stack Developer', email: 'jane.fixture@example.com',
  skills: [{ category: 'Frontend', items: ['React', 'TypeScript'] }, { category: 'Backend', items: ['Node.js'] }],
};
const GOTO = { '/acme/jobs/1001': 'ats-a-form.html', '/acme/jobs/1002': 'ats-a-form.html', '/acme/jobs/1003': 'ats-a-form.html', '/acme/jobs/1007': 'ats-a-form.html', '/acme/jobs/1004': 'ats-a-form.html' };
const x = () => ({ notify: () => undefined, styleCfg: DEFAULT_STYLE_CONFIG, runId: 'run-a', telegram: { send: async () => ({ ok: true, detail: 'x' }) } });

async function listing(o: Parameters<typeof makeApplier>[0] = {}): Promise<ApplierHarness> {
  h = makeApplier({ start: 'careers-listing.html', gotoMap: GOTO, ...o });
  h.deps.draft = { baseResume: () => RESUME, styleCfg: DEFAULT_STYLE_CONFIG };
  const r = await handleOpen({ job_id: 'job-1' }, h.deps);
  expect(r.status).toBe('ok');
  return h;
}

const idOf = async (t: ApplierHarness, title: string): Promise<string> => {
  const r = await handleListRoles({}, t.deps);
  const hit = r.roles?.find((x) => x.title === title);
  expect(hit, title).toBeTruthy();
  return hit!.role_id;
};

describe('extractRoles (pure)', () => {
  it('keeps same-host role links in page order, drops navigation, assets and other hosts, and caps at 60', () => {
    const raw = loadFixture('careers-listing.html', 'https://boards.greenhouse.io/acme/jobs/1');
    const roles = extractRoles(raw.links, raw.url, ['boards.greenhouse.io']);
    expect(roles.map((r) => r.title)).toEqual([
      'Full Stack Developer', 'Senior React Engineer', 'Frontend Developer', 'Backend Engineer', 'Marketing Manager', 'Full Stack Engineer', 'Software Engineer, Web',
    ]);
    expect(roles.map((r) => r.role_id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
    expect(roles[0]).toMatchObject({ location: 'Remote, India', kind: 'role', href: 'https://boards.greenhouse.io/acme/jobs/1001' });
    expect(roles.some((r) => r.href.includes('partner.example.org') || r.href.endsWith('.pdf'))).toBe(false);
    const many = Array.from({ length: 90 }, (_, i) => ({ label: `Software Engineer ${i}`, href: `https://boards.greenhouse.io/acme/jobs/${5000 + i}`, context: `Software Engineer ${i} Pune` }));
    expect(extractRoles(many, 'https://boards.greenhouse.io/acme/jobs/1', ['boards.greenhouse.io'])).toHaveLength(60);
  });

  it('a link with a role noun but no job-like path is a "maybe", and a bare "Apply" button is dropped', () => {
    const roles = extractRoles([
      { label: 'Product Designer', href: 'https://boards.greenhouse.io/team/design' },
      { label: 'Apply now', href: 'https://boards.greenhouse.io/acme/jobs/7777' },
      { label: 'Our values', href: 'https://boards.greenhouse.io/values' },
    ], 'https://boards.greenhouse.io/acme', ['boards.greenhouse.io']);
    expect(roles.map((r) => [r.title, r.kind])).toEqual([['Product Designer', 'maybe']]);
  });
});

describe('roleRelevance (pure)', () => {
  const R = (title: string, location = '') => roleRelevance({ title, location }, RESUME);
  it('accepts the owner target in India or remote', () => {
    for (const [t, l] of [['Full Stack Developer', 'Remote, India'], ['Senior React Engineer', 'Pune'], ['Frontend Developer', 'Bengaluru, India'], ['Node.js Developer', ''], ['Software Engineer, Web', 'Remote']]) expect(R(t, l), t).toEqual({ ok: true });
  });
  it('refuses other fields, seniority and interns, and roles in other countries', () => {
    expect(R('Backend Engineer', 'Pune')).toMatchObject({ ok: false, reason: 'title_not_relevant' });
    expect(R('Marketing Manager')).toMatchObject({ ok: false, reason: 'title_excluded' });
    expect(R('React Developer Intern')).toMatchObject({ ok: false, reason: 'title_excluded' });
    expect(R('Full Stack Engineer', 'Berlin, Germany')).toMatchObject({ ok: false, reason: 'location_outside' });
    expect(R('Full Stack Engineer', 'London, UK')).toMatchObject({ ok: false, reason: 'location_outside' });
  });
});

describe('apply_list_roles', () => {
  it('returns the roles of the open listing (ids, title, location, kind) and nothing else', async () => {
    const t = await listing();
    const r = await handleListRoles({}, t.deps);
    expect(r).toMatchObject({ status: 'ok', code: 'roles', info: { count: 7, max_per_listing: 3 } });
    expect(r.roles![0]).toEqual({ role_id: 'r1', title: 'Full Stack Developer', location: 'Remote, India', kind: 'role' });
    expect(JSON.stringify(r)).not.toContain('partner.example.org');
    expect(JSON.stringify(r)).not.toContain('http');
  });

  it('refuses without an open job and on a form page', async () => {
    h = makeApplier({ start: 'careers-listing.html', gotoMap: GOTO });
    expect(await handleListRoles({}, h.deps)).toMatchObject({ status: 'refused', code: 'no_job' });
    await h.close();
    h = makeApplier();
    await handleOpen({ job_id: 'job-1' }, h.deps);
    expect(await handleListRoles({}, h.deps)).toMatchObject({ status: 'refused', code: 'not_a_listing' });
  });

  it('withholds the list when a role title is a prompt injection', async () => {
    h = makeApplier({ start: 'job-injection.html' });
    await handleOpen({ job_id: 'job-1' }, h.deps);
    const r = await handleListRoles({}, h.deps);
    expect(r.status).toBe('blocked');
    expect(r.roles).toBeUndefined();
  });
});

describe('apply_open_role', () => {
  it('needs a list first and refuses an unknown role id', async () => {
    const t = await listing();
    expect(await handleOpenRole({ role_id: 'r1' }, t.deps)).toMatchObject({ status: 'refused', code: 'no_roles' });
    await handleListRoles({}, t.deps);
    expect(await handleOpenRole({ role_id: 'r99' }, t.deps)).toMatchObject({ status: 'refused', code: 'unknown_role' });
    expect(OpenRoleInput.safeParse({ role_id: 'https://evil.example.org' }).success).toBe(false);
    expect(OpenRoleInput.safeParse({ role_id: 'r1', url: 'https://evil.example.org' }).success).toBe(false);
  });

  it('opens a fitting role as a job of its own and continues in the normal flow', async () => {
    const t = await listing();
    const id = await idOf(t, 'Full Stack Developer');
    const r = await handleOpenRole({ role_id: id }, t.deps);
    expect(r).toMatchObject({ status: 'ok', code: 'opened', platform: 'greenhouse' });
    expect(r.job_id).toMatch(/^role:job-1:[0-9a-f]{10}$/);
    expect(r.queue_id).toBeGreaterThan(1);
    // the role is a job and a queue row of its own, cloned from the listing's prepared resume
    expect(t.db.prepare('SELECT title, company, source, apply_url FROM jobs WHERE id = ?').get(r.job_id)).toEqual({
      title: 'Full Stack Developer', company: 'Acme', source: 'careers_listing', apply_url: 'https://boards.greenhouse.io/acme/jobs/1001',
    });
    expect(t.db.prepare('SELECT resume_pdf_path, apply_platform, apply_status, status FROM outreach_queue WHERE id = ?').get(r.queue_id)).toEqual({
      resume_pdf_path: t.resumePath, apply_platform: 'greenhouse', apply_status: null, status: 'queued',
    });
    // the listing row is marked by code, the open job is now the role, and it spent a second attempt
    expect(t.db.prepare('SELECT apply_status, apply_note FROM outreach_queue WHERE job_id = ?').get('job-1')).toEqual({ apply_status: 'listing_expanded', apply_note: 'roles opened: 1' });
    expect(t.deps.state.cur?.jobId).toBe(r.job_id);
    expect(count(t.db, "SELECT COUNT(*) AS n FROM rate_events WHERE key = 'apply_attempt'")).toBe(2);
    // the page tools now work on the role
    expect(await handleState(t.deps)).toMatchObject({ status: 'ok', code: 'state' });
  });

  it('opens at most three roles per listing, one at a time, and never the same role twice', async () => {
    const t = await listing();
    const a = await idOf(t, 'Full Stack Developer');
    const b = await idOf(t, 'Senior React Engineer');
    const c = await idOf(t, 'Frontend Developer');
    const d = await idOf(t, 'Software Engineer, Web');
    expect((await handleOpenRole({ role_id: a }, t.deps)).status).toBe('ok');
    // the first role is still open: finish or close it first
    expect(await handleOpenRole({ role_id: b }, t.deps)).toMatchObject({ status: 'refused', code: 'job_open' });
    await t.runtime.close(); t.deps.state.cur = null;
    expect(await handleOpenRole({ role_id: a }, t.deps)).toMatchObject({ status: 'refused', code: 'already_opened' });
    expect((await handleOpenRole({ role_id: b }, t.deps)).status).toBe('ok');
    await t.runtime.close(); t.deps.state.cur = null;
    expect((await handleOpenRole({ role_id: c }, t.deps)).status).toBe('ok');
    await t.runtime.close(); t.deps.state.cur = null;
    expect(await handleOpenRole({ role_id: d }, t.deps)).toMatchObject({ status: 'refused', code: 'role_limit' });
    // a fresh run state still counts the roles of earlier runs
    t.deps.state = createApplierState();
    await handleOpen({ job_id: 'job-1' }, t.deps);
    const again = await handleListRoles({}, t.deps);
    const fourth = again.roles!.find((r) => r.title === 'Software Engineer, Web')!.role_id;
    expect(await handleOpenRole({ role_id: fourth }, t.deps)).toMatchObject({ status: 'refused', code: 'role_limit' });
  });

  it('refuses roles that do not fit: other field, other country, manager', async () => {
    const t = await listing();
    for (const title of ['Backend Engineer', 'Marketing Manager', 'Full Stack Engineer']) {
      const r = await handleOpenRole({ role_id: await idOf(t, title) }, t.deps);
      expect(r, title).toMatchObject({ status: 'refused', code: 'not_relevant' });
    }
    expect(count(t.db, "SELECT COUNT(*) AS n FROM jobs WHERE source = 'careers_listing'")).toBe(0);
    expect(t.deps.state.cur?.jobId).toBe('job-1');
  });

  it('a cross-host link is never listed and a forged one is refused', async () => {
    const t = await listing();
    const list = await handleListRoles({}, t.deps);
    expect(list.roles!.some((r) => r.title.includes('partner site'))).toBe(false);
    t.deps.state.roles!.items.push({ role_id: 'r90', title: 'Full Stack Developer', location: 'Remote, India', href: 'https://partner.example.org/jobs/9001', kind: 'role' });
    expect(await handleOpenRole({ role_id: 'r90' }, t.deps)).toMatchObject({ status: 'refused', code: 'host_change' });
    expect(count(t.db, "SELECT COUNT(*) AS n FROM jobs WHERE source = 'careers_listing'")).toBe(0);
    expect(t.deps.state.cur?.host).toBe('boards.greenhouse.io');
  });

  it('dedupes by company and title: an earlier submitted application or a contact within 90 days', async () => {
    const t = await listing();
    // an earlier submitted application for Acme / Full Stack Developer
    t.db.prepare("INSERT INTO jobs (id, source, title, company, title_key, company_key) VALUES ('old-1','x','Full Stack Developer','Acme','developer full stack','acme')").run();
    t.db.prepare("INSERT INTO applications (job_id, platform, method, status, applied_at) VALUES ('old-1','greenhouse','browser','submitted', datetime('now'))").run();
    expect(await handleOpenRole({ role_id: await idOf(t, 'Full Stack Developer') }, t.deps)).toMatchObject({ status: 'refused', code: 'duplicate_application' });
    // a queued outreach row for Acme / Frontend Developer
    t.db.prepare("INSERT INTO jobs (id, source, title, company, title_key, company_key) VALUES ('old-2','x','Frontend Developer','Acme','developer frontend','acme')").run();
    t.db.prepare("INSERT INTO outreach_queue (job_id, status) VALUES ('old-2','queued')").run();
    expect(await handleOpenRole({ role_id: await idOf(t, 'Frontend Developer') }, t.deps)).toMatchObject({ status: 'refused', code: 'repeat_contact' });
    expect(t.deps.state.cur?.jobId).toBe('job-1');
  });

  it('runs the open guards on the role: a spent attempt budget stops it (rate_limited)', async () => {
    const t = await listing({ env: { APPLY_MAX_ATTEMPTS_PER_DAY: '1' } });
    const r = await handleOpenRole({ role_id: await idOf(t, 'Full Stack Developer') }, t.deps);
    expect(r).toMatchObject({ status: 'rate_limited', code: 'attempt_cap' });
  });

  it('refuses when the listing job is vetoed, and under the kill switch', async () => {
    const t = await listing();
    const id = await idOf(t, 'Full Stack Developer');
    t.db.prepare("UPDATE jobs SET excluded_reason = 'location FAIL' WHERE id = 'job-1'").run();
    expect(await handleOpenRole({ role_id: id }, t.deps)).toMatchObject({ status: 'refused', code: 'vetoed' });
    t.db.prepare("UPDATE jobs SET excluded_reason = NULL WHERE id = 'job-1'").run();
    const fs = await import('node:fs');
    fs.writeFileSync(t.stopFile, '');
    expect(await handleOpenRole({ role_id: id }, t.deps)).toMatchObject({ status: 'refused', code: 'killed' });
  });
});

describe('a listing with no fitting role', () => {
  it('apply_escalate no_relevant_role parks the job needs_owner and the manual queue shows it with the listing URL', async () => {
    h = makeApplier({ start: 'careers-listing-none.html' });
    h.deps.draft = { baseResume: () => RESUME, styleCfg: DEFAULT_STYLE_CONFIG };
    await handleOpen({ job_id: 'job-1' }, h.deps);
    const list = await handleListRoles({}, h.deps);
    expect(list.roles!.map((r) => r.title)).toEqual(['Backend Engineer', 'Marketing Manager', 'Sales Director', 'QA Tester']);
    for (const r of list.roles!) expect(await handleOpenRole({ role_id: r.role_id }, h.deps), r.title).toMatchObject({ status: 'refused', code: 'not_relevant' });
    const e = await handleEscalate({ job_id: 'job-1', reason: 'no_relevant_role' }, h.deps, x());
    expect(e).toMatchObject({ status: 'needs_owner', code: 'escalated' });
    expect(h.db.prepare('SELECT apply_status, apply_note FROM outreach_queue WHERE job_id = ?').get('job-1')).toEqual({ apply_status: 'needs_owner', apply_note: 'no_relevant_role' });
    const q = buildManualQueue(h.db, {});
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toMatchObject({ job_id: 'job-1', reason: 'no_relevant_role', open_url: 'https://boards.greenhouse.io/acme/jobs/1' });
    expect(count(h.db, "SELECT COUNT(*) AS n FROM jobs WHERE source = 'careers_listing'")).toBe(0);
  });
});
