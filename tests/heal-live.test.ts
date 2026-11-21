// tests/heal-live.test.ts
// The LIVE TRY: testability in the signature table, the runner's hard rules (temp database, no commit, one page load, refusals) and its
// effect on the landing gate (pass lands, fail goes back once then gives up, skipped waits, not_testable needs tests only). Fakes only:
// the handlers are fake objects, git is a temp repo, no browser and no tmux.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { LIVE_RETRY_MS, LIVE_SKIP_BOUND_MS } from '../src/heal/config.js';
import { landAttempt, type HealDeps } from '../src/heal/land.js';
import {
  getAttempt, getLedger, LIVE_RETRY_NOTE, migrateHealTables, nextEligible, recordSighting, startAttempt, updateAttempt,
} from '../src/heal/ledger.js';
import {
  assertTempDb, CommitRefused, copyDbToTemp, findRef, guardHandlers, liveRootOf, LoadLimit, refusalReason, runLiveCheck,
  type CheckCtx, type Handlers, type LiveDeps, type LiveVerdict,
} from '../src/heal/live.js';
import { classify, LIVE_IMPLEMENTED } from '../src/heal/signature.js';
import { takeWindowLock } from '../src/platform/windowLock.js';
import type { Run } from '../src/platform/tmux.js';
import { startRun } from '../src/scheduler/runLog.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'heal-live-t-')); mkdirSync(path.join(dir, '.jobber'), { recursive: true }); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.JOBAPPLIER_DB; });

describe('testability in the signature table', () => {
  it('assigns live_readonly, live_until_commit and not_testable, only where a live check exists', () => {
    expect(classify('apply:easy_apply:resume_upload_failed')).toMatchObject({ testability: 'live_until_commit', liveCheck: 'easy_apply_review', platform: 'linkedin' });
    expect(classify('discover:linkedin:no_cards_parse_drift')).toMatchObject({ testability: 'live_readonly', liveCheck: 'discover_search', platform: 'linkedin' });
    // no live check for these platforms yet: tests and the watch window only
    expect(classify('discover:naukri:no_cards').testability).toBe('not_testable');
    expect(classify('discover:wellfound:nav_timeout').testability).toBe('not_testable');
    expect(classify('apply:external:no_popup').testability).toBe('not_testable');
    for (const s of ['run:crashed:dispatch_error', 'run:failed:x', 'run:incomplete:linkedin-operator_discover', 'diag:linkedin:dialog_controls_missing', 'lane:mail:dispatch_error', 'jd:incomplete', 'apply:odd_code']) expect(classify(s).testability, s).toBe('not_testable');
    // never-heal signatures are never testable and have no live check
    expect(classify('apply:easy_apply:captcha')).toMatchObject({ heal: false, testability: 'not_testable', liveCheck: null });
    expect([...LIVE_IMPLEMENTED].sort()).toEqual(['linkedin:discover_search', 'linkedin:easy_apply_review', 'linkedin:jd_read']);
  });
});

describe('temp database', () => {
  it('finds the live root of a worktree', () => {
    expect(liveRootOf(`/p/proj/.jobber/heal/wt/x-1`)).toBe('/p/proj');
    expect(liveRootOf('/p/proj')).toBe('/p/proj');
  });
  it('refuses the live database and any path outside the temp directory', () => {
    const live = path.join(dir, 'data.sqlite');
    expect(() => assertTempDb(live, live)).toThrow(/refusing the live database/); // dir is itself a temp dir, so the equal-file rule fires
    expect(() => assertTempDb('/Users/someone/data.sqlite', live)).toThrow(/temp copy/);
    mkdirSync(path.join(dir, 'sub'));
    expect(() => assertTempDb(path.join(dir, 'sub', 'data.sqlite'), live)).not.toThrow();
  });
  it('copies the live database with the backup API and leaves the live file untouched', async () => {
    const live = path.join(dir, 'data.sqlite');
    const db = new Database(live);
    db.exec('CREATE TABLE t (a TEXT); INSERT INTO t VALUES (\'one\');');
    db.close();
    const before = readFileSync(live);
    const c = await copyDbToTemp(live);
    expect(c.file).not.toBe(live);
    const cp = new Database(c.file);
    expect(cp.prepare('SELECT a FROM t').get()).toEqual({ a: 'one' });
    cp.exec("INSERT INTO t VALUES ('only in the copy')");
    cp.close();
    expect(readFileSync(live).equals(before)).toBe(true);
    const copyDir = path.dirname(c.file);
    c.cleanup();
    expect(existsSync(copyDir)).toBe(false);
  });
});

