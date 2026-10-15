// src/verify/stages.ts
// The dry-run verification stages. Every dependency comes in through VerifyCtx; nothing here touches the
// real project state (real .jobber/STOP, data.sqlite, tmux, claude, network).
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { isDryRun, recordDryRun } from '../safety/dryRun.js';
import { applyResume, applyStop, defaultDeps, readControl } from '../scheduler/control.js';
import { saveJob, saveMatchResult, setJobExcluded, enqueueOutreach, getExcludedReason } from '../db.js';
import { vetoResults } from '../vetoes.js';
import { jobFactsFromDb } from '../gateFacts.js';
import { buildSnapshot } from '../status/snapshot.js';
import { renderHealth, renderLimits, renderWorking } from '../status/render.js';
import { loadOutreachConfig } from '../outreach/config.js';
import type { Stage, StageOutcome, VerifyCtx } from './engine.js';

const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0];
const pass = (detail: string): StageOutcome => ({ status: 'pass', detail });
const fail = (detail: string, fix?: string): StageOutcome => ({ status: 'fail', detail, fix });
const skip = (detail: string): StageOutcome => ({ status: 'skip', detail });

function underDir(p: string, dir: string): boolean {
  const a = resolve(p);
  const b = resolve(dir);
  return a === b || a.startsWith(b + sep);
}

function runEnv(ctx: VerifyCtx): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx.env)) if (typeof v === 'string') out[k] = v;
  return out;
}

interface KillSwitch { decide(event: { tool_name: string }, opts: { root: string; env: NodeJS.ProcessEnv }): { allow: boolean; reason: string } }
function killSwitch(ctx: VerifyCtx): KillSwitch {
  return createRequire(import.meta.url)(join(ctx.root, '.claude', 'hooks', 'kill-switch.cjs')) as KillSwitch;
}

const envGuard: Stage = {
  id: 'env-guard', title: 'dry env is forced and the database is a temp file', skippable: false,
  async run(ctx) {
    const bad = 'internal: dry env not applied';
    const e = ctx.env;
    if (!isDryRun(e, { linkedin: true }) || e.JOBBER_DRY_RUN !== '1' || e.SCHEDULER_DRY_RUN !== 'true' || e.LINKEDIN_DRY_RUN !== 'true') {
      return fail('dry flags are not all on', bad);
    }
    if (ctx.env.JOBBER_KILL !== undefined) return fail('JOBBER_KILL is set', bad);
    const db = ctx.env.JOBAPPLIER_DB ?? '';
    if (!db || db === 'data.sqlite' || !underDir(db, ctx.tmp)) return fail('JOBAPPLIER_DB is not under the temp dir', bad);
    return pass('dry flags on, JOBAPPLIER_DB under the temp dir');
  },
};

const doctor: Stage = {
  id: 'doctor', title: 'doctor checks', skippable: false,
  async run(ctx) {
    const out = await ctx.doctor();
    const failed = out.filter((o) => o.result.status === 'fail');
    const warns = out.filter((o) => o.result.status === 'warn');
    if (failed.length > 0) {
      const fixes = failed.map((o) => `${o.id}: ${o.result.fix ?? o.result.detail}`).join('; ');
      return fail(`${failed.length} failing: ${failed.map((o) => o.id).join(', ')}`, fixes);
    }
    return pass(`${out.length} checks, ${warns.length} warn${warns.length ? ` (${warns.map((o) => o.id).join(', ')})` : ''}`);
  },
};

const classifierSmoke: Stage = {
  id: 'classifier-smoke', title: 'injection classifier smoke', skippable: true,
  async run(ctx) {
    const fix = 'npm run bootstrap, then npm run setup -- --step classifier';
    const o = (await ctx.doctor()).find((x) => x.id === 'classifier_smoke');
    if (!o) return fail('classifier_smoke check not found', fix);
    if (o.result.status === 'pass') return pass(o.result.detail);
    return fail(o.result.detail, o.result.fix ?? fix);
  },
};

const BAD_ARGV = /bypass|skip-permissions|dangerously/i;
const launcher: Stage = {
  id: 'launcher', title: 'restricted launcher argv', skippable: false,
  async run(ctx) {
    const cases: Array<{ profile: string; extra: string[] }> = [
      { profile: 'hunt', extra: [] },
      { profile: 'outreach_wake', extra: [] },
      { profile: 'setup_guide', extra: ['--interactive'] },
    ];
    for (const c of cases) {
      const r = await ctx.run('npx', ['tsx', 'scripts/run-claude.ts', c.profile, ...c.extra, '--print-args'], { cwd: ctx.root, env: runEnv(ctx) });
      if (r.code !== 0) return fail(`${c.profile}: exit ${r.code}: ${r.stdout.split('\n')[0]}`, r.stdout.split('\n')[0] || `run-claude ${c.profile} failed`);
      const m = BAD_ARGV.exec(r.stdout);
      if (m) return fail(`${c.profile}: argv contains "${m[0]}"`, `launcher ${c.profile} printed a forbidden flag`);
    }
    return pass('hunt, outreach_wake and setup_guide print safe argv');
  },
};

