// tests/heal-core.test.ts
// Self-heal: signature mapping, the never-heal list, detection, ledger (dedupe, cooldown, daily cap, lock), the work item, config and the
// window declaration. Fakes and a temp project only; nothing live.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { healCooldownHours, healMaxPerDay, healMode, healWatchMin } from '../src/heal/config.js';
import { failureOfQueueRow, failureOfRun, ingestFailures } from '../src/heal/detect.js';
import {
  attemptsLast24h, getLedgerBySignature, ignoreSignature, inCooldown, migrateHealTables, nextEligible, recordSighting, releaseStaleHealing,
  setLedgerState, startAttempt, takeHealLock, updateAttempt,
} from '../src/heal/ledger.js';
import { composeNotice } from '../src/heal/notice.js';
import { classify, NEVER, normalizeCode, QUALIFYING, signatureOf, signatureSlug } from '../src/heal/signature.js';
import { buildFixerPrompt, parseFixerReport } from '../src/heal/workItem.js';
import { loadManagerConfig, guard } from '../src/platform/manager.js';
import { ENV_CATALOG } from '../src/settings/envCatalog.js';
import { finishRun, setState, startRun } from '../src/scheduler/runLog.js';

const ROOT = process.cwd();
let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'heal-core-')); mkdirSync(path.join(dir, '.jobber'), { recursive: true }); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const NOW = new Date('2026-11-21T12:00:00Z');
const ago = (min: number): Date => new Date(NOW.getTime() - min * 60_000);

describe('signature mapping', () => {
  it('maps failures to area:code signatures', () => {
    expect(signatureOf({ area: 'apply', code: 'easy_apply:resume_upload_failed - detail text' }).startsWith('apply:easy_apply:resume_upload_failed')).toBe(true);
    expect(signatureOf({ area: 'discover', code: 'no_cards_parse_drift', platform: 'linkedin' })).toBe('discover:linkedin:no_cards_parse_drift');
    expect(signatureOf({ area: 'jd', code: 'incomplete' })).toBe('jd:incomplete');
    expect(signatureOf({ area: 'run', code: 'crashed:dispatch_error' })).toBe('run:crashed:dispatch_error');
  });
  it('folds ids and long numbers so one defect is one signature', () => {
    expect(normalizeCode('failed: run 123456 abcdef0123456789')).toBe('failed:_run_#_#');
    expect(signatureOf({ area: 'run', code: 'incomplete:5. linkedin discover' })).toBe(signatureOf({ area: 'run', code: 'incomplete:7. linkedin discover' }).replace('7.', '5.'));
    expect(normalizeCode('')).toBe('unknown');
    expect(normalizeCode('x'.repeat(500)).length).toBeLessThanOrEqual(80);
    expect(signatureSlug('apply:easy_apply:resume_upload_failed')).toBe('apply-easy-apply-resume-upload-failed');
  });
  it('maps a run row: crashed, failed, incomplete with the unproven step, ok with a discovery marker', () => {
    const r = { id: 'r', planned_at: 'x', trigger: 'wake', status: 'crashed', stop_reason: 'dispatch_error', window: 'linkedin', summary: null };
    expect(signatureOf(failureOfRun(r) as never)).toBe('run:crashed:dispatch_error');
    expect(signatureOf(failureOfRun({ ...r, status: 'incomplete', stop_reason: 'linkedin: incomplete (incomplete: unproven steps: 5. linkedin-operator discover (not continued))' }) as never)).toContain('run:incomplete:linkedin-operator_discover');
    expect(signatureOf(failureOfRun({ ...r, status: 'ok', stop_reason: null, summary: 'discover done 0, nav_timeout on the jobs page' }) as never)).toBe('discover:linkedin:nav_timeout');
    expect(failureOfRun({ ...r, status: 'ok', stop_reason: null, summary: 'all fine' })).toBeNull();
  });
  it('maps queue rows by apply_note code, and keeps needs_human and needs_answer visible as such', () => {
    expect(signatureOf(failureOfQueueRow('needs_owner', 'easy_apply:resume_upload_failed - x', 'linkedin'))).toContain('easy_apply:resume_upload_failed');
    expect(classify(failureOfQueueRow('needs_human', 'assist:captcha', 'naukri')).heal).toBe(false);
    expect(classify(failureOfQueueRow('needs_answer', null, 'naukri')).heal).toBe(false);
  });
});