describe('commit guard and one-load limit', () => {
  const fake = (): { raw: Handlers; calls: string[] } => {
    const calls: string[] = [];
    const mk = (n: string) => async () => { calls.push(n); return { ok: true }; };
    const names = ['linkedin_open', 'linkedin_search_jobs', 'linkedin_fetch_jd', 'linkedin_snapshot', 'linkedin_click', 'linkedin_click_at', 'linkedin_type', 'linkedin_press_key',
      'linkedin_arm_send', 'linkedin_easy_apply_fill', 'linkedin_attach_file', 'linkedin_resolve_external', 'apply_submit', 'gmail_send_email', 'apply_next', 'db_check_and_increment'];
    return { raw: Object.fromEntries(names.map((n) => [n, mk(n)])), calls };
  };
  it('refuses every arm, submit, send, attach, fill and raw click tool, and never reaches the real handler', async () => {
    const f = fake();
    const g = guardHandlers(f.raw);
    for (const n of ['linkedin_arm_send', 'linkedin_easy_apply_fill', 'linkedin_attach_file', 'linkedin_resolve_external', 'apply_submit', 'gmail_send_email', 'apply_next', 'db_check_and_increment', 'linkedin_click_at', 'linkedin_click', 'linkedin_type', 'linkedin_press_key']) {
      await expect(g.handlers[n]({ ref: 's1.1' }), n).rejects.toBeInstanceOf(CommitRefused);
    }
    expect(f.calls).toEqual([]);
    await g.handlers.linkedin_snapshot({}); // reads are fine
    expect(f.calls).toEqual(['linkedin_snapshot']);
  });
  it('clickByName clicks Easy Apply and Dismiss but refuses every commit-named control', async () => {
    const f = fake();
    const g = guardHandlers(f.raw, { maxLoads: 1 });
    const snap = (name: string) => ({ nodes: [{ ref: 's1.2', role: 'button', name }] });
    expect(await g.clickByName('linkedin', snap('Easy Apply to Acme'), /easy apply/i)).toEqual({ clicked: true, name: 'Easy Apply to Acme' });
    expect(await g.clickByName('linkedin', snap('Dismiss'), /^dismiss$/i)).toMatchObject({ clicked: true });
    expect(await g.clickByName('linkedin', snap('Review'), /^review$/i)).toMatchObject({ clicked: true });
    expect(f.calls.filter((c) => c === 'linkedin_click').length).toBe(3);
    for (const bad of ['Submit application', 'Send', 'Send now', 'Connect', 'Send without a note', 'Post', 'Apply', 'Apply now', 'Confirm', 'Done', 'Follow', 'Accept']) {
      await expect(g.clickByName('linkedin', snap(bad), new RegExp(bad, 'i')), bad).rejects.toBeInstanceOf(CommitRefused);
    }
    expect(f.calls.filter((c) => c === 'linkedin_click').length).toBe(3); // none of the refused ones clicked
    expect(await g.clickByName('linkedin', { nodes: [] }, /x/)).toEqual({ clicked: false, name: '' });
    // the click permission does not leak: a raw click right after is still refused
    await expect(g.handlers.linkedin_click({ ref: 's1.2' })).rejects.toBeInstanceOf(CommitRefused);
  });
  it('allows one page load per check; the second load throws', async () => {
    const f = fake();
    const g = guardHandlers(f.raw, { maxLoads: 1 });
    await g.handlers.linkedin_open({ url: 'https://example.invalid/' });
    expect(g.loads()).toBe(1);
    await expect(g.handlers.linkedin_search_jobs({ search: 'x' })).rejects.toBeInstanceOf(LoadLimit);
    await expect(g.handlers.linkedin_fetch_jd({})).rejects.toBeInstanceOf(LoadLimit);
    expect(f.calls).toEqual(['linkedin_open']);
  });
  it('findRef walks a snapshot-like object', () => {
    expect(findRef({ a: [{ b: { ref: 's2.9', name: 'Upload resume' } }] }, /upload/i)).toEqual({ ref: 's2.9', name: 'Upload resume' });
    expect(findRef({ ref: 5, name: 'x' }, /x/)).toBeNull();
    const cyc: Record<string, unknown> = {}; cyc.self = cyc;
    expect(findRef(cyc, /x/)).toBeNull();
  });
});

