// scout_capture_fixture (plan 8G task 7): stores the current task page's HTML (scripts, hidden inputs and
// input values removed) under generated/fixtures/<platform>/ for Task 8's generated providers. The
// content is never returned to the model. A dry run records the action and writes nothing.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isDryRun, recordDryRun } from '../../safety/dryRun.js';
import { FIXTURE_HTML_SCRIPT } from '../page.js';
import { hostOfUrl, json, type ScoutCtx } from './common.js';
import { taskOnPage } from './jobs.js';

const MAX_BYTES = 1_000_000;

export async function scoutCaptureFixture(a: { task_id: number }, deps: ScoutCtx): Promise<string> {
  const t = taskOnPage(deps, a?.task_id);
  if (!t.ok) return t.out;
  const platform = t.target.platform.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40) || 'unknown';
  const host = hostOfUrl(t.url);
  if (isDryRun(deps.env, { web: true })) {
    recordDryRun(deps.db, { runId: null, action: 'scout_capture_fixture', platform: 'web', payload: { task_id: t.row.id, platform, host } }, deps.now(), deps.env);
    return json({ ok: true, status: 'dry_run' });
  }
  const html = await deps.runtime.serial(async () => deps.runtime.page()?.evaluate<string>(FIXTURE_HTML_SCRIPT) ?? null);
  if (typeof html !== 'string' || html.length === 0) return json({ ok: false, code: 'failed' });
  const dir = path.join(deps.generatedRoot, 'fixtures', platform);
  const root = path.resolve(deps.generatedRoot, 'fixtures');
  if (!path.resolve(dir).startsWith(root + path.sep)) return json({ ok: false, code: 'refused', reason: 'bad_path' });
  mkdirSync(dir, { recursive: true });
  const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
  const body = `<!-- captured by scout_capture_fixture; untrusted page content; host: ${host} -->\n${html}`.slice(0, MAX_BYTES);
  for (let n = 0; n < 50; n++) {
    const file = path.join(dir, `${stamp}${n ? `-${n}` : ''}.html`);
    try {
      writeFileSync(file, body, { flag: 'wx', mode: 0o600 });
      return json({ ok: true, status: 'captured', path: path.relative(deps.generatedRoot, file), bytes: body.length });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return json({ ok: false, code: 'failed' });
    }
  }
  return json({ ok: false, code: 'failed' });
}
