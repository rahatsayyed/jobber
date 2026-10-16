import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { enqueueOutreach, listQueuedOutreach, openDb, saveJob, type Job } from '../src/db.js';
import { isHeldSource } from '../src/lib/discoverOnly.js';
import { approveProvider, getProvider, loadRunnable, proposeProvider, recordProviderRun, rejectProvider, specPath } from '../src/sources/generated/store.js';
import { runScriptSources } from '../src/sources/runner.js';
import { run as providersCli } from '../scripts/providers.js';
import { baseSpec } from './helpers/genSpec.js';

const LISTING = readFileSync('tests/fixtures/web/listing-a.html', 'utf8');
const NOW = new Date('2026-10-16T10:00:00Z');
let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'jobber-gen-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function fixture(id = 'acme', html = LISTING, name = 'a.html'): void {
  const dir = path.join(root, 'fixtures', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), html);
}
const propose = (db: ReturnType<typeof openDb>, spec: unknown = baseSpec(), minJobs = 3) => proposeProvider(db, root, spec, { minJobs, now: NOW });
const job = (id: string, source: string): Job => ({ id, source, title: 'Frontend Engineer', company: 'Acme', url: `https://x.example.test/${id}`, apply_url: `https://x.example.test/${id}`, description: 'd' });
const enqueue = (db: ReturnType<typeof openDb>, job_id: string) => enqueueOutreach(db, {
  job_id, resume_pdf_path: null, email_subject: 's', email_body: 'b', email_to: 'a@acme.example', connect_note: null, connect_profile_url: null,
  connect_category: null, connect_company: null, apply_platform: null, apply_url: null,
});

describe('propose and validate', () => {
  it('a valid spec with a fixture becomes validated, and the spec file is data with mode 0600 in the generated dir', () => {
    const db = openDb(':memory:');
    fixture();
    expect(propose(db)).toMatchObject({ ok: true, state: 'validated' });
    expect(getProvider(db, 'acme')).toMatchObject({ state: 'validated', approved: 0 });
    const file = specPath(root, 'acme')!;
    expect(file.startsWith(path.join(root, 'providers'))).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8')).id).toBe('acme');
    expect(loadRunnable(db, root).map((s) => s.id)).toEqual(['acme']);
  });

  it('fewer than N jobs, no fixture or a hostile spec stay candidate (or are refused)', () => {
    const db = openDb(':memory:');
    fixture();
    expect(propose(db, baseSpec(), 4)).toMatchObject({ ok: false, state: 'candidate', code: 'too_few_jobs' });
    expect(getProvider(db, 'acme')).toMatchObject({ state: 'candidate', reason: 'too_few_jobs' });
    expect(loadRunnable(db, root)).toEqual([]);
    expect(propose(db, baseSpec({ id: 'other' }))).toMatchObject({ ok: false, state: 'candidate', code: 'no_fixture' });
    expect(propose(db, baseSpec({ item: { selector: 'li:has(a)' } }))).toMatchObject({ ok: false, code: 'schema' });
    expect(existsSync(specPath(root, 'acme')!)).toBe(true);
    expect(propose(db, baseSpec({ id: '../x' }))).toMatchObject({ ok: false, code: 'schema' });
    expect(getProvider(db, '../x' as string)).toBeUndefined();
  });

  it('a re-proposal can fix a candidate, and a trusted or approved provider is refused', () => {
    const db = openDb(':memory:');
    fixture();
    expect(propose(db, baseSpec(), 4).ok).toBe(false);
    expect(propose(db).ok).toBe(true);
    approveProvider(db, 'acme', NOW, { force: true });
    expect(propose(db)).toMatchObject({ ok: false, code: 'exists' });
  });
});