describe('qualifying table and the never-heal list', () => {
  it('qualifies code-defect-like signatures, with a reason each', () => {
    for (const s of ['apply:easy_apply:resume_upload_failed', 'discover:no_cards_parse_drift', 'discover:linkedin:nav_timeout', 'jd:incomplete', 'jd:pending_stuck',
      'run:crashed:dispatch_error', 'run:failed:boom', 'run:incomplete:linkedin-operator_discover', 'diag:linkedin:dialog_controls_missing', 'lane:mail:dispatch_error', 'apply:external:no_popup']) {
      const v = classify(s);
      expect(v.heal, s).toBe(true);
      expect(v.reason.length).toBeGreaterThan(3);
    }
    expect(classify('apply:easy_apply:resume_upload_failed').requeueSafe).toBe(true);
    expect(classify('run:crashed:dispatch_error').requeueSafe).toBe(false);
    for (const q of QUALIFYING) expect(q.reason).toBeTruthy();
    for (const n of NEVER) expect(n.reason).toBeTruthy();
  });
  it('never heals human walls, questions, outages, halts and every safety gate refusal', () => {
    const never = [
      'apply:needs_human:assist:captcha', 'apply:external:captcha', 'discover:linkedin:login_wall', 'apply:needs_answer:agent_handle', 'run:failed:api_error',
      'run:failed:failed_usage_limit', 'run:incomplete:usage_backoff', 'run:failed:http_503', 'discover:network_offline', 'discover:linkedin:econnreset',
      'run:crashed:orphaned', 'run:incomplete:stalled', 'run:incomplete:no_transcript', 'run:incomplete:window_unavailable:not_claude', 'run:failed:killed',
      'run:incomplete:halted', 'apply:veto:hard_stop', 'apply:fact_gate_blocked', 'apply:output_gate', 'apply:classifier_blocked', 'apply:injection_suspect',
      'apply:daily_limit_reached', 'apply:ceiling_reached', 'discover:linkedin:note_quota_exhausted', 'lane:mail:send_window', 'lane:mail:quiet_hours',
      'apply:unknown_apply_host', 'apply:unsafe_apply_page', 'apply:submitted', 'run:ok', 'apply:needs_human:mfa', 'apply:otp_required',
    ];
    for (const s of never) expect(classify(s).heal, s).toBe(false);
  });
  it('a signature in neither table is not healed; never wins over a qualifying match', () => {
    expect(classify('weird:thing')).toMatchObject({ heal: false, reason: 'not in the qualifying table' });
    expect(classify('apply:easy_apply:resume_upload_failed_captcha').heal).toBe(false);
    expect(classify('discover:linkedin:no_cards_after_login').heal).toBe(false);
  });
});

