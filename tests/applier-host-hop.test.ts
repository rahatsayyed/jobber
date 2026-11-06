import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleOpen } from '../src/applier/tools/open.js';
import { handleFill } from '../src/applier/tools/fill.js';
import { handleUpload } from '../src/applier/tools/upload.js';
import { handleChoose } from '../src/applier/tools/choose.js';
import { handleNext } from '../src/applier/tools/next.js';
import { handleState } from '../src/applier/tools/state.js';
import { handleSubmit } from '../src/applier/tools/submit.js';
import { handleEscalate } from '../src/applier/escalate.js';
import { APPLIER_TOOL_SCHEMAS, APPLIER_EXTRA_TOOL_SCHEMAS } from '../src/applier/tools/index.js';
import { companyNameMatchesHost, evaluateHost, vendorLookAlike } from '../src/applier/hostHop.js';
import { releaseHostParked } from '../src/applier/releaseHostParked.js';
import { run as releaseRun } from '../scripts/apply-release-held.js';
import { enqueueOutreach, openDb, saveJob } from '../src/db.js';
import { count, makeApplier, type ApplierHarness, type HarnessOpts } from './helpers/applierHarness.js';

let h: ApplierHarness | null = null;
const dirs: string[] = [];
afterEach(async () => { await h?.close(); h = null; for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const GH = 'https://boards.greenhouse.io/acme/jobs/1';
const name = { kind: 'profile', field: 'name.first' } as const;
async function opened(o: HarnessOpts & { urlRef?: { value: string } } = {}): Promise<ApplierHarness> {
  h = makeApplier(o);
  const r = await handleOpen({ job_id: 'job-1' }, h.deps);
  expect(r.status, JSON.stringify(r)).toBe('ok');
  return h;
}
const cur = (x: ApplierHarness) => x.deps.state.cur!;
const queueRow = (x: ApplierHarness) => x.db.prepare('SELECT apply_status, apply_note FROM outreach_queue WHERE job_id = ?').get('job-1') as { apply_status: string | null; apply_note: string | null };

describe('hop policy (pure)', () => {
  const ev = (url: string, ctx = {}, job = { host: 'boards.greenhouse.io', hops: 0 }) => evaluateHost(job, url, ctx);
  it('same host, vendor hosts and same registrable domain are fine', () => {
    expect(ev('https://boards.greenhouse.io/x').kind).toBe('same');
    for (const u of ['https://jobs.lever.co/a', 'https://acme.wd5.myworkdayjobs.com/x', 'https://jobs.ashbyhq.com/a', 'https://acme.bamboohr.com/careers', 'https://apply.workable.com/a', 'https://careers.smartrecruiters.com/a', 'https://acme.recruitee.com/o/1', 'https://acme.teamtailor.com/jobs/1', 'https://acme.icims.com/jobs/1']) {
      expect(ev(u), u).toMatchObject({ kind: 'allowed', via: 'vendor' });
    }
    expect(evaluateHost({ host: 'careers.acme.com' }, 'https://apply.acme.com/f')).toMatchObject({ kind: 'allowed', via: 'same_domain' });
    expect(evaluateHost({ host: 'www.acme.co.uk' }, 'https://apply.acme.co.uk/f')).toMatchObject({ kind: 'allowed', via: 'same_domain' });
    expect(evaluateHost({ host: 'a.github.io' }, 'https://b.github.io/f').kind).toBe('refused');
  });
  it('unknown hosts, look-alikes, punycode, ip, port, http and credentials are refused', () => {
    for (const u of [
      'https://evil.example.test/apply', 'https://greenhouse.io.evil.com/a', 'https://boards-greenhouse.io/a', 'https://xn--grenhouse-xxa.io/a', 'https://grееnhouse.io/a',
      'http://jobs.lever.co/a', 'https://jobs.lever.co:8443/a', 'https://1.2.3.4/a', 'https://[::1]/a', 'https://u:p@jobs.lever.co/a', 'https://lever.co.evil.io/a', 'https://my-icims-careers.net/a',
    ]) {
      expect(ev(u, { company: 'Acme Systems', domains: [], ownerHosts: [] }).kind, u).toBe('refused');
    }
    expect(vendorLookAlike('greenhouse.io.evil.com')).toBe(true);
    expect(vendorLookAlike('boards.greenhouse.io')).toBe(false);
  });
  it('max 4 hops', () => {
    expect(ev('https://jobs.lever.co/a', {}, { host: 'x.greenhouse.io', hops: 3 }).kind).toBe('allowed');
    expect(ev('https://jobs.lever.co/a', {}, { host: 'x.greenhouse.io', hops: 4 })).toMatchObject({ kind: 'refused', why: 'too_many_hops' });
  });
  it('company site: name match, domain on file, owner list; short words and tricks refused', () => {
    expect(ev('https://www.persistent.com/careers', { company: 'Persistent Systems Limited' }).kind).toBe('allowed');
    expect(ev('https://persistentsystems.com/', { company: 'Persistent Systems Limited' })).toMatchObject({ kind: 'allowed', via: 'company_name' });
    expect(ev('https://careers.acme.in/', { company: 'Acme Technologies Pvt. Ltd.' }).kind).toBe('allowed');
    expect(ev('https://sage.com/', { company: 'Sage' }).kind).toBe('allowed');
    for (const u of ['https://sage-evil.com/', 'https://message.com/', 'https://sageevil.com/', 'https://persistent.com.evil.io/', 'https://xn--persistnt-8ya.com/', 'https://persistent.github.io/']) {
      expect(ev(u, { company: u.includes('sage') || u.includes('message') ? 'Sage' : 'Persistent Systems Limited' }).kind, u).toBe('refused');
    }
    expect(companyNameMatchesHost('Abc Inc', 'abc.com')).toBe(false); // under 4 characters
    expect(ev('https://zorbit.net/x', { company: 'Acme', domains: ['zorbit.net'] })).toMatchObject({ kind: 'allowed', via: 'company_domain' });
    expect(ev('https://careers.zorbit.net/x', { company: 'Acme', domains: ['other.net'] }).kind).toBe('refused');
    expect(ev('https://careers.zorbit.net/x', { company: 'Acme', ownerHosts: ['zorbit.net'] })).toMatchObject({ kind: 'allowed', via: 'owner_list' });
  });
});

describe('hop in every tool path', () => {
  it('apply_open: a redirect to another vendor continues on it and uses its platform', async () => {
    const urlRef = { value: 'https://jobs.lever.co/acme/1' };
    const x = await opened({ urlRef });
    expect(cur(x)).toMatchObject({ host: 'jobs.lever.co', platform: 'lever', hops: 1 });
    expect(x.escalations).toEqual([]);
    expect(queueRow(x).apply_status).toBeNull();
  });

  it('apply_open: a redirect to the company site by name continues; to an unknown host parks the job', async () => {
    let x = await opened({ urlRef: { value: 'https://www.acme.com/apply' } });
    expect(cur(x).host).toBe('www.acme.com');
    await x.close(); h = null;
    h = makeApplier({ urlRef: { value: 'https://evil.example.test/apply' } });
    const r = await handleOpen({ job_id: 'job-1' }, h.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'host_changed', reason: 'unknown_apply_host: evil.example.test' });
    expect(h.deps.state.cur).toBeNull();
    expect(queueRow(h)).toEqual({ apply_status: 'needs_owner', apply_note: 'unknown_apply_host:evil.example.test' });
    expect(h.escalations).toEqual([['unknown_apply_host', 'evil.example.test']]);
    expect(count(h.db, "SELECT COUNT(*) n FROM escalations WHERE reason = 'apply:unknown_apply_host'")).toBe(1);
    // not retried in this run
    expect(await handleOpen({ job_id: 'job-1' }, h.deps)).toMatchObject({ status: 'refused', code: 'escalated_this_run' });
  });

  it('state, fill, upload, choose: a vendor hop continues and the work happens on the new host', async () => {
    const urlRef = { value: GH };
    const x = await opened({ urlRef });
    urlRef.value = 'https://jobs.lever.co/acme/apply';
    expect(await handleState(x.deps)).toMatchObject({ status: 'ok', host: 'jobs.lever.co', platform: 'lever' });
    expect(await handleFill({ field: 'f1', ref: name }, x.deps)).toMatchObject({ status: 'ok' });
    expect(x.site.fills.length).toBe(1);
    expect(await handleUpload({ field: 'f5' }, x.deps)).toMatchObject({ status: 'ok' });
    expect(x.site.uploads.length).toBe(1);
    expect(await handleChoose({ field: 'f6', option: 'x' }, x.deps)).not.toMatchObject({ code: 'host_changed' });
    expect(cur(x).hops).toBe(1);
    expect(x.escalations).toEqual([]);
  });

  it('next: the click may land on the ATS; submit counts the host where the form is', async () => {
    const urlRef = { value: GH };
    const x = await opened({ urlRef, start: 'ats-b-form.html', transitions: { 'Submit application': [{ fixture: 'ats-b-confirmation.html' }] } });
    expect(await handleFill({ field: 'f1', ref: { kind: 'profile', field: 'name.full' } }, x.deps)).toMatchObject({ status: 'ok' });
    expect(await handleFill({ field: 'f2', ref: { kind: 'profile', field: 'email' } }, x.deps)).toMatchObject({ status: 'ok' });
    expect(await handleUpload({ field: 'f4' }, x.deps)).toMatchObject({ status: 'ok' });
    urlRef.value = 'https://jobs.ashbyhq.com/acme/form';
    const r = await handleSubmit({}, x.deps);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'submitted' });
    expect(count(x.db, "SELECT COALESCE(SUM(count),0) n FROM apply_host_day WHERE host = 'jobs.ashbyhq.com'")).toBe(1);
    expect(count(x.db, "SELECT COUNT(*) n FROM apply_host_day WHERE host = 'boards.greenhouse.io'")).toBe(0);
    expect(count(x.db, "SELECT COUNT(*) n FROM applications WHERE platform = 'ashby' AND status = 'submitted'")).toBe(1);
  });

  it('next: an unknown host after the move is parked and the session closed', async () => {
    const urlRef = { value: GH };
    const x = await opened({ urlRef });
    urlRef.value = 'https://evil.example.test/x';
    const ctl = (await handleState(x.deps)); // parks already on the state read
    expect(ctl).toMatchObject({ status: 'refused', code: 'host_changed', reason: 'unknown_apply_host: evil.example.test' });
    expect(await handleNext({ control: 'c1' }, x.deps)).toMatchObject({ code: 'no_job' });
    expect(x.runtime.page()).toBeNull();
    expect(queueRow(x).apply_status).toBe('needs_owner');
    expect(x.site.fills).toEqual([]);
  });

  it('submit: an unknown host before the click is refused, nothing counted or clicked', async () => {
    const urlRef = { value: GH };
    const x = await opened({ urlRef, start: 'ats-b-form.html' });
    urlRef.value = 'https://evil.example.test/x';
    expect(await handleSubmit({}, x.deps)).toMatchObject({ status: 'refused', code: 'host_changed' });
    expect(count(x.db, 'SELECT COALESCE(SUM(count),0) n FROM apply_host_day')).toBe(0);
    expect(x.site.events.filter((e) => e.startsWith('click:control')).length).toBe(0);
  });

  it('same registrable domain hop on a company site continues (job name does not match the domain)', async () => {
    const urlRef = { value: 'https://careers.acme.com/jobs/1' };
    const x = await opened({ urlRef, applyUrl: 'https://careers.acme.com/jobs/1', platform: 'browser', tier: 'agent', env: { APPLY_ALLOW_UNKNOWN_HOSTS: 'true' } });
    x.db.prepare("UPDATE jobs SET company = 'Zzz Corp'").run();
    urlRef.value = 'https://apply.acme.com/form';
    expect(await handleState(x.deps)).toMatchObject({ status: 'ok', host: 'apply.acme.com' });
    urlRef.value = 'https://apply.elsewhere.net/form';
    expect(await handleState(x.deps)).toMatchObject({ status: 'refused', code: 'host_changed' });
  });

  it('at most 4 hops per application (a 4-hop chain ending on a vendor is fine, a 5th is parked)', async () => {
    const urlRef = { value: GH };
    const x = await opened({ urlRef });
    for (const u of ['https://jobs.lever.co/a', 'https://jobs.ashbyhq.com/a', 'https://apply.workable.com/a', 'https://acme.recruitee.com/o/1']) {
      urlRef.value = u;
      expect(await handleState(x.deps), u).toMatchObject({ status: 'ok' });
    }
    urlRef.value = 'https://careers.smartrecruiters.com/a';
    expect(await handleState(x.deps)).toMatchObject({ status: 'refused', code: 'host_changed' });
    expect(queueRow(x).apply_status).toBe('needs_owner');
  });

  it('an unknown host in the middle of a chain that ends on an allowed host is fine (the page settles first)', async () => {
    let phase = 0;
    const urlRef = { get value() { return phase === 0 ? GH : phase === 1 ? 'https://track.redirector.example.test/r' : 'https://jobs.lever.co/acme/apply'; }, set value(_v: string) { /* fixed */ } };
    const x = await opened({ urlRef, env: { WEB_SETTLE_MS: '1' } });
    phase = 1;
    const orig = x.site.launcher;
    void orig;
    // the first wait inside the settle loop moves the chain on
    const page = x.runtime.page()!;
    const wait = page.waitForTimeout.bind(page);
    page.waitForTimeout = async (ms: number) => { phase = 2; return wait(ms); };
    const r = await handleState(x.deps);
    expect(r, JSON.stringify(r)).toMatchObject({ status: 'ok', host: 'jobs.lever.co' });
    expect(queueRow(x).apply_status).toBeNull();
    expect(x.escalations).toEqual([]);
  });

  const PAGE = (fieldHtml: string) => `<html><head><title>Apply</title></head><body><form><label>Full name <input name="name" type="text" required></label><label>Email <input name="email" type="email" required></label>${fieldHtml}<button type="submit">Submit application</button></form></body></html>`;
  it('a final page that asks for payment, an ID number or bank details is parked as unsafe_apply_page', async () => {
    for (const f of ['<label>Card number <input name="cc" type="text"></label>', '<label>Aadhaar number <input name="a" type="text"></label>', '<label>Bank account number <input name="b" type="text"></label>']) {
      const urlRef = { value: GH };
      const x = await opened({ urlRef, start: PAGE(f) });
      urlRef.value = 'https://jobs.lever.co/acme/apply';
      const r = await handleState(x.deps);
      expect(r, f).toMatchObject({ status: 'refused', code: 'unsafe_apply_page' });
      expect(queueRow(x)).toEqual({ apply_status: 'needs_owner', apply_note: 'unsafe_apply_page:jobs.lever.co' });
      expect(x.deps.state.cur).toBeNull();
      expect(x.site.fills).toEqual([]);
      await x.close(); h = null;
    }
  });
  it('the same fields on the original host (no hop) are not judged', async () => {
    const x = await opened({ urlRef: { value: GH }, start: PAGE('<label>Aadhaar number <input name="a" type="text"></label>') });
    expect(await handleState(x.deps)).toMatchObject({ status: 'ok' });
  });
  it('a login wall at the end of a chain is not unsafe: it parks as needs_human as before', async () => {
    const urlRef = { value: GH };
    const x = await opened({ urlRef, start: '<html><body><form><label>Email <input type="email" name="e"></label><label>Password <input type="password" name="p"></label><button>Sign in</button></form></body></html>' });
    urlRef.value = 'https://acme.wd5.myworkdayjobs.com/x';
    expect(await handleState(x.deps)).toMatchObject({ status: 'ok' });
    const r = await handleEscalate({ job_id: 'job-1', reason: 'login_failed' }, x.deps, { notify: () => undefined, telegram: { send: async () => ({ ok: true, detail: '' }) } });
    expect(r).toMatchObject({ status: 'needs_human', host: 'acme.wd5.myworkdayjobs.com' });
  });

  it('the host cap counts the host of the final form', async () => {
    const urlRef = { value: GH };
    const x = await opened({ urlRef, env: { APPLY_MAX_PER_HOST_LEVER: '1' } });
    x.db.prepare("INSERT INTO apply_host_day (host, day, count) VALUES ('jobs.lever.co', date('now'), 1)").run();
    urlRef.value = 'https://jobs.lever.co/a';
    expect(await handleState(x.deps)).toMatchObject({ status: 'rate_limited', code: 'host_cap' });
    expect(cur(x).host).toBe('boards.greenhouse.io');
  });

  it('a login wall after a hop still parks as needs_human on the new host', async () => {
    const urlRef = { value: GH };
    const x = await opened({ urlRef });
    urlRef.value = 'https://acme.wd5.myworkdayjobs.com/x';
    await handleState(x.deps);
    const sent: string[] = [];
    const r = await handleEscalate({ job_id: 'job-1', reason: 'account_needed' }, x.deps, { notify: () => undefined, telegram: { send: async (t: string) => { sent.push(t); return { ok: true, detail: '' }; } } });
    expect(r).toMatchObject({ status: 'needs_human', host: 'acme.wd5.myworkdayjobs.com' });
  });

  it('company site by verified contact domain and by the owner list', async () => {
    const urlRef = { value: GH };
    let x = await opened({ urlRef });
    x.db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('Acme', 'hr@zorbit.net', 'hr', 1, 'hunter', 0.9)").run();
    urlRef.value = 'https://jobs.zorbit.net/x';
    expect(await handleState(x.deps)).toMatchObject({ status: 'ok', host: 'jobs.zorbit.net' });
    await x.close(); h = null;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'apply-hosts.json'), JSON.stringify({ hosts: ['owner-ok.com', 'bad host', 5] }));
    const ref2 = { value: GH };
    x = await opened({ urlRef: ref2, env: { JOBAPPLIER_USER_DATA: dir } });
    ref2.value = 'https://careers.owner-ok.com/x';
    expect(await handleState(x.deps)).toMatchObject({ status: 'ok', host: 'careers.owner-ok.com' });
  });
});

