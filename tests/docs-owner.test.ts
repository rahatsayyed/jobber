// tests/docs-owner.test.ts
// Lint for the owner docs (plan 8D). The checkers are plain functions so the
// negative fixtures below prove every rule fires.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIMITS } from '../src/setup/limitsCatalog.js';

const OWNER_DOCS: string[] = [
  'docs/00-start-here.md',
  'docs/prerequisites.md',
  'docs/api-keys.md',
  'docs/operations.md',
  'docs/rollout.md',
  'docs/scheduler-install.md',
  'docs/config-reference.md',
  'docs/architecture.md',
  'docs/layout-memory.md',
  'docs/dashboard-login.md',
  'docs/setup-modes.md',
  'docs/index.md',
];
// Docs allowed to be absent until their task lands. A writer removes its own
// line here (one-line edit); Task 13 empties the list.
const PLANNED_ONLY: string[] = [
  'docs/00-start-here.md',
  'docs/index.md',
];

const ENV_ALLOWLIST = /^(HOME|PATH|NODE_ENV|TMPDIR|SHELL|USER|ANTHROPIC_[A-Z_]+|CLAUDE_[A-Z_]+|CI|TERM)$/;
const LOCAL_ONLY_FILES = ['user-data/resume.json', 'user-data/profile.json'];
const FILE_PREFIXES = ['config/', 'docs/', 'scripts/', 'src/', '.claude/', 'tests/'];
const RUNTIME_PREFIXES = ['secrets/', '.jobber/', '.env', 'data.sqlite'];
const SECRET_RE = /AKIA[0-9A-Z]{16}|-----BEGIN|sk-[A-Za-z0-9]{20,}|xox[bp]-/;
const ENV_TOKEN = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;

export function envUniverse(): Set<string> {
  const keys = new Set<string>(LIMITS.map((l: { key: string }) => l.key));
  const text = readFileSync('.env.example', 'utf8');
  for (const m of text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)) keys.add(m[1]);
  return keys;
}

export function documentedEnvVars(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1].trim().split('=')[0].trim();
    if (ENV_TOKEN.test(tok)) out.add(tok);
  }
  let inFence = false;
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9]*_[A-Z0-9_]+)=/);
    if (m) out.add(m[1]);
  }
  return [...out];
}

function npmScripts(): Record<string, string> {
  return JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
}

export function checkScripts(text: string, scripts: Record<string, string> = npmScripts()): string[] {
  const errs: string[] = [];
  for (const m of text.matchAll(/npm run ([\w:.-]+)/g)) {
    if (!scripts[m[1]]) errs.push(`unknown npm script: ${m[1]}`);
  }
  for (const m of text.matchAll(/npx tsx (scripts\/[\w./-]+)/g)) {
    if (!existsSync(m[1])) errs.push(`missing script file: ${m[1]}`);
  }
  return errs;
}

export function checkEnvVars(text: string, universe: Set<string> = envUniverse()): string[] {
  return documentedEnvVars(text)
    .filter((v) => !universe.has(v) && !ENV_ALLOWLIST.test(v))
    .map((v) => `unknown env var: ${v}`);
}

export function checkFiles(text: string): string[] {
  const errs: string[] = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1].trim().replace(/[.,;:]+$/, '');
    if (/[\s*<>{}$|]/.test(tok)) continue;
    if (RUNTIME_PREFIXES.some((p) => tok.startsWith(p))) continue;
    if (tok.startsWith('user-data/')) {
      const rest = tok.slice('user-data/'.length);
      if (!rest || (!/\.[A-Za-z0-9]+$/.test(rest) && !tok.endsWith('/'))) continue;
      if (LOCAL_ONLY_FILES.includes(tok)) continue;
      if (!existsSync(join('user-data.example', rest))) errs.push(`missing user-data example: ${tok}`);
      continue;
    }
    if (!FILE_PREFIXES.some((p) => tok.startsWith(p))) continue;
    if (!/\.[A-Za-z0-9]+$/.test(tok) && !tok.endsWith('/')) continue;
    if (!existsSync(tok)) errs.push(`missing file: ${tok}`);
  }
  return errs;
}

