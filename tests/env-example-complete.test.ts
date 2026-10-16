// Guards .env.example against drifting from the code: every owner-settable environment variable
// the project reads must be listed (as `KEY=` or `# KEY=`), no value line may carry an inline
// comment (the loaders read it as part of the value), and every limits catalog key must be there.
// Hermetic: reads only repository files, never .env.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/setup/limitsCatalog.js';

const ROOT = join(import.meta.dirname, '..');
const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
const lines = example.split(/\r?\n/);

/** Names that are read by the code but are NOT owner configuration, each with the reason. */
const INTERNAL: Record<string, string> = {
  HOME: 'OS variable',
  PATH: 'OS variable',
  TZ: 'OS timezone, passed through to wakes',
  TERM: 'terminal type passed to interactive profiles',
  COLORTERM: 'terminal colour support passed to interactive profiles',
  NO_COLOR: 'standard terminal convention (no-color.org), read by src/ui/term.ts; documented in docs/setup-modes.md',
  FORCE_COLOR: 'standard terminal convention, read by src/ui/term.ts; documented in docs/setup-modes.md',
  VITEST: 'set by the test runner',
  JOBAPPLIER_DB: 'test harness only (vitest.config.ts points it at an in-memory database)',
  JOBBER_RUN_ID: 'set by the scheduler launcher per wake',
  SCHEDULER_RUN_ID: 'set by the scheduler per run',
  JOBBER_RUN_PROFILE: 'set by the restricted runner to the profile name',
  IS_SANDBOX: 'refused if set; never a configuration value',
  CCGRAM_CLAUDE_COMMAND: 'set by scripts/ccgram/run.sh for the bridge',
  HOOK_NO_LOG: 'set by the doctor when it probes the allowlist hook',
  HOOK_PROBE_NO_LOG: 'set by the hook probe test',
  COPYFILE_DISABLE: 'set by the restore code for tar',
  LINKEDIN_NO_MAIN: 'import guard so tests can load the linkedin MCP module',
  APPLIER_NO_MAIN: 'import guard so tests can load the applier MCP module',
  SCOUT_NO_MAIN: 'import guard so tests can load the scout MCP module',
  NAUKRI_NO_MAIN: 'import guard so tests can load the naukri MCP module',
  OUTREACH_NO_MAIN: 'import guard so tests can load the outreach MCP module',
  CLAUDE_PROJECT_DIR: 'set by Claude Code for hooks',
  PLAYWRIGHT_BROWSERS_PATH: 'third-party Playwright variable, read only to locate browsers',
  CAND: 'local shell variable in scripts/bootstrap.sh',
  KEY: 'placeholder in a generic helper',
};

function exampleKeys(): Set<string> {
  const keys = new Set<string>();
  for (const l of lines) {
    const m = /^(?:#\s?)?([A-Z][A-Z0-9_]*)=/.exec(l);
    if (m) keys.add(m[1]!);
  }
  return keys;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.git')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|cjs|mjs|js|sh)$/.test(name)) out.push(p);
  }
}

function envNamesInCode(): Set<string> {
  const files: string[] = [];
  for (const d of ['src', 'scripts', '.claude/hooks']) walk(join(ROOT, d), files);
  files.push(join(ROOT, 'run-hunt.sh'));
  const names = new Set<string>();
  for (const f of files) {
    const t = readFileSync(f, 'utf8');
    for (const m of t.matchAll(/\b(?:[A-Za-z_]*[eE]nv|environ)\??\.([A-Z][A-Z0-9_]{2,})\b/g)) names.add(m[1]!);
    for (const m of t.matchAll(/\benv\??\[\s*['"]([A-Z][A-Z0-9_]{2,})['"]\s*\]/g)) names.add(m[1]!);
    if (f.endsWith('.sh') || f.endsWith('.cjs')) {
      for (const m of t.matchAll(/\$\{([A-Z][A-Z0-9_]{2,}):?[-=?+]/g)) names.add(m[1]!);
    }
  }
  const profiles = JSON.parse(readFileSync(join(ROOT, 'config/run-profiles.json'), 'utf8')) as {
    profiles?: Record<string, { env_keys?: string[] }>;
  } & Record<string, unknown>;
  const all = (profiles.profiles ?? profiles) as Record<string, { env_keys?: string[] }>;
  for (const p of Object.values(all)) {
    if (p && typeof p === 'object' && Array.isArray(p.env_keys)) for (const k of p.env_keys) names.add(k);
  }
  return names;
}

describe('.env.example completeness', () => {
  it('lists every owner-settable environment variable the code reads', () => {
    const keys = exampleKeys();
    const missing = [...envNamesInCode()]
      .filter((n) => !(n in INTERNAL) && !keys.has(n))
      .sort();
    expect(missing, `add to .env.example, or to INTERNAL with a reason: ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps internal names out of .env.example', () => {
    const keys = exampleKeys();
    for (const n of Object.keys(INTERNAL)) {
      expect(keys.has(n), `${n} is internal but appears in .env.example`).toBe(false);
    }
  });

  it('has no inline comment after a value', () => {
    const bad = lines
      .map((l, i) => ({ l, n: i + 1 }))
      .filter(({ l }) => /^[A-Z][A-Z0-9_]*=/.test(l) && l.includes('#'));
    expect(bad.map((b) => `${b.n}: ${b.l}`)).toEqual([]);
  });

  it('every active line is KEY=value with a comment line above it', () => {
    lines.forEach((l, i) => {
      if (!/^[A-Z][A-Z0-9_]*=/.test(l)) return;
      // The line right above must be a comment (the key's own description), never blank.
      expect(lines[i - 1]?.startsWith('#'), `line ${i + 1} (${l.split('=')[0]}) needs a comment above`).toBe(true);
    });
  });

  it('lists every limits catalog key', () => {
    const keys = exampleKeys();
    const missing = LIMITS.map((l) => l.key).filter((k) => !keys.has(k));
    expect(missing).toEqual([]);
  });

  it('uses no em or en dashes', () => {
    expect(example).not.toMatch(/[–—]/);
  });

  it('keeps the dry-run flags at their safe values and secrets blank', () => {
    const val = (k: string): string | undefined => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1);
    expect(val('JOBBER_DRY_RUN')).toBe('1');
    expect(val('SCHEDULER_DRY_RUN')).toBe('true');
    expect(val('LINKEDIN_DRY_RUN')).toBe('true');
    for (const k of ['TELEGRAM_BOT_TOKEN', 'GMAIL_APP_PASSWORD', 'ADZUNA_APP_KEY', 'SERPER_API_KEY', 'HUNTER_API_KEY', 'WEB_OIDC_CLIENT_SECRET', 'CLASSIFIER_MODEL']) {
      expect(val(k), k).toBe('');
    }
  });
});
