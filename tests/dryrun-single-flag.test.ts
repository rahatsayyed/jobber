// One master dry-run flag, JOBBER_DRY_RUN: parity with the hook, reach into wakes and MCP children,
// every path follows it, legacy keys ignored, .env.example lint.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDryRun, parseDryFlag, LEGACY_DRY_RUN_KEYS } from '../src/safety/dryRun.js';
import { loadLinkedinConfig } from '../src/linkedin/config.js';
import { loadWebConfig } from '../src/webcore/config.js';
import { wakeIsDry, childEnv } from '../src/scheduler/driver.js';
import { buildRunnerArgv } from '../src/scheduler/launch.js';
import { buildEnv, loadProfiles } from '../src/platform/runner.js';
import { currentUse } from '../src/safety/classifierSelect.js';
import { currentMode } from '../src/stack/mode.js';

const hook = createRequire(import.meta.url)('../.claude/hooks/kill-switch.cjs') as {
  parseDryFlag: (v: unknown) => boolean;
  decide: (e: unknown, o: { root: string; env: Record<string, string | undefined> }) => { allow: boolean; reason: string };
};
const VALUES: Array<string | undefined> = [
  undefined, '', ' ', '1', '0', 'true', 'TRUE', ' True ', ' 1 ', 'false', 'False', 'yes', 'no', 'on', 'off', 'dry', '2', 'tru', 'true;', '\ttrue\n',
];
const GMAIL = { tool_name: 'mcp__gmail__send_email' };
const root = process.cwd();

describe('parse: unset is live, only 1/true (trimmed, any case) is dry', () => {
  it.each([
    [undefined, false], ['', false], ['false', false], ['0', false], ['yes', false],
    ['1', true], ['true', true], [' TRUE ', true],
  ])('%j -> %s', (v, want) => {
    expect(isDryRun({ JOBBER_DRY_RUN: v })).toBe(want);
    expect(isDryRun({})).toBe(false);
  });
  it('legacy keys are ignored whatever their value', () => {
    for (const k of LEGACY_DRY_RUN_KEYS) for (const v of ['true', 'false', '1', '0']) {
      expect(isDryRun({ [k]: v }), `${k}=${v}`).toBe(false);
      expect(isDryRun({ [k]: v, JOBBER_DRY_RUN: 'true' })).toBe(true);
      expect(isDryRun({ [k]: v, JOBBER_DRY_RUN: 'false' })).toBe(false);
    }
  });
});

describe('hook parity with the TS parse', () => {
  it('parseDryFlag agrees on every sample, including non-strings', () => {
    for (const v of VALUES) expect(hook.parseDryFlag(v), JSON.stringify(v)).toBe(parseDryFlag(v));
    for (const v of [null, 1, true, {}, []]) expect(hook.parseDryFlag(v)).toBe(false);
  });
  it('the Gmail send denial follows exactly the same decision', () => {
    for (const v of VALUES) {
      const r = hook.decide(GMAIL, { root: join(root, 'tests'), env: { JOBBER_DRY_RUN: v } });
      expect(r.allow, JSON.stringify(v)).toBe(!isDryRun({ JOBBER_DRY_RUN: v }));
    }
    for (const k of LEGACY_DRY_RUN_KEYS) {
      expect(hook.decide(GMAIL, { root: join(root, 'tests'), env: { [k]: 'true' } }).allow).toBe(true);
    }
    expect(hook.decide({ tool_name: 'mcp__db__list_jobs' }, { root: join(root, 'tests'), env: { JOBBER_DRY_RUN: 'true' } }).allow).toBe(true);
  });
});