const schedulerPlan: Stage = {
  id: 'scheduler-plan', title: 'scheduler dry-run plan', skippable: false,
  async run(ctx) {
    const fix = 'npm run scheduler -- --status';
    const db = ctx.openDb(ctx.tempDbPath); // creates and migrates the temp db
    db.close();
    const r = await ctx.run('npx', ['tsx', 'scripts/scheduler.ts', '--dry-run-plan'], { cwd: ctx.root, env: runEnv(ctx) });
    if (r.code !== 0) return fail(`exit ${r.code}: ${r.stdout.split('\n')[0]}`, fix);
    try {
      const j = JSON.parse(r.stdout) as unknown;
      if (!j || typeof j !== 'object' || Array.isArray(j)) return fail('plan output is not an object', fix);
      return pass(`plan decision parsed (${Object.keys(j as object).slice(0, 4).join(', ')})`);
    } catch {
      return fail('plan output is not JSON', fix);
    }
  },
};

const pipelineFixture: Stage = {
  id: 'pipeline-fixture', title: 'fixture pipeline: vetoes, queue, dry-run record, hook', skippable: false,
  async run(ctx) {
    const fx = ctx.fixtures();
    const db = ctx.openDb(ctx.tempDbPath);
    try {
      for (const j of fx.jobs) saveJob(db, { ...j });
      for (const m of fx.match) saveMatchResult(db, m);
      const clean = fx.jobs.find((j) => j.id === fx.cleanJobId);
      const bad = fx.jobs.find((j) => j.id === fx.dealBreakerJobId);
      if (!clean || !bad) return fail('assertion fixtures-complete: clean or deal-breaker job missing', 'assertion fixtures-complete');
      const results = fx.match.filter((m) => m.job_id === clean.id || m.job_id === bad.id)
        .map((m) => ({ job_id: m.job_id, score: m.score, location_verdict: m.location_verdict, language_gate: m.language_gate }));
      const now = ctx.now();
      const facts = new Map(results.map((r) => [r.job_id, jobFactsFromDb(db, r.job_id)]));
      const out = vetoResults(results, fx.jobs, fx.dealBreakers, { facts, now });
      const vb = out.find((o) => o.job_id === bad.id);
      const vc = out.find((o) => o.job_id === clean.id);
      if (!vb?.excluded || !vb.reason) return fail('assertion deal-breaker-excluded', 'assertion deal-breaker-excluded');
      if (vc?.excluded) return fail(`assertion clean-not-excluded: ${vc.reason ?? ''}`, 'assertion clean-not-excluded');
      setJobExcluded(db, bad.id, vb.reason);
      if (getExcludedReason(db, bad.id) !== vb.reason) return fail('assertion exclusion-persisted', 'assertion exclusion-persisted');
      enqueueOutreach(db, {
        job_id: clean.id, resume_pdf_path: null, email_subject: 'Fixture subject', email_body: 'Fixture body',
        email_to: 'fixture@example.invalid', connect_note: null, connect_profile_url: null, connect_category: null,
        connect_company: clean.company, apply_platform: 'none', apply_url: clean.apply_url,
      });
      const queued = db.prepare("SELECT count(*) AS n FROM outreach_queue WHERE job_id = ?").get(clean.id) as { n: number };
      if (queued.n !== 1) return fail('assertion clean-queued', 'assertion clean-queued');
      recordDryRun(db, { runId: null, action: 'send_email', platform: 'gmail', payload: { job_id: clean.id, to: 'fixture@example.invalid' } }, now, ctx.env);
      const rows = db.prepare('SELECT count(*) AS n FROM dry_run_actions').get() as { n: number };
      if (rows.n !== 1) return fail(`assertion one-dry-run-row (found ${rows.n})`, 'assertion one-dry-run-row');
      const d = killSwitch(ctx).decide({ tool_name: 'mcp__gmail__send_email' }, { root: ctx.tmp, env: ctx.env });
      if (d.allow) return fail('assertion hook-denies-send', 'assertion hook-denies-send');
      return pass(`vetoed "${vb.reason}", 1 queued, 1 dry-run row, hook denies send`);
    } finally {
      db.close();
    }
  },
};

