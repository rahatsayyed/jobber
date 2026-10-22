// tests/scheduler-env-through-runner.test.ts
// The env the launcher puts on the `env K=V` command line must survive buildEnv for the wake profile,
// and the output_format profile field drives the claude argv.
import { describe, it, expect } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { buildRunnerArgv } from '../src/scheduler/launch.js';
import { buildClaudeArgs, buildEnv, loadProfiles } from '../src/platform/runner.js';

const profiles = loadProfiles('config/run-profiles.json', 'config/permission-sets.json');
// Send-capable fixture profile (the real `hunt` profile was removed in plan 8G Task 14).
const hunt = loadProfiles('tests/fixtures/runner-send-profile.json', 'config/permission-sets.json').hunt;

function childEnv(dryRun: boolean, extra: Record<string, string>): Record<string, string> {
  const argv = buildRunnerArgv({
    runId: 'abcd1234', dryRun, promptPath: '/r/p', logPath: '/r/l', exitPath: '/r/e',
    env: { ...extra },
  });
  const start = argv.indexOf('env') + 1;
  const end = argv.indexOf('npx');
  const env: Record<string, string> = {};
  for (const item of argv.slice(start, end)) {
    const eq = item.indexOf('=');
    env[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return env;
}

describe('wake env survives the runner allowlist', () => {
  for (const dry of [true, false]) {
    it(`keeps the four run keys (dry=${dry}) and drops unlisted secrets`, () => {
      const base = childEnv(dry, { SOME_API_KEY: 'secret', LINKEDIN_MAX_INVITES_PER_WEEK: '5' });
      const out = buildEnv(profiles.outreach_wake, base, {});
      expect(out.JOBBER_RUN_ID).toBe('abcd1234');
      expect(out.JOBBER_DRY_RUN).toBe(dry ? 'true' : 'false');
      expect(Object.keys(out).filter((k) => /^(SCHEDULER|LINKEDIN|WEB|APPLY|SCOUT)_DRY_RUN$/.test(k))).toEqual([]);
      expect(out.SOME_API_KEY).toBeUndefined();
      expect(out.LINKEDIN_MAX_INVITES_PER_WEEK).toBe('5');
    });
  }
  it('the hunt profile is unaffected (dotenv_all, json output)', () => {
    expect(hunt.env_mode).toBe('dotenv_all');
    expect(hunt.output_format).toBeUndefined();
    const out = buildEnv(hunt, { JOBBER_RUN_ID: 'x', SOME_API_KEY: 's' }, {});
    expect(out.JOBBER_RUN_ID).toBeUndefined();
    expect(out.SOME_API_KEY).toBeUndefined();
  });
});

describe('output_format', () => {
  const paths = { settingsPath: 's.json' };
  it('wake uses stream-json with --verbose (golden)', () => {
    expect(profiles.outreach_wake.output_format).toBe('stream-json');
    const a = buildClaudeArgs('outreach_wake', profiles.outreach_wake, paths);
    const i = a.indexOf('--output-format');
    expect(a.slice(i, i + 3)).toEqual(['--output-format', 'stream-json', '--verbose']);
  });
  it('json stays the default and adds no --verbose (golden)', () => {
    const a = buildClaudeArgs('hunt', hunt, paths);
    const i = a.indexOf('--output-format');
    expect(a.slice(i, i + 3)).toEqual(['--output-format', 'json', '--permission-mode']);
    expect(a).not.toContain('--verbose');
    expect(buildClaudeArgs('x', { ...hunt, output_format: 'json' }, paths)).toEqual(a);
  });
  it('loadProfiles rejects an unknown output_format', () => {
    const dir = '.tmp-output-format-test';
    mkdirSync(dir, { recursive: true });
    const raw = JSON.parse(readFileSync('config/run-profiles.json', 'utf8'));
    raw.profiles.outreach_wake.output_format = 'text';
    writeFileSync(`${dir}/p.json`, JSON.stringify(raw));
    try {
      expect(() => loadProfiles(`${dir}/p.json`, 'config/permission-sets.json')).toThrow(/output_format/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
