// Dry-run stages for the 8G source runner, the scout dork engine and the applier (plan 8G-2 task 24).
// Everything is hermetic: a temp database, fakes, committed fixtures; no network, no real browser, no model.
// `--llm` never drives any of these (they take no llm input). A stage whose module is not on this branch skips
// with a note instead of failing (the scout engine arrives with the 8G-1 branch).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import type { Stage, StageOutcome, VerifyCtx } from './engine.js';

const pass = (detail: string): StageOutcome => ({ status: 'pass', detail });
const fail = (detail: string, fix?: string): StageOutcome => ({ status: 'fail', detail, fix });
const skip = (detail: string): StageOutcome => ({ status: 'skip', detail });
const firstLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0]!;

// ---- (a) provider fixtures with one forced shape break --------------------------------------------------------

export const providerShapeBreak: Stage = {
  id: 'provider-shape', title: 'source runner: forced shape break queues one source_tasks row', skippable: true,
  async run(ctx: VerifyCtx) {
    if (!ctx.fs.exists(join(ctx.root, 'src', 'sources', 'runner.ts'))) return skip('src/sources/runner is not installed');
    let db: BetterSqlite3.Database | null = null;
    try {
      const { runScriptSources } = await import('../sources/runner.js');
      const { z } = await import('zod');
      const portals = join(ctx.tmp, 'portals.json');
      const registry = join(ctx.tmp, 'platforms.json');
      ctx.fs.write(portals, JSON.stringify({ tracked_companies: [], title_filter: { positive: [], negative: [] }, location_filter: { allow: [], global: [] } }));
      ctx.fs.write(registry, JSON.stringify({ platforms: [
        { id: 'adzuna', kind: 'api', label: 'fixture', provider: 'adzuna', tier: 'script', enabled: true, stability: 'fixture' },
        { id: 'remotive', kind: 'api', label: 'fixture', provider: 'remotive', tier: 'script', enabled: true, stability: 'fixture' },
      ] }));
      const spec = z.object({ id: z.number(), title: z.string() }).passthrough();
      const job = (id: string, source: string) => ({ id, source, title: 'T', company: 'C', url: 'https://example.invalid/1', apply_url: 'https://example.invalid/1', description: 'd' });
      db = ctx.openDb(ctx.tempDbPath);
      const quiet = console.error;
      console.error = () => {};
      let r;
      try {
        r = await runScriptSources(db, {
          role: 'fixture', portalsPath: portals, registryPath: registry, now: ctx.now,
          providers: {
            // healthy provider
            adzuna: { id: 'adzuna', shapeSpec: spec, fetch: async () => ({ jobs: [job('fx-ok:1', 'adzuna')], sample: [{ id: 1, title: 't' }] }) },
            // forced shape break: the vendor renamed `title` to `name`
            remotive: { id: 'remotive', shapeSpec: spec, fetch: async () => ({ jobs: [job('fx-bad:1', 'remotive')], sample: [{ id: 1, name: 't' }] }) },
          },
        });
      } finally { console.error = quiet; }
      const rows = db.prepare('SELECT platform, reason, state FROM source_tasks').all() as Array<{ platform: string; reason: string; state: string }>;
      if (rows.length !== 1 || rows[0]!.platform !== 'remotive' || rows[0]!.reason !== 'shape' || rows[0]!.state !== 'queued') {
        return fail(`expected exactly one queued shape task for the broken provider, got ${JSON.stringify(rows)}`, 'src/sources/runner.ts');
      }
      const ok = r.rows.find((x) => x.source === 'adzuna');
      if (!ok || ok.error || ok.fallback_used) return fail('the healthy provider was affected by the broken one', 'src/sources/runner.ts');
      return pass('healthy provider clean; broken provider queued one source_tasks row (shape)');
    } catch (e) {
      return fail(`source runner stage crashed: ${firstLine(e)}`);
    } finally {
      try { db?.close(); } catch { /* already closed */ }
    }
  },
};

// ---- (b) scout dork engine over serp-ok / serp-blocked --------------------------------------------------------