describe('detection into the ledger', () => {
  it('records failed, crashed and incomplete runs, queue rows, diag files, lane refusals and a stuck jd; deduped by signature', () => {
    const db = openDb(':memory:');
    migrateHealTables(db);
    const add = (id: string, status: string, stop: string, win = 'linkedin'): void => {
      startRun(db, { id, at: ago(30), trigger: 'wake', dryRun: false, tasks: [], status: 'running', window: win });
      finishRun(db, id, { at: ago(20), status: status as never, stopReason: stop });
    };
    add('a1', 'crashed', 'dispatch_error');
    add('a2', 'crashed', 'dispatch_error');
    add('a3', 'failed', 'api_error');
    add('a4', 'ok', '');
    db.prepare("INSERT INTO outreach_queue (job_id, apply_platform, apply_status, apply_note, updated_at) VALUES ('j1','linkedin','needs_owner','easy_apply:resume_upload_failed - x', datetime('now'))").run();
    mkdirSync(path.join(dir, '.jobber', 'diag'));
    writeFileSync(path.join(dir, '.jobber', 'diag', 'linkedin-2026.json'), JSON.stringify({ platform: 'linkedin', code: 'dialog_controls_missing' }));
    setState(db, 'drip_last_refusal_mail', JSON.stringify({ at: new Date().toISOString(), reason: 'dispatch_error' }), new Date());
    for (let i = 0; i < 5; i++) db.prepare("INSERT INTO jobs (id, status, created_at) VALUES (?, 'jd_pending', datetime('now', '-3 days'))").run(`jd${i}`);
    ingestFailures(db, dir, new Date());
    const sig = (s: string) => getLedgerBySignature(db, s);
    expect(sig('run:crashed:dispatch_error')).toMatchObject({ count: 2, state: 'open', verdict: 'heal' });
    expect(sig('run:failed:api_error')).toMatchObject({ state: 'ignored', verdict: 'never' });
    expect(sig('apply:easy_apply:resume_upload_failed')).toMatchObject({ state: 'open', requeue_safe: 1 });
    expect(sig('diag:linkedin:dialog_controls_missing')?.state).toBe('open');
    expect(sig('lane:mail:dispatch_error')?.state).toBe('open');
    expect(sig('jd:pending_stuck')?.state).toBe('open');
    // a second scan counts nothing twice
    const before = sig('run:crashed:dispatch_error')?.count;
    ingestFailures(db, dir, new Date());
    expect(sig('run:crashed:dispatch_error')?.count).toBe(before);
    expect(sig('jd:pending_stuck')?.count).toBe(1);
  });
  it('last_seen is the time of the failing row, not of the scan', () => {
    const db = openDb(':memory:');
    startRun(db, { id: 'z', at: ago(100), trigger: 'wake', dryRun: false, tasks: [], status: 'running' });
    finishRun(db, 'z', { at: ago(90), status: 'failed', stopReason: 'boom' });
    ingestFailures(db, dir, NOW);
    expect(Date.parse(getLedgerBySignature(db, 'run:failed:boom')?.last_seen as string)).toBe(ago(90).getTime());
  });
});

