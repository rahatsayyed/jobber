import { describe, it, expect } from 'vitest';
import { planEntries } from '../src/backup/entries.js';

const present = new Set([
  'user-data', 'config', 'secrets', '.env', '.claude/settings.local.json',
  'data.sqlite-wal', 'node_modules', '.git',
]);
const ex = {
  exists: (p: string) => present.has(p),
  list: (d: string) => (d === 'config' ? ['portals.json', 'portals.json.bak', 'notes.txt', 'target-regions.json'] : []),
};

describe('planEntries', () => {
  it('excludes secrets and .env by default with the opt-in reason', () => {
    const { entries, excluded } = planEntries('/p', ex, { includeSecrets: false }, '/snap/data.sqlite');
    const paths = entries.map((e) => e.archivePath);
    expect(paths).not.toContain('secrets');
    expect(paths).not.toContain('.env');
    const s = excluded.find((e) => e.path === 'secrets');
    expect(s?.why).toContain('BACKUP_INCLUDE_SECRETS=true');
    expect(excluded.some((e) => e.path === '.env')).toBe(true);
  });
  it('includes secrets as dir and .env as file when opted in', () => {
    const { entries } = planEntries('/p', ex, { includeSecrets: true }, '/snap/data.sqlite');
    expect(entries.find((e) => e.archivePath === 'secrets')?.kind).toBe('dir');
    expect(entries.find((e) => e.archivePath === '.env')?.kind).toBe('file');
  });
  it('db entry comes from the snapshot', () => {
    const { entries } = planEntries('/p', ex, { includeSecrets: false }, '/snap/data.sqlite');
    const db = entries.find((e) => e.kind === 'db');
    expect(db).toMatchObject({ archivePath: 'data.sqlite', source: '/snap/data.sqlite' });
  });
  it('config contributes only top-level json, no .bak', () => {
    const { entries, excluded } = planEntries('/p', ex, { includeSecrets: false }, '/s');
    const cfg = entries.filter((e) => e.archivePath.startsWith('config/')).map((e) => e.archivePath);
    expect(cfg.sort()).toEqual(['config/portals.json', 'config/target-regions.json']);
    expect(excluded.some((e) => e.path === 'config/portals.json.bak')).toBe(true);
  });
  it('includes user-data dir and claude local settings; never WAL, node_modules, .git', () => {
    const { entries, excluded } = planEntries('/p', ex, { includeSecrets: true }, '/s');
    const paths = entries.map((e) => e.archivePath);
    expect(entries.find((e) => e.archivePath === 'user-data')?.kind).toBe('dir');
    expect(paths).toContain('.claude/settings.local.json');
    expect(paths.some((p) => p.includes('-wal') || p.startsWith('node_modules') || p.startsWith('.git'))).toBe(false);
    expect(excluded.map((e) => e.path)).toEqual(expect.arrayContaining(['data.sqlite-wal', 'node_modules', '.git']));
  });
  it('no entry has an absolute, dotdot or backslash archive path', () => {
    const evil = {
      exists: (p: string) => p === 'config',
      list: () => ['../x.json', 'a\\b.json', '/abs.json', 'ok.json', 'bad\u0001.json'],
    };
    const { entries } = planEntries('/p', evil, { includeSecrets: false }, '/s');
    expect(entries.map((e) => e.archivePath).sort()).toEqual(['config/ok.json', 'data.sqlite']);
  });
});