export const scoutDork: Stage = {
  id: 'scout-dork', title: 'scout dork SERP parsing over the SERP fixtures', skippable: true,
  async run(ctx: VerifyCtx) {
    const serp = join(ctx.root, 'src', 'scout', 'serp.ts');
    const helper = join(ctx.root, 'tests', 'helpers', 'fakeScoutBrowser.ts');
    const fixtures = ['serp-ok.html', 'serp-blocked.html'].map((n) => join(ctx.root, 'tests', 'fixtures', 'web', n));
    if (!ctx.fs.exists(serp)) return skip('src/scout is not installed');
    if (!ctx.fs.exists(helper) || !fixtures.every((f) => ctx.fs.exists(f))) return skip('anchor-page fixtures (tests/helpers/fakeScoutBrowser.ts, tests/fixtures/web/serp-*.html) are not installed');
    try {
      // parseSerp lives in serp.ts and takes the anchor page the in-page script returns (RawAnchorPage), not HTML.
      const [{ parseSerp }, { anchorSnapshotFromHtml }] = await Promise.all([
        import('../scout/serp.js'),
        import(pathToFileURL(helper).href) as Promise<typeof import('../../tests/helpers/fakeScoutBrowser.js')>,
      ]);
      const ok = parseSerp(anchorSnapshotFromHtml('serp-ok.html', 'https://www.bing.com/search?q=x'));
      const blocked = parseSerp(anchorSnapshotFromHtml('serp-blocked.html', 'https://www.google.com/search?q=x'));
      if (ok.blocked || !ok.results.length) return fail('serp-ok fixture did not parse into results', 'src/scout/serp.ts');
      if (!blocked.blocked) return fail('serp-blocked fixture was not recognised as a block', 'src/scout/serp.ts');
      return pass(`serp-ok parsed ${ok.results.length} results; serp-blocked recognised (${blocked.block})`);
    } catch (e) {
      return fail(`scout stage crashed: ${firstLine(e)}`);
    }
  },
};

// ---- (c) applier against the fixture site, dry and hold -------------------------------------------------------

const COUNT_QUERIES: Record<string, string> = {
  'rate_events:apply_attempt': "SELECT COUNT(*) n FROM rate_events WHERE key = 'apply_attempt'",
  'rate_events:other': "SELECT COUNT(*) n FROM rate_events WHERE key <> 'apply_attempt'",
  daily_counters: 'SELECT COALESCE(SUM(count), 0) n FROM daily_counters',
  apply_host_day: 'SELECT COALESCE(SUM(count), 0) n FROM apply_host_day',
  applications: 'SELECT COUNT(*) n FROM applications',
  outreach_queue_not_queued: "SELECT COUNT(*) n FROM outreach_queue WHERE status <> 'queued'",
};
function snapshot(db: BetterSqlite3.Database): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, sql] of Object.entries(COUNT_QUERIES)) out[k] = (db.prepare(sql).get() as { n: number }).n;
  return out;
}
/** Names of the counters that changed between two snapshots. */
export function movedCounters(before: Record<string, number>, after: Record<string, number>): string[] {
  return Object.keys(after).filter((k) => after[k] !== before[k]);
}