describe('ledger: dedupe, cooldown, daily cap, single flight', () => {
  const setup = () => { const db = openDb(':memory:'); migrateHealTables(db); return db; };
  const open = (db: ReturnType<typeof setup>, sig: string) => recordSighting(db, classify(sig), { runs: ['r'] }, NOW);
  const lim = { maxPerDay: 3, cooldownHours: 6 };
  it('dedupes by signature and bounds the evidence list', () => {
    const db = setup();
    for (let i = 0; i < 30; i++) recordSighting(db, classify('run:failed:x'), { runs: [`r${i}`] }, NOW);
    const l = getLedgerBySignature(db, 'run:failed:x');
    expect(l?.count).toBe(30);
    expect(JSON.parse(l?.evidence as string).runs.length).toBe(10);
  });
  it('cooldown: the same signature waits after an attempt', () => {
    const db = setup();
    const l = open(db, 'run:failed:x');
    const a = startAttempt(db, l.id, { mode: 'auto', branch: 'heal/x', worktree: 'w', baseHead: 'abc1234', at: ago(60) });
    updateAttempt(db, a, { outcome: 'abandoned' });
    setLedgerState(db, l.id, 'open');
    expect(inCooldown(db, l.id, NOW, 6)).toBe(true);
    expect(nextEligible(db, NOW, lim)).toBeNull();
    expect(nextEligible(db, new Date(NOW.getTime() + 6 * 3_600_000), lim)?.id).toBe(l.id);
  });
  it('daily cap: no more than HEAL_MAX_PER_DAY attempts in 24 h over all signatures', () => {
    const db = setup();
    for (let i = 0; i < 3; i++) { const l = open(db, `run:failed:s${i}`); const a = startAttempt(db, l.id, { mode: 'auto', branch: `b${i}`, worktree: 'w', baseHead: 'abc1234', at: ago(30) }); updateAttempt(db, a, { outcome: 'abandoned' }); setLedgerState(db, l.id, 'gave_up'); }
    open(db, 'run:failed:fresh');
    expect(attemptsLast24h(db, NOW)).toBe(3);
    expect(nextEligible(db, NOW, lim)).toBeNull();
    expect(nextEligible(db, NOW, { ...lim, maxPerDay: 4 })?.signature).toBe('run:failed:fresh');
  });
  it('only one heal at a time, a stale healing row is released, ignored and never rows are never offered', () => {
    const db = setup();
    const a = open(db, 'run:failed:a');
    open(db, 'run:failed:b');
    startAttempt(db, a.id, { mode: 'auto', branch: 'b', worktree: 'w', baseHead: 'abc1234', at: ago(10) });
    expect(nextEligible(db, NOW, lim)).toBeNull(); // a is healing
    expect(releaseStaleHealing(db, NOW)).toEqual([]);
    expect(releaseStaleHealing(db, new Date(NOW.getTime() + 4 * 3_600_000))).toEqual([a.id]);
    expect(getLedgerBySignature(db, 'run:failed:a')?.state).toBe('gave_up');
    ignoreSignature(db, 'run:failed:b', NOW);
    recordSighting(db, classify('run:failed:api_error'), {}, NOW);
    expect(nextEligible(db, NOW, { ...lim, maxPerDay: 9 })).toBeNull();
  });
  it('a landed fix that recurs after its watch window reopens; a give-up reopens only after 7 days', () => {
    const db = setup();
    const l = open(db, 'run:failed:x');
    const a = startAttempt(db, l.id, { mode: 'auto', branch: 'b', worktree: 'w', baseHead: 'abc1234', at: ago(120) });
    updateAttempt(db, a, { outcome: 'landed', watch_until: ago(60).toISOString() });
    setLedgerState(db, l.id, 'landed');
    recordSighting(db, classify('run:failed:x'), {}, ago(80)); // inside the watch window: still landed
    expect(getLedgerBySignature(db, 'run:failed:x')?.state).toBe('landed');
    recordSighting(db, classify('run:failed:x'), {}, ago(5));
    expect(getLedgerBySignature(db, 'run:failed:x')?.state).toBe('open');
    setLedgerState(db, l.id, 'gave_up');
    recordSighting(db, classify('run:failed:x'), {}, NOW);
    expect(getLedgerBySignature(db, 'run:failed:x')?.state).toBe('gave_up');
    recordSighting(db, classify('run:failed:x'), {}, new Date(NOW.getTime() + 8 * 86_400_000));
    expect(getLedgerBySignature(db, 'run:failed:x')?.state).toBe('open');
  });
  it('single-flight lock: a second taker is refused until release', () => {
    const l1 = takeHealLock(dir, 'a');
    expect(l1).not.toBeNull();
    expect(takeHealLock(dir, 'b')).toBeNull();
    l1?.release();
    expect(takeHealLock(dir, 'b')).not.toBeNull();
  });
});