describe('promotion to trusted', () => {
  const setup = () => { const db = openDb(':memory:'); fixture(); propose(db); return db; };
  const rec = (db: ReturnType<typeof openDb>, runId: string, clean = true) => recordProviderRun(db, 'acme', { runId, clean, promoteN: 3, now: NOW });

  it('two clean runs over one run id, or three clean runs over one id, do not promote', () => {
    const db = setup();
    rec(db, 'r1'); rec(db, 'r1');
    expect(getProvider(db, 'acme')!.state).toBe('validated');
    expect(rec(db, 'r1')).toBe('validated');
    expect(getProvider(db, 'acme')).toMatchObject({ clean_runs: 3, state: 'validated' });
  });
  it('three clean runs over two run ids promote', () => {
    const db = setup();
    rec(db, 'r1'); rec(db, 'r1');
    expect(rec(db, 'r2')).toBe('trusted');
    expect(getProvider(db, 'acme')!.state).toBe('trusted');
  });
  it('an unclean run resets the streak', () => {
    const db = setup();
    rec(db, 'r1'); rec(db, 'r2'); rec(db, 'r3', false);
    expect(getProvider(db, 'acme')).toMatchObject({ clean_runs: 0, state: 'validated' });
    rec(db, 'r4'); rec(db, 'r5');
    expect(getProvider(db, 'acme')!.state).toBe('validated');
    expect(rec(db, 'r6')).toBe('trusted');
  });
  it('a candidate is never counted', () => {
    const db = openDb(':memory:');
    fixture();
    propose(db, baseSpec(), 9);
    expect(rec(db, 'r1')).toBe('candidate');
    expect(getProvider(db, 'acme')!.clean_runs).toBe(0);
  });
  it('trusted does not mean approved: approval is a separate owner step', () => {
    const db = setup();
    rec(db, 'r1'); rec(db, 'r2'); rec(db, 'r3');
    expect(getProvider(db, 'acme')).toMatchObject({ state: 'trusted', approved: 0 });
  });
});

describe('held outreach for generated sources', () => {
  it('isHeldSource covers gen:* only', () => {
    expect(isHeldSource('gen:acme')).toBe(true);
    expect(isHeldSource('gen:custom')).toBe(true);
    for (const s of ['greenhouse', 'remotive', 'gen:', 'gen:../x', null, undefined, '']) expect(isHeldSource(s as string)).toBe(false);
  });

  it('enqueue marks a gen: row held_review, list_queued never returns it, approval releases it', () => {
    const db = openDb(':memory:');
    fixture(); propose(db);
    saveJob(db, job('gen:acme:1', 'gen:acme'));
    saveJob(db, job('gh:1', 'greenhouse'));
    saveJob(db, job('gen:other:1', 'gen:other'));
    const held = enqueue(db, 'gen:acme:1');
    const normal = enqueue(db, 'gh:1');
    const unknown = enqueue(db, 'gen:other:1');
    const status = (id: number) => (db.prepare('SELECT status FROM outreach_queue WHERE id = ?').get(id) as { status: string }).status;
    expect([status(held), status(normal), status(unknown)]).toEqual(['held_review', 'queued', 'held_review']);
    expect(listQueuedOutreach(db).map((r) => r.id)).toEqual([normal]);
    expect(approveProvider(db, 'acme', NOW, { force: true })).toEqual({ ok: true, released: 1 });
    expect(listQueuedOutreach(db).map((r) => r.id).sort()).toEqual([held, normal].sort());
    expect(status(unknown)).toBe('held_review');
    // after approval new rows are queued straight away
    saveJob(db, job('gen:acme:2', 'gen:acme'));
    expect(status(enqueue(db, 'gen:acme:2'))).toBe('queued');
  });

  it('a candidate cannot be approved; reject deletes the spec and skips held rows', () => {
    const db = openDb(':memory:');
    fixture(); propose(db, baseSpec(), 9);
    expect(approveProvider(db, 'acme', NOW, { force: true })).toMatchObject({ ok: false, code: 'not_validated' });
    expect(approveProvider(db, 'nope', NOW)).toMatchObject({ ok: false, code: 'unknown_provider' });
    propose(db);
    saveJob(db, job('gen:acme:1', 'gen:acme'));
    const id = enqueue(db, 'gen:acme:1');
    expect(rejectProvider(db, root, 'acme')).toEqual({ ok: true, skipped: 1 });
    expect(getProvider(db, 'acme')).toBeUndefined();
    expect(existsSync(specPath(root, 'acme')!)).toBe(false);
    expect((db.prepare('SELECT status FROM outreach_queue WHERE id = ?').get(id) as { status: string }).status).toBe('skipped');
  });
});