describe('every path follows the single flag', () => {
  const dry = { JOBBER_DRY_RUN: 'true' };
  const live = { JOBBER_DRY_RUN: 'false' };
  it('linkedin, web (scout, applier, login), scheduler, classifier, stack mode', () => {
    for (const [env, want] of [[dry, true], [live, false], [{}, false]] as const) {
      expect(loadLinkedinConfig(env).dryRun).toBe(want);
      expect(loadWebConfig(env).dryRun).toBe(want);
      expect(wakeIsDry(env)).toBe(want);
      expect(currentUse(env)).toBe(want ? 'dry_run' : 'send');
      expect(currentMode(env).mode).toBe(want ? 'DRY RUN' : 'LIVE');
    }
  });
  it('the scheduler launcher emits only the master flag, and the child env carries no dry key', () => {
    const base = { runId: 'abcd1234', promptPath: '/r/p', logPath: '/r/l', exitPath: '/r/e' };
    expect(buildRunnerArgv({ ...base, dryRun: true })).toContain('JOBBER_DRY_RUN=true');
    expect(buildRunnerArgv({ ...base, dryRun: false })).toContain('JOBBER_DRY_RUN=false');
    expect(Object.keys(childEnv({ JOBBER_DRY_RUN: 'true', SCHEDULER_DRY_RUN: 'true' }, true)).filter((k) => /DRY_RUN/.test(k))).toEqual([]);
  });
  it('no source file reads a retired *_DRY_RUN key', () => {
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|cjs|js)$/.test(n)) {
          const t = readFileSync(p, 'utf8');
          // the one allowed mention is the legacy key list in the guard itself
          if (/\b(SCHEDULER|LINKEDIN|WEB|APPLY|SCOUT)_DRY_RUN\b/.test(t) && !p.endsWith(join('safety', 'dryRun.ts')) && !p.endsWith('envCatalog.ts')) hits.push(p);
        }
      }
    };
    for (const d of ['src', 'scripts', '.claude/hooks']) walk(join(root, d));
    expect(hits).toEqual([]);
  });
});

describe('JOBBER_DRY_RUN reaches wake runs and every MCP child', () => {
  const profiles = loadProfiles('config/run-profiles.json', 'config/permission-sets.json');
  it('the outreach_wake profile passes it through buildEnv', () => {
    const p = profiles.outreach_wake;
    expect(p.env_keys).toContain('JOBBER_DRY_RUN');
    for (const v of ['true', 'false', '1']) expect(buildEnv(p, { JOBBER_DRY_RUN: v, SOME_API_KEY: 's' }, {}).JOBBER_DRY_RUN).toBe(v);
    for (const k of LEGACY_DRY_RUN_KEYS) expect(p.env_keys).not.toContain(k);
  });
  it('no server in .mcp.json overrides or drops it (children inherit the launcher env)', () => {
    const servers = JSON.parse(readFileSync('.mcp.json', 'utf8')).mcpServers as Record<string, { env?: Record<string, string>; args?: string[] }>;
    expect(Object.keys(servers).length).toBeGreaterThanOrEqual(11);
    for (const [name, s] of Object.entries(servers)) {
      expect(Object.keys(s.env ?? {}), name).not.toContain('JOBBER_DRY_RUN');
      expect(Object.keys(s.env ?? {}).filter((k) => /_DRY_RUN$/.test(k)), name).toEqual([]);
    }
  });
  it('each in-repo MCP server decides dry run through isDryRun on its env, never a legacy key', () => {
    const servers = JSON.parse(readFileSync('.mcp.json', 'utf8')).mcpServers as Record<string, { args?: string[] }>;
    for (const [name, s] of Object.entries(servers)) {
      const file = (s.args ?? []).find((a) => a.startsWith('src/mcp/'));
      if (!file) continue;
      const text = readFileSync(file, 'utf8');
      expect(text, name).not.toMatch(/(SCHEDULER|LINKEDIN|WEB|APPLY|SCOUT)_DRY_RUN/);
    }
  });
});

describe('.env.example lint', () => {
  const lines = readFileSync('.env.example', 'utf8').split('\n');
  it('has exactly one dry-run line, JOBBER_DRY_RUN=true, with an explanatory comment above', () => {
    const dryLines = lines.filter((l) => /^\s*#?\s*[A-Z0-9_]*DRY_RUN[A-Z0-9_]*\s*=/.test(l));
    expect(dryLines).toEqual(['JOBBER_DRY_RUN=true']);
    const i = lines.indexOf('JOBBER_DRY_RUN=true');
    expect(lines[i - 1]).toMatch(/^#/);
    const comment = lines.slice(Math.max(0, i - 8), i).join(' ');
    expect(comment).toMatch(/Copying this file to \.env gives true = DRY RUN/);
    expect(comment).toMatch(/Remove the line or set false = LIVE/);
  });
});