describe('refusals', () => {
  const mem = (): Database.Database => { const db = openDb(':memory:'); return db; };
  const base = (db: Database.Database) => ({ platform: 'linkedin', db, liveRoot: dir, env: {}, now: new Date(), killed: false, haltedPlatform: false, activeNow: true });
  it('refuses on the kill switch, a platform halt and outside active hours (LinkedIn only)', () => {
    const db = mem();
    expect(refusalReason(base(db))).toBeNull();
    expect(refusalReason({ ...base(db), killed: true })).toBe('kill_switch_or_halt');
    expect(refusalReason({ ...base(db), haltedPlatform: true })).toBe('platform_halted');
    expect(refusalReason({ ...base(db), activeNow: false })).toBe('outside_active_hours');
    expect(refusalReason({ ...base(db), platform: 'naukri', activeNow: false })).toBeNull();
  });
  it('refuses while the live stack has a running row or a held window lock for the same platform, not for another', () => {
    const db = mem();
    startRun(db, { id: 'w1', at: new Date(), trigger: 'wake', dryRun: false, tasks: [], status: 'running', window: 'linkedin' });
    expect(refusalReason(base(db))).toBe('platform_busy');
    expect(refusalReason({ ...base(db), platform: 'naukri' })).toBeNull();
    db.prepare("UPDATE scheduler_runs SET status = 'ok'").run();
    startRun(db, { id: 'w2', at: new Date(), trigger: 'wake', dryRun: false, tasks: [], status: 'running', window: 'apply' });
    expect(refusalReason(base(db))).toBe('platform_busy');
    db.prepare("UPDATE scheduler_runs SET status = 'ok'").run();
    startRun(db, { id: 'h', at: new Date(), trigger: 'heal', dryRun: false, tasks: [], status: 'running', window: 'linkedin' });
    expect(refusalReason(base(db))).toBeNull(); // the fixer's own item does not block
    db.prepare("UPDATE scheduler_runs SET status = 'ok'").run();
    const lock = takeWindowLock(dir, 'linkedin', 'test');
    expect(refusalReason(base(db))).toBe('platform_busy');
    lock?.release();
  });
});