export function checkLinks(text: string, docPath: string, planned: string[] = PLANNED_ONLY): string[] {
  const errs: string[] = [];
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const raw = m[1];
    if (/^(https?:|mailto:|#)/i.test(raw)) continue;
    const target = normalize(join(dirname(docPath), raw.split('#')[0]));
    if (existsSync(target)) continue;
    if (planned.includes(target)) continue;
    errs.push(`broken link: ${raw}`);
  }
  return errs;
}

export function checkMarker(text: string, strict = false, hasGit = existsSync('.git')): string[] {
  const errs: string[] = [];
  const head = text.split('\n').slice(0, 12).join('\n');
  if (!/^Audience: owner\s*$/m.test(head)) errs.push('missing "Audience: owner"');
  if (!/^Source files: \S.*$/m.test(head)) errs.push('missing "Source files: <list>"');
  const v = head.match(/^Last verified against: (.+?)\s*$/m);
  if (!v) {
    errs.push('missing "Last verified against: <value>"');
  } else {
    const val = v[1];
    const isHash = /^[0-9a-f]{7,40}$/.test(val);
    if (val === '<fill at merge>') {
      if (strict) errs.push('strict: Last verified against is not a hash');
    } else if (!isHash) {
      errs.push(`bad Last verified against value: ${val}`);
    } else if (strict && hasGit) {
      try {
        execFileSync('git', ['cat-file', '-e', `${val}^{commit}`], { stdio: 'ignore' });
      } catch {
        errs.push(`hash does not resolve: ${val}`);
      }
    }
  }
  return errs;
}

export function checkSecrets(text: string): string[] {
  const errs: string[] = [];
  if (SECRET_RE.test(text)) errs.push('secret-shaped string');
  if (text.includes('/Users/')) errs.push('absolute /Users/ path');
  return errs;
}

const STRICT = process.env.DOCS_STRICT === '1';
const present = OWNER_DOCS.filter((d) => existsSync(d));
const read = (d: string) => readFileSync(d, 'utf8');

function perDoc(name: string, fn: (text: string, doc: string) => string[]) {
  describe(name, () => {
    if (present.length === 0) it('no owner docs present yet (all PLANNED_ONLY)', () => {});
    for (const d of present) {
      it(d, () => expect(fn(read(d), d)).toEqual([]));
    }
  });
}

perDoc('owner docs: scripts', (t) => checkScripts(t));
perDoc('owner docs: env vars', (t) => checkEnvVars(t));
perDoc('owner docs: files', (t) => checkFiles(t));
perDoc('owner docs: links', (t, d) => checkLinks(t, d));
perDoc('owner docs: marker', (t) => checkMarker(t, STRICT));
perDoc('owner docs: secrets hygiene', (t) => checkSecrets(t));

describe('owner docs: existence', () => {
  it('every doc not in PLANNED_ONLY exists', () => {
    const missing = OWNER_DOCS.filter((d) => !PLANNED_ONLY.includes(d) && !existsSync(d));
    expect(missing).toEqual([]);
  });
  it('PLANNED_ONLY only lists known owner docs', () => {
    expect(PLANNED_ONLY.filter((d) => !OWNER_DOCS.includes(d))).toEqual([]);
  });
});

describe('owner docs lint: negative fixtures', () => {
  const goodHeader = 'Audience: owner\nLast verified against: <fill at merge>\nSource files: src/db.ts\n';
  it('unknown npm script', () => {
    expect(checkScripts('Run `npm run nope` now')).toHaveLength(1);
    expect(checkScripts('npm run doctor')).toEqual([]);
  });
  it('missing tsx script file', () => {
    expect(checkScripts('npx tsx scripts/does-not-exist.ts')).toHaveLength(1);
  });
  it('unknown env var, backticked and fenced', () => {
    expect(checkEnvVars('Set `FAKE_VAR_X` first')).toEqual(['unknown env var: FAKE_VAR_X']);
    expect(checkEnvVars('```\nFAKE_VAR_Y=1\n```')).toEqual(['unknown env var: FAKE_VAR_Y']);
    expect(checkEnvVars('`HOME` and `ANTHROPIC_API_KEY`')).toEqual([]);
    expect(checkEnvVars('`HUNTER_ENABLED=true`')).toEqual([]);
  });
  it('missing file reference', () => {
    expect(checkFiles('See `config/missing.json`')).toHaveLength(1);
    expect(checkFiles('See `user-data/nope-file.json`')).toHaveLength(1);
    expect(checkFiles('See `user-data/resume.json` and `secrets/x.json` and `.env`')).toEqual([]);
    expect(checkFiles('See `package.json` and `src/db.ts`')).toEqual([]);
  });
  it('broken link', () => {
    expect(checkLinks('[x](./nowhere.md)', 'docs/index.md', [])).toHaveLength(1);
    expect(checkLinks('[x](./nowhere.md#a)', 'docs/index.md', ['docs/nowhere.md'])).toEqual([]);
    expect(checkLinks('[x](https://example.com/a)', 'docs/index.md', [])).toEqual([]);
  });
  it('marker problems', () => {
    expect(checkMarker('# Title\n\nbody')).toHaveLength(3);
    expect(checkMarker(goodHeader)).toEqual([]);
    expect(checkMarker(goodHeader, true)).toHaveLength(1);
    expect(checkMarker('Audience: owner\nLast verified against: zzz\nSource files: a\n')).toHaveLength(1);
    expect(checkMarker('Audience: owner\nLast verified against: abcdef1\nSource files: a\n', true, false)).toEqual([]);
    expect(checkMarker('Audience: owner\nLast verified against: 0000000\nSource files: a\n', true, true)).toHaveLength(1);
  });
  it('secrets and absolute paths', () => {
    expect(checkSecrets('key AKIAABCDEFGHIJKLMNOP')).toHaveLength(1);
    expect(checkSecrets('-----BEGIN PRIVATE KEY')).toHaveLength(1);
    expect(checkSecrets('open /Users/someone/x')).toHaveLength(1);
    expect(checkSecrets('plain text')).toEqual([]);
  });
});
