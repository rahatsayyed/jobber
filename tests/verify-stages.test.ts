// tests/verify-stages.test.ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.js';

const calls: { fn: string; file: string }[] = [];
vi.mock('../src/scheduler/control.js', async (orig) => {
  const m = await orig<typeof import('../src/scheduler/control.js')>();
  return {
    ...m,
    applyStop: (db: never, f: string, r: string, n: Date) => { calls.push({ fn: 'applyStop', file: f }); return m.applyStop(db, f, r, n); },
    applyResume: (db: never, f: string, n: Date) => { calls.push({ fn: 'applyResume', file: f }); return m.applyResume(db, f, n); },
  };
});
const S = await import('../src/verify/stages.js');
const { buildCtx } = await import('../src/verify/engine.js');
type Ctx = import('../src/verify/engine.js').VerifyCtx;

const ROOT = resolve(import.meta.dirname, '..');
const writes: string[] = [];
const dirs: string[] = [];
const recFs = {
  mkdtemp: (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; },
  mkdir: (p: string) => { writes.push(p); mkdirSync(p, { recursive: true }); },
  write: (p: string, d: string) => { writes.push(p); writeFileSync(p, d); },
  exists: (p: string) => existsSync(p),
  rm: (p: string) => rmSync(p, { recursive: true, force: true }),
};
const fixtures = () => ({
  jobs: [
    { id: 'fx-clean', source: 'fixture', title: 'Full stack developer', company: 'Acme', url: 'https://example.invalid/1', apply_url: 'https://example.invalid/apply/1', description: 'Build React apps with TypeScript. Remote in India.' },
    { id: 'fx-bad', source: 'fixture', title: 'Developer', company: 'Globex', url: 'https://example.invalid/2', apply_url: 'https://example.invalid/apply/2', description: 'Unpaid trial period required. React.' },
  ],
  match: [
    { job_id: 'fx-clean', score: 80, reasons: 'good', missing_keywords: [] },
    { job_id: 'fx-bad', score: 80, reasons: 'good', missing_keywords: [] },
  ],
  cleanJobId: 'fx-clean', dealBreakerJobId: 'fx-bad', dealBreakers: ['unpaid trial'],
});
function mk(over: Partial<Ctx> = {}): Ctx {
  return buildCtx({
    root: ROOT, env: { PATH: process.env.PATH }, run: async () => ({ stdout: '', code: 0 }), fs: recFs, now: () => new Date('2026-10-15T00:00:00Z'),
    doctor: async () => [], openDb, startWeb: async () => ({ url: 'http://x', close: async () => {} }), fixtures, ...over,
  } as never);
}
beforeEach(() => { calls.length = 0; writes.length = 0; });
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('env-guard', () => {
  it('passes for a built ctx and fails for a non-temp db or live flags', async () => {
    const c = mk();
    expect((await S.envGuard.run(c)).status).toBe('pass');
    expect((await S.envGuard.run({ ...c, env: { ...c.env, JOBAPPLIER_DB: 'data.sqlite' } })).status).toBe('fail');
    expect((await S.envGuard.run({ ...c, env: { ...c.env, JOBBER_DRY_RUN: 'false' } })).status).toBe('fail');
  });
});

describe('doctor and classifier-smoke', () => {
  const ok = (id: string, status: 'pass' | 'warn' | 'fail', fix?: string) => ({ id, title: id, result: { status, detail: `${id} ${status}`, fix } });
  it('doctor passes with warns and fails with the check fix', async () => {
    expect((await S.doctor.run(mk({ doctor: async () => [ok('a', 'pass'), ok('b', 'warn')] }))).status).toBe('pass');
    const r = await S.doctor.run(mk({ doctor: async () => [ok('a', 'fail', 'run X')] }));
    expect(r.status).toBe('fail');
    expect(r.fix).toContain('run X');
  });
  it('classifier-smoke follows classifier_smoke and fails when missing or not ready', async () => {
    expect((await S.classifierSmoke.run(mk({ doctor: async () => [ok('classifier_smoke', 'pass')] }))).status).toBe('pass');
    expect((await S.classifierSmoke.run(mk({ doctor: async () => [ok('classifier_smoke', 'warn')] }))).status).toBe('fail');
    const r = await S.classifierSmoke.run(mk({ doctor: async () => [] }));
    expect(r.status).toBe('fail');
    expect(r.fix).toContain('npm run bootstrap');
  });
});

