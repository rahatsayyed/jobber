import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { classify, inventory, knownIds, licenseVerdict, main, renderReport, stripComments } from '../scripts/import-career-ops.js';

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'tests', 'fixtures', 'career-ops-src');
const known = { ids: new Set(['greenhouse', 'jobicy']), imported: new Set(['jobicy']) };

describe('licenseVerdict', () => {
  it('accepts MIT, Apache-2.0, BSD and ISC texts and refuses everything else', () => {
    expect(licenseVerdict(readFileSync(path.join(SRC, 'LICENSE'), 'utf8'))).toEqual({ ok: true, name: 'MIT' });
    expect(licenseVerdict('Apache License\nVersion 2.0, January 2004').ok).toBe(true);
    expect(licenseVerdict('Redistribution and use in source and binary forms, with or without modification ... BSD').ok).toBe(true);
    expect(licenseVerdict('Permission to use, copy, modify, and/or distribute this software for any purpose').name).toBe('ISC');
    expect(licenseVerdict(readFileSync(path.join(SRC, 'LICENSE-NOTPERM.txt'), 'utf8')).ok).toBe(false);
    expect(licenseVerdict('').ok).toBe(false);
    expect(licenseVerdict('GNU GENERAL PUBLIC LICENSE Version 3').ok).toBe(false);
  });
});

describe('classify', () => {
  const src = (n: string) => readFileSync(path.join(SRC, 'providers', `${n}.mjs`), 'utf8');
  it.each([
    ['feedjson', 'json_api', 'board_wide'],
    ['feedrss', 'rss', 'board_wide'],
    ['pagehtml', 'html_list', 'board_wide'],
    ['loginboard', 'needs_login', 'board_wide'],
    ['browserboard', 'needs_js', 'board_wide'],
    ['tenantboard', 'json_api', 'tenant'],
    ['candidatejson', 'json_api', 'board_wide'],
    ['unknownshape', 'unclear', 'board_wide'],
  ])('%s is %s / %s', (id, kind, scope) => {
    expect(classify(src(id), id)).toEqual({ kind, scope });
  });
  it('ignores words that appear only in comments', () => {
    expect(stripComments('// login here\nconst a = 1; // bearer\nconst u = "https://x.test/a";').includes('login')).toBe(false);
    expect(stripComments('const u = "https://x.test/a";')).toContain('https://x.test/a');
    expect(classify('// uses login\nexport default { async fetch(e, c) { return c.fetchJson(FEED_URL); } }; const FEED_URL = 1;', 'x').kind).toBe('json_api');
  });
});

describe('inventory', () => {
  const rows = inventory(SRC, known);
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  it('skips helpers (underscore files, docs) and lists every provider module once', () => {
    expect(rows.map((r) => r.id)).toEqual([
      'browserboard', 'candidatejson', 'feedjson', 'feedrss', 'greenhouse', 'jobicy', 'local-parser', 'loginboard', 'pagehtml', 'tenantboard', 'unknownshape',
    ]);
  });
  it('marks imported, already present and skipped with a reason', () => {
    expect(by.jobicy.status).toBe('imported');
    expect(by.greenhouse.status).toBe('already_present');
    for (const id of ['browserboard', 'candidatejson', 'feedjson', 'feedrss', 'local-parser', 'loginboard', 'pagehtml', 'tenantboard', 'unknownshape']) {
      expect(by[id].status, id).toBe('skipped');
      expect(by[id].reason.length, id).toBeGreaterThan(10);
    }
    expect(by.tenantboard.reason).toMatch(/per-company/);
    expect(by.browserboard.reason).toMatch(/browser/);
    expect(by.feedjson.reason).toMatch(/candidate/);
    expect(by['local-parser'].reason).toMatch(/not a provider/);
  });
});

describe('knownIds', () => {
  it('reads the shipped registry: imported feeds are the providers/ rows', () => {
    const k = knownIds(ROOT);
    expect(k.ids.has('greenhouse')).toBe(true);
    expect(k.imported.has('jobicy')).toBe(true);
    expect(k.imported.has('greenhouse')).toBe(false);
  });
  it('an unreadable registry knows nothing', () => {
    const k = knownIds(mkdtempSync(path.join(tmpdir(), 'jobber-')));
    expect(k.ids.size).toBe(0);
  });
});

describe('renderReport and main', () => {
  it('renders the licence text, the counts and one row per provider', () => {
    const rows = inventory(SRC, known);
    const md = renderReport({ rows, license: 'LICENSE TEXT HERE', licenseName: 'MIT', licenseOk: true, commit: 'abc123', date: '2026-10-16' });
    expect(md).toContain('LICENSE TEXT HERE');
    expect(md).toContain('commit `abc123`');
    expect(md).toContain(`**${rows.length}**`);
    for (const r of rows) expect(md).toContain(`| ${r.id} |`);
    expect(md).toMatch(/Imported in this task: \*\*1\*\*/);
  });

  it('writes the report offline for an MIT source tree and exits 0', () => {
    const out = path.join(mkdtempSync(path.join(tmpdir(), 'jobber-')), 'report.md');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const f = vi.fn(() => { throw new Error('network used'); });
    vi.stubGlobal('fetch', f);
    expect(main(['--src', SRC, '--commit', 'deadbeef', '--out', out, '--date', '2026-10-16'], ROOT)).toBe(0);
    vi.unstubAllGlobals();
    log.mockRestore();
    expect(f).not.toHaveBeenCalled();
    const md = readFileSync(out, 'utf8');
    expect(md).toContain('Licence found: MIT');
    expect(md).toContain('| feedjson |');
  });

  it('a non-permissive licence is a ruling: nothing imported, every row skipped, exit 3', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jobber-'));
    cpSync(SRC, path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'LICENSE'), 'All rights reserved.');
    const out = path.join(dir, 'report.md');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(main(['--src', path.join(dir, 'src'), '--out', out], ROOT)).toBe(3);
    const md = readFileSync(out, 'utf8');
    expect(md).toContain('NOT compatible: no real import');
    expect(md).toMatch(/Imported in this task: \*\*0\*\*/);
    expect(md).not.toMatch(/\| imported \|/);
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a missing LICENSE counts as not permissive, a missing --src prints usage and exits 2', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'jobber-'));
    cpSync(path.join(SRC, 'providers'), path.join(dir, 'src', 'providers'), { recursive: true });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(main(['--src', path.join(dir, 'src'), '--out', path.join(dir, 'r.md')], ROOT)).toBe(3);
    expect(existsSync(path.join(dir, 'r.md'))).toBe(true);
    expect(main([], ROOT)).toBe(2);
    expect(main(['--src', path.join(dir, 'nope')], ROOT)).toBe(2);
    vi.restoreAllMocks();
  });

  it('the script imports no network module', () => {
    const t = readFileSync(path.join(ROOT, 'scripts', 'import-career-ops.ts'), 'utf8');
    expect(t).not.toMatch(/node:https?|node:net|\bfetch\(|child_process|undici/);
  });
});
