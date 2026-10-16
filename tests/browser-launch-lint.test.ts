// O-browser: only src/linkedin/browser.ts may launch a browser. Everything else goes through the
// shared launcher (re-exported by src/webcore/launch.ts). Hermetic: reads repository sources only.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const HOME = 'src/linkedin/browser.ts';

/** Files that still launch directly. Empty since Task 23 (every browser launch goes through the shared launcher). */
export const LEGACY_LAUNCH_ALLOWLIST: string[] = [
];

/** Permanent, commented exceptions. chromeCheck.ts only import()s patchright to see it resolves. */
const PERMANENT_EXCEPTIONS: Record<string, string> = {};

/** Returns the rule names a source text violates. */
export function launchViolations(src: string): string[] {
  const out: string[] = [];
  if (/[cC]hromium\w*\s*\.\s*launch\w*\s*\(/.test(src)) out.push('chromium.launch');
  if (/\blaunchPersistentContext\b/.test(src)) out.push('launchPersistentContext');
  const imp = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"](playwright|patchright|playwright-core)['"]/g;
  for (const m of src.matchAll(imp)) {
    if (m[1]) continue;
    const names = m[2]!.split(',').map((s) => s.trim()).filter(Boolean);
    if (names.some((n) => !n.startsWith('type ') && /^chromium\b/.test(n))) out.push(`value import of chromium from ${m[3]}`);
  }
  if (/import\s+\*\s+as\s+\w+\s+from\s*['"](playwright|patchright|playwright-core)['"]/.test(src)) out.push('namespace import of a browser library');
  return out;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
}

function scan(): Record<string, string[]> {
  const files: string[] = [];
  for (const d of ['src', 'scripts']) walk(join(ROOT, d), files);
  const hits: Record<string, string[]> = {};
  for (const f of files) {
    const v = launchViolations(readFileSync(f, 'utf8'));
    if (v.length) hits[relative(ROOT, f).split('\\').join('/')] = v;
  }
  return hits;
}

describe('browser launch lint', () => {
  it('flags a fixture file that calls chromium.launch', () => {
    expect(launchViolations("const b = await chromium.launch({ headless: true });")).toContain('chromium.launch');
    expect(launchViolations("const b = await patchrightChromium.launch({});")).toContain('chromium.launch');
    expect(launchViolations('await chromium.launchPersistentContext(dir)')).toContain('launchPersistentContext');
    expect(launchViolations("import { chromium } from 'playwright';")).toHaveLength(1);
    expect(launchViolations("import { chromium as c, type Page } from 'patchright';")).toHaveLength(1);
    expect(launchViolations("import type { Page } from 'playwright';")).toEqual([]);
  });

  it('passes the shared launcher and its facade', () => {
    expect(launchViolations("import { launchRealChrome } from '../linkedin/browser.js';\nawait launchRealChrome({});")).toEqual([]);
    const facade = readFileSync(join(ROOT, 'src/webcore/launch.ts'), 'utf8');
    expect(launchViolations(facade)).toEqual([]);
    expect(facade).not.toMatch(/from\s*['"](playwright|patchright)/);
  });

  it('no file outside the home, the legacy allowlist and the exceptions launches a browser', () => {
    const allowed = new Set([HOME, ...LEGACY_LAUNCH_ALLOWLIST, ...Object.keys(PERMANENT_EXCEPTIONS)]);
    const bad = Object.entries(scan()).filter(([f]) => !allowed.has(f));
    expect(bad, `launch through src/webcore/launch.ts: ${JSON.stringify(bad)}`).toEqual([]);
  });

  it('the legacy launch allowlist is empty (task 23)', () => {
    expect(LEGACY_LAUNCH_ALLOWLIST).toEqual([]);
  });

  it('every allowlisted legacy file still exists and still launches directly', () => {
    const hits = scan();
    for (const f of LEGACY_LAUNCH_ALLOWLIST) {
      expect(existsSync(join(ROOT, f)), `${f} was deleted: remove it from the allowlist`).toBe(true);
      expect(hits[f], `${f} no longer launches directly: remove it from the allowlist`).toBeDefined();
    }
    for (const f of Object.keys(PERMANENT_EXCEPTIONS)) expect(existsSync(join(ROOT, f))).toBe(true);
  });
});