describe('runner integration', () => {
  const portals = (): string => {
    const f = path.join(root, 'portals.json');
    writeFileSync(f, JSON.stringify({ tracked_companies: [], title_filter: { positive: ['engineer', 'developer'], negative: ['backend'] }, location_filter: { allow: ['india'] } }));
    return f;
  };
  const registry = (): string => { const f = path.join(root, 'platforms.json'); writeFileSync(f, JSON.stringify({ platforms: [] })); return f; };
  const opts = (db: ReturnType<typeof openDb>, runId: string, html = LISTING) => runScriptSources(db, {
    role: 'engineer', portalsPath: portals(), registryPath: registry(), generatedRoot: root, runId, env: { GEN_PROVIDER_PROMOTE_N: '3' },
    generatedFetch: () => async () => html,
  });

  it('runs a validated provider like any provider: source gen:<id>, title filter applied, clean runs promote it', async () => {
    const db = openDb(':memory:');
    fixture(); propose(db);
    const r1 = await opts(db, 'run-1');
    expect(r1.jobs.map((j) => j.title)).toEqual(['Frontend Engineer', 'Full Stack Developer']);
    expect(r1.jobs.every((j) => j.source === 'gen:acme')).toBe(true);
    expect(r1.rows.find((x) => x.source === 'gen:acme')).toMatchObject({ kind: 'script', group: 'generated', fetched: 3, kept: 2, fallback_used: false, note: 'generated' });
    await opts(db, 'run-1');
    expect(getProvider(db, 'acme')!.state).toBe('validated');
    await opts(db, 'run-2');
    expect(getProvider(db, 'acme')).toMatchObject({ state: 'trusted', clean_runs: 3 });
  });

  it('a candidate is not run; a failing page marks fallback and queues a task and resets the streak', async () => {
    const db = openDb(':memory:');
    fixture(); propose(db, baseSpec(), 9);
    expect((await opts(db, 'r')).rows.find((x) => x.source === 'gen:acme')).toBeUndefined();
    propose(db);
    const r = await opts(db, 'r1', '<html><body>redesigned</body></html>');
    expect(r.jobs).toEqual([]);
    expect(r.rows.find((x) => x.source === 'gen:acme')).toMatchObject({ kept: 0 });
    expect(getProvider(db, 'acme')!.clean_runs).toBe(0);
    const bad = await runScriptSources(db, { role: 'x', portalsPath: portals(), registryPath: registry(), generatedRoot: root, runId: 'r2', generatedFetch: () => async () => { throw new Error('boom'); } });
    expect(bad.rows.find((x) => x.source === 'gen:acme')).toMatchObject({ fallback_used: true });
    expect(db.prepare("SELECT platform, reason FROM source_tasks WHERE platform = 'acme'").get()).toMatchObject({ reason: 'error' });
  });
});

describe('providers CLI', () => {
  it('list, show, validate, approve --promote and reject', () => {
    const db = openDb(':memory:');
    fixture(); propose(db);
    saveJob(db, job('gen:acme:1', 'gen:acme'));
    enqueue(db, 'gen:acme:1');
    const deps = { db, root, now: () => NOW, env: {} };
    expect(providersCli(['list'], deps).lines[0]).toMatch(/^acme  validated  held  clean 0\/3/);
    expect(providersCli(['show', 'acme'], deps).lines.join('\n')).toContain('"hosts"');
    expect(providersCli(['validate', 'acme'], deps)).toMatchObject({ code: 0 });
    const ap = providersCli(['approve', 'acme', '--promote', '--force'], deps);
    expect(ap.code).toBe(0);
    expect(ap.lines[1]).toContain('1 held outreach row(s) released');
    expect(ap.lines.join('\n')).toContain('"kind": "generated"');
    expect(providersCli(['approve', 'nope'], deps).code).toBe(1);
    expect(providersCli(['approve', '../x'], deps).code).toBe(2);
    expect(providersCli(['reject', 'acme'], deps).code).toBe(0);
    expect(providersCli(['list'], deps).lines).toEqual(['no generated providers']);
  });
});