const killSwitchDrill: Stage = {
  id: 'kill-switch-drill', title: 'kill switch drill on a temp stop file', skippable: false,
  async run(ctx) {
    const fix = 'kill switch code path broken: do not go live';
    const ks = killSwitch(ctx);
    const db = ctx.openDb(ctx.tempDbPath);
    try {
      ctx.fs.mkdir(join(ctx.tmp, '.jobber'));
      const env = { ...ctx.env };
      const ev = { tool_name: 'mcp__db__list_jobs' };
      const deps = defaultDeps(env, ctx.tempStopFile);
      applyStop(db, ctx.tempStopFile, 'verify drill', ctx.now());
      const stopped = readControl(db, deps);
      if (!stopped.killed) return fail('readControl did not see the STOP file', fix);
      if (ks.decide(ev, { root: ctx.tmp, env }).allow) return fail('hook allowed a tool while STOP existed', fix);
      applyResume(db, ctx.tempStopFile, ctx.now());
      const resumed = readControl(db, deps);
      if (resumed.killed) return fail('readControl still killed after resume', fix);
      if (!ks.decide(ev, { root: ctx.tmp, env }).allow) return fail('hook denied a tool after resume', fix);
      return pass('stop seen, tool denied, resume seen, tool allowed');
    } finally {
      db.close();
    }
  },
};

const statusRender: Stage = {
  id: 'status-render', title: 'status renderers', skippable: false,
  async run(ctx) {
    let db: ReturnType<VerifyCtx['openDb']> | undefined;
    try {
      db = ctx.openDb(ctx.tempDbPath);
      const snap = buildSnapshot(db, loadOutreachConfig(ctx.env), ctx.now());
      const parts = { limits: renderLimits(snap), working: renderWorking(snap), health: renderHealth(snap, []) };
      for (const [k, v] of Object.entries(parts)) {
        if (!v || !v.trim()) return fail(`${k} rendered empty`, `render${k} produced no text`);
      }
      return pass('limits, working and health render');
    } catch (e) {
      const m = firstLine(e);
      return fail(m, m);
    } finally {
      db?.close();
    }
  },
};

const dashboardLogin: Stage = {
  id: 'dashboard-login', title: 'dashboard token login', skippable: true,
  async run(ctx) {
    const fix = 'npm run doctor, check web and dashboard-login';
    const get = ctx.fetch ?? (async (u: string) => {
      const r = await fetch(u);
      return { status: r.status, text: () => r.text() };
    });
    let srv: { url: string; close(): Promise<void> };
    try {
      srv = await ctx.startWeb({ port: 0, host: '127.0.0.1', tmp: ctx.tmp });
    } catch (e) {
      return fail(`dashboard server did not start: ${firstLine(e)}`, fix);
    }
    try {
      const mode = await get(`${srv.url}/api/auth/mode`);
      if (mode.status === 404 || mode.status === 401) {
        return skip(`8C dashboard login not merged: /api/auth/mode absent (got ${mode.status})`);
      }
      if (mode.status !== 200) return fail(`/api/auth/mode returned ${mode.status}`, fix);
      let m: unknown;
      try { m = JSON.parse(await mode.text()); } catch { return fail('/api/auth/mode is not JSON', fix); }
      if ((m as { mode?: unknown } | null)?.mode !== 'token') return fail('/api/auth/mode is not token mode', fix);
      const root = await get(`${srv.url}/`);
      if (root.status !== 200) return fail(`GET / returned ${root.status}`, fix);
      const st = await get(`${srv.url}/api/status`);
      if (st.status !== 401) return fail(`/api/status without session returned ${st.status}, expected 401`, fix);
      return pass('/ 200, auth mode token, /api/status 401 without a session');
    } catch (e) {
      return fail(firstLine(e), fix);
    } finally {
      try { await srv.close(); } catch { /* closing a stub */ }
    }
  },
};

const llmHunt: Stage = {
  id: 'llm-hunt', title: 'LLM hunt in dry mode', skippable: true,
  async run(ctx) {
    if (!ctx.llm) return skip('off unless --llm');
    const r = await ctx.run('./run-hunt.sh', ['run the hunt in dry mode: report only'], { cwd: ctx.root, env: runEnv(ctx) });
    if (r.code !== 0) return fail(`exit ${r.code}`, `exit code ${r.code}; see docs/operations`);
    const last = r.stdout.trim().split('\n').filter(Boolean).pop();
    if (!last) return fail('no final report line', 'no final report; see docs/operations');
    return pass(`final report: ${last.slice(0, 120)}`);
  },
};

export function allStages(): Stage[] {
  return [
    envGuard, doctor, classifierSmoke, launcher, schedulerPlan, pipelineFixture,
    killSwitchDrill, statusRender, dashboardLogin, llmHunt,
  ];
}

export {
  envGuard, doctor, classifierSmoke, launcher, schedulerPlan, pipelineFixture,
  killSwitchDrill, statusRender, dashboardLogin, llmHunt,
};