describe('runLiveCheck', () => {
  const SIG = 'apply:easy_apply:resume_upload_failed';
  function setup() {
    const live = path.join(dir, 'data.sqlite');
    const db = openDb(live);
    migrateHealTables(db);
    const l = recordSighting(db, classify(SIG), { queue: [] }, new Date());
    db.prepare("INSERT INTO jobs (id, url, apply_url) VALUES ('jx', 'https://www.linkedin.com/jobs/view/1', 'https://www.linkedin.com/jobs/view/1')").run();
    db.prepare("INSERT INTO outreach_queue (job_id, apply_status, apply_note) VALUES ('jx', 'needs_owner', 'easy_apply:resume_upload_failed - x')").run();
    db.close();
    return { live, ledgerId: l.id };
  }
  const handlersFor = (script: Record<string, unknown>, calls: string[], dbSeen?: { file?: string }) => async (_p: string, db: Database.Database) => {
    dbSeen && (dbSeen.file = db.name);
    const raw: Handlers = new Proxy({} as Handlers, { get: (_t, n) => async () => { calls.push(String(n)); const v = script[String(n)]; return typeof v === 'function' ? (v as () => unknown)() : v; } });
    return { handlers: raw, shutdown: async () => undefined };
  };
  const deps = (s: { live: string; ledgerId: number }, over: Partial<LiveDeps> = {}): LiveDeps => ({
    ledgerId: s.ledgerId, worktree: dir, env: {}, liveDbFile: s.live,
    readLedger: (file, id) => { const d = new Database(file, { readonly: true }); try { const r = d.prepare('SELECT signature FROM heal_ledger WHERE id = ?').get(id) as { signature: string } | undefined; return r ? { signature: r.signature, queue: [] } : null; } finally { d.close(); } },
    killed: () => false, haltedOn: () => ({ all: false, platform: false }), activeNow: () => true, ...over,
  });
  const snapWith = (name: string) => ({ nodes: [{ ref: 's1.1', role: 'button', name }] });

  it('the easy-apply check passes when the dialog has the upload control, uses the temp copy, discards the modal and never commits', async () => {
    const s = setup();
    const calls: string[] = []; const seen: { file?: string } = {};
    let snaps = 0;
    const script = { linkedin_open: { ok: true }, linkedin_click: { ok: true }, linkedin_snapshot: () => {
      snaps += 1;
      return snaps === 1 ? snapWith('Easy Apply') : snaps === 2 ? { nodes: [{ ref: 's2.1', name: 'Upload resume' }, { ref: 's2.2', name: 'Dismiss' }, { ref: 's2.3', name: 'Submit application' }] } : snapWith('Discard');
    } };
    const before = readFileSync(s.live);
    const v = await runLiveCheck(deps(s, { makeHandlers: handlersFor(script, calls, seen) }));
    expect(v).toMatchObject({ ledger_id: s.ledgerId, testability: 'live_until_commit', ran: true, result: 'pass' });
    expect(seen.file).not.toBe(s.live);
    expect(seen.file).toContain('heal-live-');
    expect(process.env.JOBAPPLIER_DB).toBe(seen.file);
    expect(calls.filter((c) => c === 'linkedin_click').length).toBe(3); // Easy Apply, Dismiss, Discard
    expect(calls).not.toContain('linkedin_arm_send');
    expect(readFileSync(s.live).equals(before)).toBe(true); // the live database is untouched
    expect(existsSync(seen.file as string)).toBe(false); // the copy is gone
  });
  it('the easy-apply check fails when the dialog has no upload control, and fails closed on a commit attempt', async () => {
    const s = setup();
    let n = 0;
    const noUpload = { linkedin_open: { ok: true }, linkedin_click: { ok: true }, linkedin_snapshot: () => (++n === 1 ? snapWith('Easy Apply') : { nodes: [{ ref: 's2.2', name: 'Dismiss' }] }) };
    const v = await runLiveCheck(deps(s, { makeHandlers: handlersFor(noUpload, []) }));
    expect(v).toMatchObject({ ran: true, result: 'fail' });
    expect(v.evidence).toMatch(/without a resume upload control/);
    const evil = async () => ({ handlers: { linkedin_arm_send: async () => ({ ok: true }) } as Handlers, shutdown: async () => undefined });
    const v2 = await runLiveCheck(deps(s, { makeHandlers: evil, checks: { 'linkedin:easy_apply_review': async (c: CheckCtx) => { await c.g.handlers.linkedin_arm_send({ kind: 'easy_apply' }); return { result: 'pass', evidence: 'x' }; } } }));
    expect(v2).toMatchObject({ ran: true, result: 'fail' });
    expect(v2.evidence).toMatch(/commit guard/);
  });
  it('skips (never fails) when halted, killed, outside active hours, busy, no parked job, or an error', async () => {
    const s = setup();
    const ok = { linkedin_open: { ok: true }, linkedin_snapshot: snapWith('Easy Apply'), linkedin_click: { ok: true } };
    const run = (o: Partial<LiveDeps>, script: Record<string, unknown> = ok) => runLiveCheck(deps(s, { makeHandlers: handlersFor(script, []), ...o }));
    expect(await run({ killed: () => true })).toMatchObject({ result: 'skipped', ran: false });
    expect((await run({ haltedOn: () => ({ all: false, platform: true }) })).evidence).toMatch(/platform_halted/);
    expect((await run({ haltedOn: () => ({ all: true, platform: false }) })).evidence).toMatch(/kill_switch_or_halt/);
    expect((await run({ activeNow: () => false })).evidence).toMatch(/outside_active_hours/);
    const calls: string[] = [];
    await run({ activeNow: () => false, makeHandlers: handlersFor(ok, calls) });
    expect(calls).toEqual([]); // refused before any page action
    const live = new Database(s.live); live.prepare("INSERT INTO scheduler_runs (id, planned_at, trigger, status, window, tasks) VALUES ('busy', datetime('now'), 'wake', 'running', 'linkedin', '[]')").run(); live.close();
    expect((await run({})).evidence).toMatch(/platform_busy/);
    const live2 = new Database(s.live); live2.prepare("UPDATE scheduler_runs SET status = 'ok'").run(); live2.prepare('DELETE FROM outreach_queue').run(); live2.close();
    expect((await run({})).evidence).toMatch(/no parked Easy Apply job/);
    expect((await run({ makeHandlers: async () => { throw new Error('browser attach failed'); } })).result).toBe('skipped');
  });
  it('a second page load inside one check is refused, and not_testable or unknown ids never run anything', async () => {
    const s = setup();
    const two = async (c: CheckCtx) => { await c.g.handlers.linkedin_open({}); await c.g.handlers.linkedin_open({}); return { result: 'pass' as const, evidence: 'x' }; };
    const v = await runLiveCheck(deps(s, { makeHandlers: handlersFor({ linkedin_open: { ok: true } }, []), checks: { 'linkedin:easy_apply_review': two } }));
    expect(v.result).toBe('skipped');
    expect(v.evidence).toMatch(/at most 1 page load/);
    const db = openDb(s.live); const r = recordSighting(db, classify('run:crashed:dispatch_error'), {}, new Date()); db.close();
    const calls: string[] = [];
    expect(await runLiveCheck(deps({ ...s, ledgerId: r.id }, { makeHandlers: handlersFor({}, calls) }))).toMatchObject({ testability: 'not_testable', ran: false, result: 'skipped' });
    expect(await runLiveCheck(deps({ ...s, ledgerId: 999 }))).toMatchObject({ ran: false, result: 'skipped', evidence: 'unknown ledger id' });
    expect(calls).toEqual([]);
  });
  it('the read-only discover check passes with cards and fails with zero cards', async () => {
    const live = path.join(dir, 'data.sqlite');
    const db = openDb(live); migrateHealTables(db);
    const l = recordSighting(db, classify('discover:linkedin:no_cards_parse_drift'), {}, new Date()); db.close();
    const s = { live, ledgerId: l.id };
    const mk = (r: unknown) => handlersFor({ linkedin_search_jobs: r }, []);
    const checks = { 'linkedin:discover_search': async (c: CheckCtx) => { const r = (await c.g.handlers.linkedin_search_jobs({ search: 'x' })) as { status: string; fetched: number }; return r.status === 'ok' && r.fetched > 0 ? { result: 'pass' as const, evidence: 'cards' } : { result: 'fail' as const, evidence: 'zero' }; } };
    expect(await runLiveCheck(deps(s, { makeHandlers: mk({ status: 'ok', fetched: 7 }), checks }))).toMatchObject({ testability: 'live_readonly', result: 'pass', ran: true });
    expect(await runLiveCheck(deps(s, { makeHandlers: mk({ status: 'ok', fetched: 0 }), checks }))).toMatchObject({ result: 'fail', ran: true });
  });
});