describe('launcher', () => {
  it('runs outreach_wake and setup_guide --interactive --print-args, only for profiles that exist', async () => {
    const seen: string[][] = [];
    const r = await S.launcher.run(mk({ run: async (_c, a) => { seen.push(a); return { stdout: 'claude --safe', code: 0 }; } }));
    expect(r.status).toBe('pass');
    const profiles = Object.keys((JSON.parse(readFileSync('config/run-profiles.json', 'utf8')) as { profiles: Record<string, unknown> }).profiles);
    for (const a of seen) expect(profiles).toContain(a[2]);
    expect(seen.some((a) => a.includes('outreach_wake') && a.includes('--print-args'))).toBe(true);
    expect(seen.some((a) => a.includes('setup_guide') && a.includes('--interactive') && a.includes('--print-args'))).toBe(true);
  });
  it('fails on a forbidden flag or non-zero exit', async () => {
    expect((await S.launcher.run(mk({ run: async () => ({ stdout: 'claude --dangerously-skip-permissions', code: 0 }) }))).status).toBe('fail');
    const r = await S.launcher.run(mk({ run: async () => ({ stdout: 'launcher: nope\nmore', code: 3 }) }));
    expect(r.status).toBe('fail');
    expect(r.fix).toBe('launcher: nope');
  });
});

describe('scheduler-plan', () => {
  it('passes on a JSON object and fails otherwise; db env is the temp db', async () => {
    let env: Record<string, string> | undefined;
    const c = mk({ run: async (_c, _a, o) => { env = o?.env; return { stdout: '{"action":"skip","reason":"nothing_due"}', code: 0 }; } });
    expect((await S.schedulerPlan.run(c)).status).toBe('pass');
    expect(env?.JOBAPPLIER_DB).toBe(c.tempDbPath);
    expect((await S.schedulerPlan.run(mk({ run: async () => ({ stdout: 'oops', code: 0 }) }))).status).toBe('fail');
    expect((await S.schedulerPlan.run(mk({ run: async () => ({ stdout: '', code: 1 }) }))).status).toBe('fail');
  });
});

describe('pipeline-fixture', () => {
  it('excludes the deal-breaker, queues the clean job, records one dry-run row, denies the send', async () => {
    const r = await S.pipelineFixture.run(mk());
    expect(r.detail).toContain('vetoed');
    expect(r.status).toBe('pass');
  });
  it('fails when the deal-breaker keyword does not match', async () => {
    const f = fixtures();
    const r = await S.pipelineFixture.run(mk({ fixtures: () => ({ ...f, dealBreakers: ['zzz'] }) }));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('deal-breaker-excluded');
  });
});

describe('kill-switch-drill', () => {
  it('passes and only touches the temp stop file', async () => {
    const c = mk();
    const r = await S.killSwitchDrill.run(c);
    expect(r.status).toBe('pass');
    const real = resolve(ROOT, '.jobber', 'STOP');
    expect(calls.map((x) => x.fn)).toEqual(['applyStop', 'applyResume']);
    for (const x of calls) {
      expect(x.file).toBe(c.tempStopFile);
      expect(resolve(x.file)).not.toBe(real);
    }
  });
});

describe('status-render', () => {
  it('passes on an empty temp db and fails when the db cannot open', async () => {
    expect((await S.statusRender.run(mk())).status).toBe('pass');
    const r = await S.statusRender.run(mk({ openDb: () => { throw new Error('cannot open\nx'); } }));
    expect(r.status).toBe('fail');
    expect(r.fix).toBe('cannot open');
  });
});

