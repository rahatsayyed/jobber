// scout_tasks / scout_task_update / scout_extract_jobs / scout_save_jobs (plan 8G task 7). Extraction is the
// closed extractor in code; saving goes through the same saveJob as list_new_jobs, with a cross-source
// duplicate check on the normalized company and title. A dry run saves nothing and records the action.
import { isSeen, saveJob } from '../../db.js';
import { companyKey, titleIdentityKey } from '../../reposts.js';
import { isDryRun, recordDryRun } from '../../safety/dryRun.js';
import { loadRegistry } from '../../sources/registry.js';
import { hostAllowed } from '../../webcore/runtime.js';
import { ANCHORS_SCRIPT, type RawAnchorPage } from '../page.js';
import { extractJobs } from '../extract.js';
import { customSites, resolveTaskTarget, type TaskRow } from '../targets.js';
import { blockedJson, getTask, json, untrustedBlock, type ScoutCtx } from './common.js';

const OPEN_STATES = ['queued', 'running'];

/** Queued source_tasks rows (plus one row per enabled `custom` site, created once while none is open). */
export async function scoutTasks(_a: unknown, deps: ScoutCtx): Promise<string> {
  const at = deps.now().toISOString();
  for (const s of customSites(deps.portalsPath)) {
    const open = deps.db.prepare("SELECT 1 FROM source_tasks WHERE platform = 'custom' AND company = ? AND state IN ('queued','running')").get(s.name);
    if (!open) {
      deps.db.prepare("INSERT INTO source_tasks (platform, company, reason, state, created_at, updated_at) VALUES ('custom', ?, 'new_site', 'queued', ?, ?)").run(s.name, at, at);
    }
  }
  const rows = deps.db.prepare("SELECT id, platform, company, reason, state FROM source_tasks WHERE state IN ('queued','running') ORDER BY id LIMIT 20").all() as TaskRow[];
  return json({
    ok: true,
    tasks: rows.map((r) => {
      const t = resolveTaskTarget(r, deps.portalsPath);
      return { task_id: r.id, platform: r.platform, company: r.company, reason: r.reason, state: r.state, has_target: !!t, ...(t ? { url: t.url } : {}) };
    }),
  });
}

export async function scoutTaskUpdate(a: { task_id: number; state: 'done' | 'failed' }, deps: ScoutCtx): Promise<string> {
  const row = getTask(deps.db, a?.task_id);
  if (!row) return json({ ok: false, code: 'refused', reason: 'unknown_task' });
  if (a.state !== 'done' && a.state !== 'failed') return json({ ok: false, code: 'refused', reason: 'invalid_state' });
  if (!OPEN_STATES.includes(row.state)) return json({ ok: false, code: 'refused', reason: 'task_not_open' });
  deps.db.prepare('UPDATE source_tasks SET state = ?, updated_at = ? WHERE id = ?').run(a.state, deps.now().toISOString(), row.id);
  deps.pending.delete(row.id);
  return json({ ok: true, task_id: row.id, state: a.state });
}

/** The task's own board: refuses unless the open page is on one of the task's hosts. */
export function taskOnPage(deps: ScoutCtx, taskId: number): { ok: true; row: TaskRow; target: NonNullable<ReturnType<typeof resolveTaskTarget>>; url: string } | { ok: false; out: string } {
  const row = getTask(deps.db, taskId);
  if (!row || !OPEN_STATES.includes(row.state)) return { ok: false, out: json({ ok: false, code: 'refused', reason: 'unknown_or_closed_task' }) };
  const target = resolveTaskTarget(row, deps.portalsPath);
  if (!target) return { ok: false, out: json({ ok: false, code: 'refused', reason: 'no_target' }) };
  const page = deps.runtime.page();
  if (!page) return { ok: false, out: json({ ok: false, code: 'no_session' }) };
  const url = page.url();
  if (!hostAllowed(url, target.hosts)) return { ok: false, out: json({ ok: false, code: 'refused', reason: 'page_not_task_host' }) };
  return { ok: true, row, target, url };
}

export async function scoutExtractJobs(a: { task_id: number }, deps: ScoutCtx): Promise<string> {
  const t = taskOnPage(deps, a?.task_id);
  if (!t.ok) return t.out;
  const raw = await deps.runtime.serial(async () => deps.runtime.page()?.evaluate<RawAnchorPage>(ANCHORS_SCRIPT) ?? null);
  if (!raw) return json({ ok: false, code: 'failed' });
  const jobs = extractJobs(raw, { platform: t.target.platform, company: t.target.company, hosts: t.target.hosts });
  if (jobs.length === 0) return json({ ok: true, count: 0 });
  const lines = jobs.slice(0, 30).map((j, i) => `${i + 1}. ${j.title} | ${j.url}`);
  const v = await deps.screen(lines.join('\n'), 'read');
  if (v.blocked) return blockedJson(v);
  deps.pending.set(t.row.id, jobs);
  return json({ ok: true, count: jobs.length, ...(v.unscreened ? { classifier: 'unscreened' } : {}), jobs: untrustedBlock(v.text) });
}

const SOURCE_RE = /^(gen:[a-z0-9][a-z0-9-]{0,39}|[a-z0-9][a-z0-9-]{0,39})$/;

export async function scoutSaveJobs(a: { task_id: number; source: string }, deps: ScoutCtx): Promise<string> {
  const row = getTask(deps.db, a?.task_id);
  if (!row || !OPEN_STATES.includes(row.state)) return json({ ok: false, code: 'refused', reason: 'unknown_or_closed_task' });
  const source = String(a?.source ?? '');
  const target = resolveTaskTarget(row, deps.portalsPath);
  const registryIds = new Set(loadRegistry(deps.registryPath).platforms.map((p) => p.id));
  const okSource = SOURCE_RE.test(source) && (source.startsWith('gen:') ? !!target && source === `gen:${target.platform}` : registryIds.has(source));
  if (!okSource) return json({ ok: false, code: 'refused', reason: 'invalid_source' });
  const jobs = deps.pending.get(row.id);
  if (!jobs || jobs.length === 0) return json({ ok: false, code: 'refused', reason: 'nothing_extracted' });
  if (isDryRun(deps.env, { web: true })) {
    recordDryRun(deps.db, { runId: null, action: 'scout_save_jobs', platform: 'web', payload: { task_id: row.id, source, count: jobs.length, host: target?.hosts[0] ?? '' } }, deps.now(), deps.env);
    return json({ ok: true, status: 'dry_run', would_save: jobs.length });
  }
  const recent = deps.db
    .prepare("SELECT company_key, title_key FROM jobs WHERE created_at >= datetime('now', '-30 days') AND company_key IS NOT NULL AND title_key IS NOT NULL")
    .all() as Array<{ company_key: string; title_key: string }>;
  const keys = new Set(recent.map((r) => `${r.company_key}|${r.title_key}`));
  let saved = 0, known = 0, duplicates = 0;
  for (const j of jobs) {
    if (isSeen(deps.db, j.id)) { known++; continue; }
    const k = `${companyKey(j.company)}|${titleIdentityKey(j.title)}`;
    if (keys.has(k)) { duplicates++; continue; }
    saveJob(deps.db, { ...j, source });
    keys.add(k);
    saved++;
  }
  deps.pending.delete(row.id);
  return json({ ok: true, status: 'saved', saved, known, duplicates });
}