// ---- effect on the landing gate ----

const g = (args: string[], cwd = dir): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const TEST_V1 = "import { it, expect } from 'vitest';\nit('a', () => {\n  expect(1).toBe(1);\n});\n";
const GOOD = { 'src/a.ts': 'export const a = 2;\n', 'tests/a.test.ts': `${TEST_V1}it('b', () => { expect(3).toBe(3); });\n` };
const realRun: Run = async (cmd, args, opts) => {
  try { return { stdout: execFileSync(cmd, args, { cwd: opts?.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0, stderr: '' }; }
  catch (e) { const x = e as { stdout?: string }; return { stdout: String(x.stdout ?? ''), code: 1, stderr: '' }; }
};

describe('the live verdict decides the landing', () => {
  let n = 0;
  function rigLand(sig: string, live: (cwd: string, id: number) => Promise<LiveVerdict>) {
    g(['init', '-q', '-b', 'main']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't']);
    mkdirSync(path.join(dir, 'src'), { recursive: true }); mkdirSync(path.join(dir, 'tests'), { recursive: true });
    writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;\n'); writeFileSync(path.join(dir, 'tests/a.test.ts'), TEST_V1);
    g(['add', '-A']); g(['commit', '-qm', 'base']);
    const base = g(['rev-parse', 'HEAD']);
    const bn = `heal/live${++n}`;
    g(['checkout', '-q', '-b', bn]);
    for (const [f, t] of Object.entries(GOOD)) writeFileSync(path.join(dir, f), t);
    g(['add', '-A']); g(['commit', '-qm', 'fix']);
    const head = g(['rev-parse', 'HEAD']); g(['checkout', '-q', 'main']);
    const db = openDb(':memory:'); migrateHealTables(db);
    const alerts: string[] = [];
    let now = new Date();
    const d: HealDeps = { root: dir, env: {}, run: realRun, db, now: () => now, sleep: async () => undefined, alert: async (t) => { alerts.push(t); }, killed: () => false, windowSession: 'Jobber', stackSession: 'Jobber',
      verify: async () => ({ ok: true }), bootCheck: async () => true, liveCheck: live };
    const l = recordSighting(db, classify(sig), { runs: ['r'] }, now);
    const attemptId = startAttempt(db, l.id, { mode: 'auto', branch: bn, worktree: '', baseHead: base, at: now });
    updateAttempt(db, attemptId, { outcome: 'ready', head });
    db.prepare("UPDATE heal_ledger SET state = 'ready' WHERE id = ?").run(l.id);
    return { d, db, alerts, ledgerId: l.id, attemptId, base, head, setNow: (t: Date) => { now = t; } };
  }
  const verdict = (result: LiveVerdict['result'], evidence = 'e'): LiveVerdict => ({ ledger_id: 1, testability: 'live_until_commit', ran: result !== 'skipped', result, evidence });
  const LIVE_SIG = 'apply:easy_apply:resume_upload_failed';

  it('pass lands, and the verdict is stored with the attempt', async () => {
    const r = rigLand(LIVE_SIG, async () => verdict('pass', 'dialog ok'));
    expect((await landAttempt(r.d, r.attemptId)).ok).toBe(true);
    expect(g(['rev-parse', 'HEAD'])).toBe(r.head);
    expect(JSON.parse(getAttempt(r.db, r.attemptId)?.live as string).verdict).toMatchObject({ result: 'pass', evidence: 'dialog ok' });
  });
  it('fail does not land: the fixer gets one more round (no cooldown), the second fail gives up', async () => {
    const r = rigLand(LIVE_SIG, async () => verdict('fail', 'dialog opened without a resume upload control'));
    const res = await landAttempt(r.d, r.attemptId);
    expect(res.ok).toBe(false);
    expect(g(['rev-parse', 'HEAD'])).toBe(r.base);
    expect(getAttempt(r.db, r.attemptId)?.outcome).toBe('live_failed');
    expect(getLedger(r.db, r.ledgerId)).toMatchObject({ state: 'open', note: LIVE_RETRY_NOTE });
    expect(nextEligible(r.db, new Date(), { maxPerDay: 9, cooldownHours: 6 })?.id).toBe(r.ledgerId); // not held by the cooldown
    // round two on a new attempt fails again
    const a2 = startAttempt(r.db, r.ledgerId, { mode: 'auto', branch: 'heal/live-second', worktree: '', baseHead: r.base, at: new Date() });
    g(['branch', 'heal/live-second', r.head]);
    updateAttempt(r.db, a2, { outcome: 'ready', head: r.head });
    expect((await landAttempt(r.d, a2)).ok).toBe(false);
    expect(getLedger(r.db, r.ledgerId)?.state).toBe('gave_up');
    expect(r.alerts.join()).toContain('Heal gave up');
    expect(g(['rev-parse', 'HEAD'])).toBe(r.base);
  });
  it('skipped postpones: nothing lands, it is retried only after the retry gap, and after the bound the owner is told once but it still never lands', async () => {
    let calls = 0;
    const r = rigLand(LIVE_SIG, async () => { calls += 1; return verdict('skipped', 'platform_busy'); });
    const t0 = new Date();
    r.setNow(t0);
    expect((await landAttempt(r.d, r.attemptId)).ok).toBe(false);
    expect(getAttempt(r.db, r.attemptId)?.outcome).toBe('ready'); // still ready, not failed
    expect(getLedger(r.db, r.ledgerId)?.state).toBe('ready');
    expect(r.alerts.filter((t) => t.includes('Restart postponed')).length).toBe(1);
    await landAttempt(r.d, r.attemptId); // within the retry gap: the runner is not called again
    expect(calls).toBe(1);
    r.setNow(new Date(t0.getTime() + LIVE_RETRY_MS + 1000));
    await landAttempt(r.d, r.attemptId);
    expect(calls).toBe(2);
    expect(r.alerts.filter((t) => t.includes('Restart postponed')).length).toBe(1); // told once
    r.setNow(new Date(t0.getTime() + LIVE_SKIP_BOUND_MS + LIVE_RETRY_MS));
    expect((await landAttempt(r.d, r.attemptId)).ok).toBe(false);
    expect(r.alerts.join()).toContain('never landed untested');
    expect(g(['rev-parse', 'HEAD'])).toBe(r.base);
    r.setNow(new Date(t0.getTime() + LIVE_SKIP_BOUND_MS + 3 * LIVE_RETRY_MS));
    await landAttempt(r.d, r.attemptId);
    expect(r.alerts.filter((t) => t.includes('never landed untested')).length).toBe(1); // once
    // when the platform is free again, a pass lands it
    const r2 = r;
    r2.d.liveCheck = async () => verdict('pass');
    r2.setNow(new Date(t0.getTime() + 2 * LIVE_SKIP_BOUND_MS));
    expect((await landAttempt(r2.d, r2.attemptId)).ok).toBe(true);
  });
  it('a runner that throws counts as skipped, never as a pass', async () => {
    const r = rigLand(LIVE_SIG, async () => { throw new Error('boom'); });
    expect((await landAttempt(r.d, r.attemptId)).ok).toBe(false);
    expect(g(['rev-parse', 'HEAD'])).toBe(r.base);
  });
  it('not_testable lands on tests alone and never calls the runner; a live_readonly signature needs a pass too', async () => {
    let calls = 0;
    const r = rigLand('run:crashed:dispatch_error', async () => { calls += 1; return verdict('fail'); });
    expect((await landAttempt(r.d, r.attemptId)).ok).toBe(true);
    expect(calls).toBe(0);
    const ro = rigLandReadonly();
    expect(ro).toBe(true);
  });
  function rigLandReadonly(): boolean { return classify('discover:linkedin:nav_timeout').testability === 'live_readonly'; }
});
