// tests/readme.test.ts
// Guards README drift: scripts, links, step ids, permission sets, and leaked paths or secrets.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_STEPS } from '../src/setup/steps/index.js';

const root = resolve(import.meta.dirname, '..');
const readme = readFileSync(resolve(root, 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const sets = JSON.parse(readFileSync(resolve(root, 'config/permission-sets.json'), 'utf8')) as Record<string, unknown>;

function section(heading: RegExp): string {
  const lines = readme.split('\n');
  const start = lines.findIndex((l) => /^#{1,3} /.test(l) && heading.test(l));
  if (start < 0) return '';
  const out: string[] = [];
  const level = (lines[start].match(/^#+/) as RegExpMatchArray)[0].length;
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^(#+) /);
    if (m && m[1].length <= level) break;
    out.push(l);
  }
  return out.join('\n');
}

describe('README', () => {
  it('names only npm scripts that exist', () => {
    const names = [...readme.matchAll(/npm run ([A-Za-z0-9:_-]+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(pkg.scripts[n], `npm run ${n}`).toBeDefined();
  });

  it('has relative links that resolve', () => {
    const links = [...readme.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      if (/^(https?:|mailto:|#)/.test(l)) continue;
      const p = l.split('#')[0];
      expect(existsSync(resolve(root, p)), l).toBe(true);
    }
  });

  it('mentions only scripts that exist', () => {
    const files = [
      ...[...readme.matchAll(/npx tsx (scripts\/[A-Za-z0-9_./-]+)/g)].map((m) => m[1]),
      ...[...readme.matchAll(/bash (scripts\/[A-Za-z0-9_./-]+)/g)].map((m) => m[1]),
    ];
    for (const f of files) expect(existsSync(resolve(root, f)), f).toBe(true);
  });

  it('names only real repo files in code spans', () => {
    const spans = [...readme.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]);
    for (const sp of spans) {
      if (/[<>*{}|]/.test(sp)) continue;
      if (/^(scripts|src|config|docs|\.claude)\/.*\.[A-Za-z]+$/.test(sp)) {
        expect(existsSync(resolve(root, sp)), sp).toBe(true);
      }
    }
    for (const m of readme.matchAll(/\.\/([A-Za-z0-9_.-]+\.sh)/g)) {
      expect(existsSync(resolve(root, m[1])), m[1]).toBe(true);
    }
  });

  it('uses only real step ids with --step', () => {
    const ids = ALL_STEPS.map((s) => s.id);
    const used = [...readme.matchAll(/--step ([a-z0-9-]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const u of used) expect(ids, u).toContain(u);
  });

  it('lists exactly the setup step ids', () => {
    const ids = ALL_STEPS.map((s) => s.id);
    const body = section(/What setup does/i);
    const listed = [...body.matchAll(/^- `([a-z0-9-]+)`/gm)].map((m) => m[1]);
    expect(listed.length).toBeGreaterThan(0);
    for (const id of listed) expect(ids, id).toContain(id);
    for (const id of ids) expect(readme, id).toContain('`' + id + '`');
    expect(listed).toEqual(ids);
  });

  it('names only real permission sets', () => {
    const body = section(/Permission sets/i);
    const names = [...body.matchAll(/^- `([a-z_]+)`/gm)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(Object.keys(sets), n).toContain(n);
    for (const k of Object.keys(sets)) expect(names, k).toContain(k);
  });

  it('has no machine paths, personal data or secrets', () => {
    expect(readme).not.toMatch(/\/Users\//);
    expect(readme).not.toMatch(/\/home\//);
    expect(readme).not.toMatch(/C:\\/);
    expect(readme).not.toMatch(/@gmail\.com/);
    expect(readme).not.toMatch(/\d{5,}:[A-Za-z0-9_-]{10,}/);
    expect(readme).not.toMatch(/sk-[A-Za-z0-9_-]{10,}/);
    expect(readme).not.toMatch(/Bearer /);
    const secretLine = /^[ \t]*[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API_KEY|APP_KEY)[A-Z0-9_]*=(.*)$/gm;
    for (const m of readme.matchAll(secretLine)) {
      const v = m[2].trim();
      expect(v === '' || /^(<.*>|YOUR|\.\.\.|changeme|xxx)/i.test(v), m[0]).toBe(true);
    }
  });

  it('keeps the stale claims out', () => {
    expect(readme).not.toMatch(/bypassPermissions/);
    expect(readme).not.toMatch(/MATCH_THRESHOLD[^\n]*\b70\b/);
    expect(readme).toMatch(/MATCH_THRESHOLD[^\n]*\b60\b/);
  });

  it('has the required headings', () => {
    const heads = readme.split('\n').filter((l) => /^#{1,3} /.test(l));
    const need = [
      /What Jobber is/i,
      /Prerequisites/i,
      /Quick start/i,
      /What setup does/i,
      /Where your data lives/i,
      /Permission sets/i,
      /Starting and stopping sessions/i,
      /Status commands/i,
      /Safety model/i,
      /Links/i,
    ];
    for (const re of need) expect(heads.some((h) => re.test(h)), String(re)).toBe(true);
    expect(readme).toContain('Status web page');
  });
});
