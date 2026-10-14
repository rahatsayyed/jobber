import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPermissionsCli, settingsPathFor } from '../src/platform/permissionsCli.js';
import type { RawSets } from '../src/platform/permissions.js';

const sets: RawSets = {
  read_only: { allow: ['mcp__db__get_funnel'] },
  outreach_send: { extends: 'read_only', allow: ['mcp__gmail__send_email'] },
  full: { extends: 'outreach_send', allow: ['mcp__apply__auto'] },
};

const base = resolve(import.meta.dirname, '..', '.superpowers');
let root: string;

beforeEach(() => {
  mkdirSync(base, { recursive: true });
  root = mkdtempSync(join(base, 'permcli-'));
  mkdirSync(join(root, '.claude'), { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const allow = (): string[] => JSON.parse(readFileSync(settingsPathFor(root), 'utf8')).permissions.allow;

describe('permissions CLI handler', () => {
  it('applies full then read_only, keeping user entries', () => {
    writeFileSync(settingsPathFor(root), JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    const full = runPermissionsCli(['full'], root, sets);
    expect(full.code).toBe(0);
    expect(full.lines.some((l) => l.startsWith('WARN'))).toBe(true);
    expect(allow()).toEqual(['Bash(ls)', 'mcp__db__get_funnel', 'mcp__gmail__send_email', 'mcp__apply__auto']);
    const ro = runPermissionsCli(['read_only'], root, sets);
    expect(ro.code).toBe(0);
    expect(ro.lines.some((l) => l.startsWith('WARN'))).toBe(false);
    expect(allow()).toEqual(['Bash(ls)', 'mcp__db__get_funnel']);
  });

  it('rejects unknown names with exit 1 and usage', () => {
    const r = runPermissionsCli(['root'], root, sets);
    expect(r.code).toBe(1);
    expect(r.lines[0]).toContain('usage');
    expect(existsSync(settingsPathFor(root))).toBe(false);
  });

  it('status prints set name and count, never entry values', () => {
    writeFileSync(settingsPathFor(root), JSON.stringify({ permissions: { allow: ['Bash(secret-user-entry)'] } }));
    runPermissionsCli(['outreach_send'], root, sets);
    for (const args of [[], ['--status']]) {
      const r = runPermissionsCli(args, root, sets);
      expect(r.code).toBe(0);
      const out = r.lines.join('\n');
      expect(out).toContain('outreach_send');
      expect(out).toContain('managed entries: 2');
      expect(out).not.toContain('mcp__');
      expect(out).not.toContain('secret-user-entry');
    }
  });

  it('returns the error message only on invalid JSON', () => {
    writeFileSync(settingsPathFor(root), '{not json');
    const r = runPermissionsCli(['read_only'], root, sets);
    expect(r.code).toBe(1);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toContain('not valid JSON');
  });
});