describe('dashboard-login', () => {
  const resp = (m: Record<string, [number, string]>) => async (u: string) => {
    const k = Object.keys(m).find((p) => u.endsWith(p))!;
    return { status: m[k][0], text: async () => m[k][1] };
  };
  it('fails on 401 or 500 from the auth mode route (no pre-8C skip heuristic)', async () => {
    for (const code of [401, 500]) {
      const r = await S.dashboardLogin.run(mk({ fetch: resp({ '/api/auth/mode': [code, ''], '/api/status': [401, ''], 'http://x/': [200, ''] }) }));
      expect(r.status).toBe('fail');
    }
  });
  it('skips only when the auth mode route is 404 (server without the login routes)', async () => {
    const r = await S.dashboardLogin.run(mk({ fetch: resp({ '/api/auth/mode': [404, ''] }) }));
    expect(r.status).toBe('skip');
    expect(r.detail).toContain('login routes absent');
  });
  it('runs the token login with the temp token: wrong 401, right 200 plus cookie, session 200, no token in detail', async () => {
    const TOKEN = 'TempTokenValue_abc123';
    const calls: string[] = [];
    const f = async (u: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${u}`);
      const mkr = (status: number, body: string, headers: Record<string, string> = {}) => ({
        status, text: async () => body, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      });
      if (u.endsWith('/api/auth/mode')) return mkr(200, '{"mode":"token"}');
      if (u.endsWith('/api/status')) return mkr(401, '');
      if (u.endsWith('/auth/token')) {
        const t = (JSON.parse(init!.body!) as { token: string }).token;
        return t === TOKEN ? mkr(200, '{"ok":true}', { 'set-cookie': 'sid=abc; Path=/; HttpOnly' }) : mkr(401, '{"error":"denied"}');
      }
      if (u.endsWith('/api/session')) return mkr(init?.headers?.cookie === 'sid=abc' ? 200 : 401, '{}');
      return mkr(200, '<html>');
    };
    const r = await S.dashboardLogin.run(mk({ startWeb: async () => ({ url: 'http://h', close: async () => {}, token: TOKEN }), fetch: f }));
    expect(r.status).toBe('pass');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(2);
  });
  it('fails when the right token is refused', async () => {
    const f = async (u: string) => ({
      status: u.endsWith('/api/auth/mode') ? 200 : u.endsWith('/api/status') ? 401 : u.endsWith('/auth/token') ? 401 : 200,
      text: async () => (u.endsWith('/api/auth/mode') ? '{"mode":"token"}' : ''),
    });
    const r = await S.dashboardLogin.run(mk({ startWeb: async () => ({ url: 'http://h', close: async () => {}, token: 'tok' }), fetch: f }));
    expect(r.status).toBe('fail');
  });
  it('fails when the server cannot start', async () => {
    const r = await S.dashboardLogin.run(mk({ startWeb: async () => { throw new Error('needs OIDC'); } }));
    expect(r.status).toBe('fail');
    expect(r.fix).toContain('npm run doctor');
  });
  it('passes with token mode, 200 and 401', async () => {
    let closed = false;
    const r = await S.dashboardLogin.run(mk({
      startWeb: async () => ({ url: 'http://h', close: async () => { closed = true; } }),
      fetch: resp({ '/api/auth/mode': [200, '{"mode":"token"}'], '/api/status': [401, ''], 'http://h/': [200, '<html>'] }),
    }));
    expect(r.status).toBe('pass');
    expect(closed).toBe(true);
  });
  it('fails when status is not 401', async () => {
    const r = await S.dashboardLogin.run(mk({
      fetch: resp({ '/api/auth/mode': [200, '{"mode":"token"}'], '/api/status': [200, '{}'], 'http://x/': [200, ''] }),
    }));
    expect(r.status).toBe('fail');
  });
});

describe('llm-hunt', () => {
  const withEnv = (files: Record<string, string>) => ({
    ...recFs,
    exists: (p: string) => Object.keys(files).some((f) => p.endsWith(f)),
    read: (p: string) => files[Object.keys(files).find((f) => p.endsWith(f))!]!,
  });
  const DRY = 'JOBBER_DRY_RUN=true\n';
  it('is skipped unless llm is set', async () => {
    expect((await S.llmHunt.run(mk())).status).toBe('skip');
    expect((await S.llmHunt.run(mk({ llm: true, fs: withEnv({ '.env': DRY }), run: async () => ({ stdout: 'a\nREPORT done', code: 0 }) }))).status).toBe('pass');
    expect((await S.llmHunt.run(mk({ llm: true, fs: withEnv({ '.env': DRY }), run: async () => ({ stdout: '', code: 2 }) }))).status).toBe('fail');
  });
  it('on a non-zero exit shows the redacted stderr tail, the last stdout line and passes PATH and HOME', async () => {
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    const err = Array.from({ length: 30 }, (_, i) => `err line ${i + 1}`).concat(`auth failed with ${secret}`).join('\n');
    let seenEnv: Record<string, string> | undefined;
    const run = async (_c: string, _a: string[], o?: { env?: Record<string, string> }) => {
      seenEnv = o?.env;
      return { stdout: 'start\nlast stdout words', code: 1, stderr: err };
    };
    const r = await S.llmHunt.run(mk({ llm: true, env: { PATH: '/usr/bin', HOME: '/home/x' }, fs: withEnv({ '.env': DRY }), run }));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('exit 1');
    expect(r.detail).toContain('err line 30');
    expect(r.detail).not.toContain('err line 10\n');
    expect(r.detail).not.toContain('err line 1\n');
    expect(r.detail).toContain('last stdout line: last stdout words');
    expect(r.detail).not.toContain(secret);
    expect(r.detail).toContain('[redacted]');
    expect(r.fix).toContain('run-hunt.sh');
    expect(seenEnv?.PATH).toBe('/usr/bin');
    expect(seenEnv?.HOME).toBe('/home/x');
  });
  it('refuses and never runs when .env is live', async () => {
    let ran = 0;
    const run = async () => { ran++; return { stdout: 'x', code: 0 }; };
    const live = 'JOBBER_DRY_RUN=false\n';
    const r = await S.llmHunt.run(mk({ llm: true, fs: withEnv({ '.env': live }), run }));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('--llm refused: .env is not dry');
    expect(ran).toBe(0);
    const r2 = await S.llmHunt.run(mk({ llm: true, fs: withEnv({ '.env': DRY, '.env.ccr': 'JOBBER_DRY_RUN=false\n' }), run }));
    expect(r2.status).toBe('fail');
    expect(ran).toBe(0);
  });
  it('checks the merged .env then .env.ccr (later wins)', async () => {
    let ran = 0;
    const run = async () => { ran++; return { stdout: 'x\nreport', code: 0 }; };
    const a = 'JOBBER_DRY_RUN=true\nSCHEDULER_DRY_RUN=true\n';
    const r = await S.llmHunt.run(mk({ llm: true, fs: withEnv({ '.env': a, '.env.ccr': 'JOBBER_DRY_RUN=false\n' }), run }));
    expect(r.status).toBe('fail');
    expect(ran).toBe(0);
    const ok = await S.llmHunt.run(mk({ llm: true, fs: withEnv({ '.env': 'SCHEDULER_DRY_RUN=true\nJOBBER_DRY_RUN=false\n', '.env.ccr': 'JOBBER_DRY_RUN=true\n' }), run }));
    expect(ok.status).toBe('pass');
    expect(ran).toBe(1);
  });
});

describe('writes nothing outside tmp', () => {
  it('every ctx.fs write is under the temp dir', async () => {
    const c = mk();
    for (const s of S.allStages()) await s.run(c);
    expect(writes.length).toBeGreaterThan(0);
    for (const w of writes) expect(resolve(w).startsWith(resolve(c.tmp))).toBe(true);
  });
});