describe('rule 17: no tool takes a URL from the model', () => {
  it('every applier tool schema rejects a url argument and declares none', () => {
    const all = { ...APPLIER_TOOL_SCHEMAS, ...APPLIER_EXTRA_TOOL_SCHEMAS } as Record<string, { safeParse: (v: unknown) => { success: boolean }; shape?: Record<string, unknown> }>;
    for (const [tool, schema] of Object.entries(all)) {
      const keys = Object.keys(schema.shape ?? {});
      expect(keys.filter((k) => /url|host|link/i.test(k) && k !== 'url_or_message_text'), tool).toEqual([]);
      expect(schema.safeParse({ url: 'https://evil.example.test', host: 'evil.example.test' }).success, tool).toBe(false);
    }
  });
});

describe('apply:release-held --reason host_changed', () => {
  function seed() {
    const db = openDb(':memory:');
    const add = (id: string, o: { company?: string; url?: string; note?: string | null; status?: string; esc?: string; excluded?: string } = {}) => {
      saveJob(db, { id, source: 'greenhouse', title: id, company: o.company ?? 'Persistent Systems', url: o.url ?? 'https://boards.greenhouse.io/persistent/jobs/1', apply_url: o.url ?? 'https://boards.greenhouse.io/persistent/jobs/1', description: 'd', posted_at: null } as never);
      enqueueOutreach(db, { job_id: id, resume_pdf_path: '/x.pdf', email_subject: null, email_body: null, email_to: null, connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: 'greenhouse', apply_tier: 'fast', apply_url: o.url ?? 'https://boards.greenhouse.io/persistent/jobs/1', resume_json: '{}' } as never);
      db.prepare("UPDATE outreach_queue SET apply_status = ?, apply_note = ? WHERE job_id = ?").run(o.status ?? 'needs_owner', o.note ?? null, id);
      if (o.excluded) db.prepare('UPDATE jobs SET excluded_reason = ? WHERE id = ?').run(o.excluded, id);
      if (o.esc) db.prepare("INSERT INTO escalations (platform, reason, detail, created_at) VALUES ('apply', ?, ?, datetime('now'))").run(o.esc, `reason=host_unknown platform=greenhouse host=boards.greenhouse.io job=${id}`);
    };
    add('old1', { esc: 'apply:host_unknown' });                                       // parked by the old code, destination unknown: released
    add('new1', { note: 'unknown_apply_host:www.persistent.com' });                    // company site, name match: released
    add('new2', { note: 'unknown_apply_host:evil.example.test' });                     // still untrusted: stays
    add('veto', { note: 'unknown_apply_host:www.persistent.com', excluded: 'location FAIL' }); // vetoed: stays
    add('other', {});                                                                  // needs_owner for another reason: untouched
    add('held', { status: 'held', note: 'unknown_apply_host:www.persistent.com' });    // not needs_owner: untouched
    return db;
  }
  it('releases what passes the policy, leaves the rest parked, is idempotent and honours --dry', () => {
    const db = seed();
    const dry = releaseRun(['--reason', 'host_changed', '--dry'], { db });
    expect(dry.lines.join('\n')).toMatch(/would release 2 of 4/);
    expect(count(db, "SELECT COUNT(*) n FROM outreach_queue WHERE apply_status = 'needs_owner'")).toBe(5);
    const r = releaseRun(['--reason', 'host_changed'], { db });
    expect(r.releasedHostParked).toBe(2);
    expect(r.lines.join('\n')).toMatch(/still parked: 2 \(hosts: .*evil\.example\.test/);
    const st = db.prepare('SELECT job_id, apply_status, apply_note FROM outreach_queue ORDER BY job_id').all();
    expect(st).toEqual([
      { job_id: 'held', apply_status: 'held', apply_note: 'unknown_apply_host:www.persistent.com' },
      { job_id: 'new1', apply_status: null, apply_note: null },
      { job_id: 'new2', apply_status: 'needs_owner', apply_note: 'unknown_apply_host:evil.example.test' },
      { job_id: 'old1', apply_status: null, apply_note: null },
      { job_id: 'other', apply_status: 'needs_owner', apply_note: null },
      { job_id: 'veto', apply_status: 'needs_owner', apply_note: 'unknown_apply_host:www.persistent.com' },
    ]);
    expect(count(db, "SELECT COUNT(*) n FROM applications")).toBe(0);
    expect(releaseHostParked(db, {}).released).toBe(0);
    expect(releaseRun(['--reason', 'nope'], { db }).code).toBe(2);
  });
});
