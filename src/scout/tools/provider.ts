// scout_propose_provider (plan 8G task 8): the agent proposes a declarative provider spec for a source task. Code validates it
// (schema, fixture replay, hidden-field check). The spec is stored as DATA under the git-ignored generated directory and is only
// ever interpreted by the fixed engine. The result is a state and a fixed reason code, never spec or page text.
import { isDryRun, recordDryRun } from '../../safety/dryRun.js';
import { proposeProvider } from '../../sources/generated/store.js';
import { genMinJobs } from '../../sources/generated/validate.js';
import { getTask, json, type ScoutCtx } from './common.js';

const OPEN_STATES = ['queued', 'running'];
const platformId = (p: string): string => p.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'unknown';

export async function scoutProposeProvider(a: { task_id: number; spec: unknown }, deps: ScoutCtx): Promise<string> {
  const row = getTask(deps.db, a?.task_id);
  if (!row || !OPEN_STATES.includes(row.state)) return json({ ok: false, code: 'refused', reason: 'unknown_or_closed_task' });
  const want = platformId(row.platform);
  const specId = a.spec && typeof a.spec === 'object' ? (a.spec as { id?: unknown }).id : undefined;
  // The spec must be for this task's platform: fixtures were captured under generated/fixtures/<platform>/.
  if (specId !== want) return json({ ok: false, code: 'refused', reason: 'spec_id_mismatch' });
  if (isDryRun(deps.env)) {
    recordDryRun(deps.db, { runId: null, action: 'scout_propose_provider', platform: 'web', payload: { task_id: row.id, id: want } }, deps.now(), deps.env);
    return json({ ok: true, status: 'dry_run' });
  }
  const r = proposeProvider(deps.db, deps.generatedRoot, a.spec, { minJobs: genMinJobs(deps.env), now: deps.now(), taskId: row.id });
  if (r.code === 'exists' || r.code === 'bad_path') return json({ ok: false, code: 'refused', reason: r.code });
  return json({ ok: r.ok, state: r.state ?? 'candidate', ...(r.ok ? { jobs: r.validation?.jobs ?? 0 } : { reason: r.code ?? 'invalid' }) });
}
