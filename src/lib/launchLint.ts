// Browser-launch scan used by the doctor `browser_launch` check (plan 8G-2 task 24). Mirrors the rules of
// tests/browser-launch-lint.test.ts: only src/linkedin/browser.ts may launch a browser; every other file goes
// through the shared launcher (src/webcore/launch.ts). Read-only, no network.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const LAUNCH_HOME = 'src/linkedin/browser.ts';
export const LINT_TEST_FILE = 'tests/browser-launch-lint.test.ts';

/** Returns the rule names a source text violates. */
export function launchViolations(src: string): string[] {
  const out: string[] = [];
  if (/[cC]hromium\w*\s*\.\s*launch\w*\s*\(/.test(src)) out.push('chromium.launch');
  // Built from two pieces so this scanner does not match its own rule (the lint test scans src/).
  const persistent = 'launchPersistent' + 'Context';
  if (new RegExp(`\\b${persistent}\\b`).test(src)) out.push(persistent);
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
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.ts')) out.push(p);
  }
}

/** Every file under src/ and scripts/ that launches a browser directly, as repo-relative path -> rule names. */
export function scanLaunches(root: string): Record<string, string[]> {
  const files: string[] = [];
  for (const d of ['src', 'scripts']) walk(join(root, d), files);
  const hits: Record<string, string[]> = {};
  for (const f of files) {
    const v = launchViolations(readFileSync(f, 'utf8'));
    if (v.length) hits[relative(root, f).split('\\').join('/')] = v;
  }
  return hits;
}

/**
 * The legacy allowlist lives in the lint test (the 8G-1 branch edits it there); read it from that file so there is
 * one source. A missing test file means an empty list (a shipped install without tests/ has no legacy launchers).
 */
export function legacyAllowlist(root: string): string[] {
  const p = join(root, LINT_TEST_FILE);
  if (!existsSync(p)) return [];
  const block = /LEGACY_LAUNCH_ALLOWLIST: string\[\] = \[([\s\S]*?)\];/.exec(readFileSync(p, 'utf8'))?.[1] ?? '';
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}