describe('work item, report, notice', () => {
  const item = { ledgerId: 7, attemptId: 2, signature: 'apply:easy_apply:resume_upload_failed', reason: 'why', branch: 'heal/x-20261121', worktree: '/p/.jobber/heal/wt/x', baseHead: 'abc1234', liveRoot: '/p', testability: 'live_until_commit',
    evidence: { runs: ['r1'], queue: [41], diag: ['linkedin-1.json'], note: 'token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA leaked', platform: 'linkedin', window: 'linkedin' } };
  it('names the signature, evidence, worktree, branch, procedure steps, denylist and the report shape; redacts the note', () => {
    const t = buildFixerPrompt(item);
    for (const s of ['apply:easy_apply:resume_upload_failed', 'ledger 7', 'r1', '41', 'linkedin-1.json', '/p/.jobber/heal/wt/x', 'heal/x-20261121', 'REPRODUCE', 'FIXER', 'MUTATION CHECK', 'at most 12 files and 400', 'src/heal/', 'secrets/', '"mutation_check"', 'untrusted'].filter((x) => x !== 'FIXER')) expect(t).toContain(s);
    expect(t).not.toContain('sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA');
  });
  it('parses the last valid report for this ledger id and rejects the rest', () => {
    const ok = '{"ledger_id": 7, "branch": "b", "head": "abc", "files": ["a.ts"], "tests_added": 4, "full_suite": "pass", "mutation_check": "pass", "verdict": "ready", "notes": "n"}';
    expect(parseFixerReport(`text\n\`\`\`json\n${ok}\n\`\`\``, 7)?.verdict).toBe('ready');
    expect(parseFixerReport(ok, 8)).toBeNull();
    expect(parseFixerReport(ok.replace('"ready"', '"merge_it"'), 7)).toBeNull();
    expect(parseFixerReport('no json', 7)).toBeNull();
    expect(parseFixerReport(null, 7)).toBeNull();
  });
  it('a notice is escaped HTML with the signature and, for ready, the command', () => {
    const t = composeNotice({ kind: 'ready', signature: 'a<b>:c', ledgerId: 3, detail: '<script>', command: 'npm run heal -- land 3' });
    expect(t).not.toContain('<script>');
    expect(t).toContain('&lt;script&gt;');
    expect(t).toContain('npm run heal -- land 3');
  });
});

describe('config and declarations', () => {
  it('HEAL_MODE defaults to suggest; only exact off or auto change it; numbers are clamped to their defaults', () => {
    expect(healMode({})).toBe('suggest');
    expect(healMode({ HEAL_MODE: 'auto' })).toBe('auto');
    expect(healMode({ HEAL_MODE: ' off ' })).toBe('off');
    expect(healMode({ HEAL_MODE: 'AUTO' })).toBe('suggest');
    expect(healMode({ HEAL_MODE: 'yes' })).toBe('suggest');
    expect([healMaxPerDay({}), healCooldownHours({}), healWatchMin({})]).toEqual([3, 6, 30]);
    expect(healMaxPerDay({ HEAL_MAX_PER_DAY: '0' })).toBe(3);
    expect(healMaxPerDay({ HEAL_MAX_PER_DAY: '5' })).toBe(5);
    expect(healWatchMin({ HEAL_WATCH_MIN: '1' })).toBe(30);
  });
  it('the env catalog has the four keys; HEAL_MODE is a safety key that the agent never sets', () => {
    const by = new Map(ENV_CATALOG.map((e) => [e.key, e]));
    expect(by.get('HEAL_MODE')).toMatchObject({ default: 'suggest', tier: 'safety' });
    for (const k of ['HEAL_MAX_PER_DAY', 'HEAL_COOLDOWN_HOURS', 'HEAL_WATCH_MIN']) expect(by.has(k)).toBe(true);
    expect(readFileSync(path.join(ROOT, '.env.example'), 'utf8')).toContain('HEAL_MODE');
  });
  it('the fixer window is a declared worker in the manager allowlist with a role file, and the package script exists', () => {
    const cfg = loadManagerConfig(readFileSync(path.join(ROOT, 'config/manager-windows.json'), 'utf8'));
    expect(guard(cfg, 'fixer').kind).toBe('worker');
    expect(cfg.windows.fixer.argv).toEqual(['bash', 'scripts/claude-window.sh', 'fixer']);
    expect(cfg.windows.fixer.lane).toBe('heal');
    const role = readFileSync(path.join(ROOT, 'config/windows/fixer.md'), 'utf8');
    expect(role).toMatch(/work item/i);
    expect(role).toMatch(/worktree/);
    expect(role).toMatch(/never merge/i);
    expect(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.heal).toBe('tsx scripts/heal.ts');
    expect(existsSync(path.join(ROOT, 'scripts/heal.ts'))).toBe(true);
  });
});