export const applierFixture: Stage = {
  id: 'applier-fixture', title: 'applier on the fixture site: dry and hold move only apply_attempt', skippable: true,
  async run(ctx: VerifyCtx) {
    const helper = join(ctx.root, 'tests', 'helpers', 'fakeSitePage.ts');
    const answersFx = join(ctx.root, 'tests', 'fixtures', 'web', 'answers.json');
    const resumeFx = join(ctx.root, 'tests', 'fixtures', 'web', 'resume.json');
    if (!ctx.fs.exists(helper) || !ctx.fs.exists(answersFx) || !ctx.fs.exists(resumeFx) || !ctx.fs.read) return skip('fixture site (tests/helpers, tests/fixtures/web) is not installed');
    const results: string[] = [];
    for (const mode of ['dry', 'hold'] as const) {
      let db: BetterSqlite3.Database | null = null;
      let runtime: { close(): Promise<unknown> } | null = null;
      try {
        const [{ createFakeSite }, { createWebRuntime }, { loadAnswerBook }, tools] = await Promise.all([
          import(pathToFileURL(helper).href) as Promise<typeof import('../../tests/helpers/fakeSitePage.js')>,
          import('../webcore/runtime.js'), import('../apply/answers.js'), import('../applier/tools/index.js'),
        ]);
        const dir = join(ctx.tmp, `applier-${mode}`);
        ctx.fs.mkdir(dir);
        const resumeDir = join(dir, 'renderer', 'automation', 'abc');
        ctx.fs.mkdir(resumeDir);
        ctx.fs.write(join(resumeDir, 'resume.pdf'), '%PDF-1.4 invented');
        ctx.fs.write(join(dir, 'answers.json'), ctx.fs.read(answersFx));
        ctx.fs.write(join(dir, 'resume.json'), ctx.fs.read(resumeFx));
        const applyUrl = 'https://boards.greenhouse.io/acme/jobs/1';
        db = ctx.openDb(join(dir, 'applier.sqlite'));
        db.prepare('INSERT INTO jobs (id, source, title, company, url, apply_url, description) VALUES (?,?,?,?,?,?,?)')
          .run('fx-apply', 'adzuna', 'Senior Engineer', 'Acme', applyUrl, applyUrl, 'Location: Pune, India\n\nBuild things.');
        db.prepare('INSERT INTO outreach_queue (job_id, resume_pdf_path, apply_platform, apply_tier, apply_url, status) VALUES (?,?,?,?,?,?)')
          .run('fx-apply', join(resumeDir, 'resume.pdf'), 'greenhouse', 'fast', applyUrl, 'queued');
        // Flags are explicit on this in-process env object only; the fake launcher cannot reach a real site.
        const env: NodeJS.ProcessEnv = {
          SCHEDULER_DRY_RUN: 'false', WEB_DRY_RUN: 'false', SCOUT_DRY_RUN: 'false', WEB_MIN_GAP_SEC: '0',
          APPLY_DRY_RUN: mode === 'dry' ? 'true' : 'false', APPLY_SUBMIT_MODE: 'hold',
        };
        const site = createFakeSite({ start: 'ats-b-form.html', url: applyUrl, transitions: { 'Submit application': [{ fixture: 'ats-b-confirmation.html' }] } });
        const rt = createWebRuntime({ db, launcher: site.launcher, lockPath: join(dir, 'l.lock'), sessionDir: join(dir, 's'), config: { minGapSec: 0, settleMs: 0 }, env });
        runtime = rt;
        const deps = {
          db, runtime: rt, env, answers: loadAnswerBook({ answersPath: join(dir, 'answers.json'), profilePath: join(dir, 'resume.json') }),
          classifier: { classify: async () => ({ malicious: false, score: 0.1, truncated: false }) },
          stopFile: join(dir, 'STOP'), resumeRoot: join(dir, 'renderer', 'automation'), state: tools.createApplierState(), escalate: () => {},
        } as unknown as import('../applier/tools/index.js').ApplierDeps;
        const before = snapshot(db);
        const opened = await tools.handleOpen({ job_id: 'fx-apply' }, deps);
        if (opened.status !== 'ok') return fail(`${mode}: apply_open returned ${opened.status}/${(opened as { code?: string }).code ?? ''}`, 'src/applier/tools/open.ts');
        const submitted = await tools.handleSubmit({}, deps);
        const expected = mode === 'dry' ? 'dry_run' : 'held';
        if (submitted.status !== expected) return fail(`${mode}: apply_submit returned ${submitted.status}, expected ${expected}`, 'src/applier/tools/submit.ts');
        if (site.events.includes('click:control:Submit application')) return fail(`${mode}: the fixture site saw a submit click`, 'src/applier/tools/submit.ts');
        const moved = movedCounters(before, snapshot(db));
        if (moved.length !== 1 || moved[0] !== 'rate_events:apply_attempt') return fail(`${mode}: expected only apply_attempt to move, moved: ${moved.join(', ') || 'nothing'}`, 'src/applier/tools/open.ts');
        results.push(`${mode} ${submitted.status}`);
      } catch (e) {
        return fail(`applier stage (${mode}) crashed: ${firstLine(e)}`);
      } finally {
        try { await runtime?.close(); } catch { /* already closed */ }
        try { db?.close(); } catch { /* already closed */ }
      }
    }
    return pass(`${results.join('; ')}; only apply_attempt moved`);
  },
};
