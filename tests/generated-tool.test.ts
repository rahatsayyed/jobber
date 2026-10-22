import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { scoutProposeProvider } from '../src/scout/tools/provider.js';
import type { ScoutCtx } from '../src/scout/tools/common.js';
import { getProvider } from '../src/sources/generated/store.js';
import { baseSpec } from './helpers/genSpec.js';

const LIVE = { JOBBER_DRY_RUN: 'false' } as NodeJS.ProcessEnv;
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'jobber-gen-tool-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function ctx(env: NodeJS.ProcessEnv) {
  const db = openDb(':memory:');
  const c = { db, env, now: () => new Date('2026-10-16T10:00:00Z'), generatedRoot: root } as unknown as ScoutCtx;
  const task = (platform: string, state = 'queued') => Number(db.prepare("INSERT INTO source_tasks (platform, company, reason, state, created_at, updated_at) VALUES (?, NULL, 'shape', ?, 'n', 'n')").run(platform, state).lastInsertRowid);
  return { db, c, task };
}
const body = (s: string) => JSON.parse(s);
function fixture(): void {
  const dir = path.join(root, 'fixtures', 'acme');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'a.html'), readFileSync('tests/fixtures/web/listing-a.html', 'utf8'));
}

describe('scout_propose_provider', () => {
  it('validates a spec against the captured fixture and reports only a state', async () => {
    const { db, c, task } = ctx(LIVE);
    fixture();
    const t = task('acme');
    const out = body(await scoutProposeProvider({ task_id: t, spec: baseSpec() }, c));
    expect(out).toEqual({ ok: true, state: 'validated', jobs: 3 });
    expect(getProvider(db, 'acme')).toMatchObject({ state: 'validated', task_id: t });
  });

  it('a failing spec returns a fixed reason code and stays candidate', async () => {
    const { db, c, task } = ctx(LIVE);
    const t = task('acme');
    expect(body(await scoutProposeProvider({ task_id: t, spec: baseSpec() }, c))).toEqual({ ok: false, state: 'candidate', reason: 'no_fixture' });
    fixture();
    expect(body(await scoutProposeProvider({ task_id: t, spec: baseSpec({ item: { selector: 'li:has(a)' } }) }, c))).toMatchObject({ ok: false, reason: 'schema' });
    expect(getProvider(db, 'acme')).toMatchObject({ state: 'candidate' });
  });

  it('refuses an unknown or closed task and a spec id that is not the task platform', async () => {
    const { c, task } = ctx(LIVE);
    fixture();
    expect(body(await scoutProposeProvider({ task_id: 999, spec: baseSpec() }, c))).toMatchObject({ ok: false, reason: 'unknown_or_closed_task' });
    expect(body(await scoutProposeProvider({ task_id: task('acme', 'done'), spec: baseSpec() }, c))).toMatchObject({ reason: 'unknown_or_closed_task' });
    expect(body(await scoutProposeProvider({ task_id: task('other'), spec: baseSpec() }, c))).toMatchObject({ reason: 'spec_id_mismatch' });
  });

  it('dry run writes nothing and records the action', async () => {
    const { db, c, task } = ctx({ JOBBER_DRY_RUN: 'true' });
    fixture();
    expect(body(await scoutProposeProvider({ task_id: task('acme'), spec: baseSpec() }, c))).toEqual({ ok: true, status: 'dry_run' });
    expect(existsSync(path.join(root, 'providers'))).toBe(false);
    expect(getProvider(db, 'acme')).toBeUndefined();
    expect((db.prepare('SELECT action FROM dry_run_actions').all() as Array<{ action: string }>).map((r) => r.action)).toEqual(['scout_propose_provider']);
  });
});
