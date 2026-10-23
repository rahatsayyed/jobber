// tests/platform-permissions.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  applySet,
  applySetToFile,
  manifestPath,
  detectSet,
  resolveSet,
  validateSets,
  type RawSets,
} from '../src/platform/permissions.js';

const real: RawSets = JSON.parse(readFileSync('config/permission-sets.json', 'utf8'));

const SEND_TOOLS = [
  'mcp__linkedin__linkedin_arm_send',
  'mcp__linkedin__linkedin_click',
  'mcp__linkedin__linkedin_type',
  'mcp__gmail__send_email',
  'mcp__naukri__naukri_click',
  'mcp__naukri__naukri_type',
  'mcp__wellfound__wellfound_arm_send',
  'mcp__wellfound__wellfound_arm_apply',
  'mcp__wellfound__wellfound_click',
  'mcp__wellfound__wellfound_type',
  'mcp__wellfound__wellfound_discover',
];

const base = join('.superpowers', 'tmp-perm-tests');
mkdirSync(base, { recursive: true });
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('shipped permission sets', () => {
  it('are valid MCP-only entries', () => {
    expect(() => validateSets(real)).not.toThrow();
  });
  it('read_only contains no send, apply or write tool', () => {
    const ro = resolveSet(real, 'read_only');
    for (const t of SEND_TOOLS) expect(ro).not.toContain(t);
    expect(ro.some((e) => /__(save|record|enqueue|mark|set|update|resolve|claim|unexclude|sweep)_/.test(e))).toBe(false);
  });
  it('outreach_send includes read_only and every send tool', () => {
    const os = resolveSet(real, 'outreach_send');
    for (const t of resolveSet(real, 'read_only')) expect(os).toContain(t);
    for (const t of SEND_TOOLS) expect(os).toContain(t);
  });
  it('full adds whole-server entries and never an unscoped shell or file tool', () => {
    const full = resolveSet(real, 'full');
    for (const s of ['mcp__gmail', 'mcp__applier', 'mcp__scout', 'mcp__naukri', 'mcp__wellfound', 'mcp__db']) expect(full).toContain(s);
    expect(full.filter((e) => !e.startsWith('mcp__')).sort()).toEqual([
      'Bash(npx tsx scripts/status.ts health)',
      'Bash(npx tsx scripts/status.ts limits)',
      'Bash(npx tsx scripts/status.ts working)',
    ]);
  });
});

describe('validateSets', () => {
  it('rejects non-MCP entries', () => {
    for (const bad of ['Bash', 'Bash(*)', 'Read', 'Write(*)', 'mcp__x__y --dangerously-skip-permissions']) {
      expect(() => validateSets({ s: { allow: [bad] } })).toThrow();
    }
  });
  it('accepts exactly the three status script entries and rejects variants', () => {
    for (const ok of ['limits', 'working', 'health']) {
      expect(() => validateSets({ s: { allow: [`Bash(npx tsx scripts/status.ts ${ok})`] } })).not.toThrow();
    }
    for (const bad of [
      'Bash(npx tsx scripts/status.ts limits:*)',
      'Bash(npx tsx scripts/status.ts limits *)',
      'Bash(npx tsx scripts/status.ts other)',
      'Bash(rm -rf)',
    ]) {
      expect(() => validateSets({ s: { allow: [bad] } })).toThrow();
    }
  });
  it('rejects unknown parents and cycles', () => {
    expect(() => resolveSet({ a: { extends: 'zzz', allow: [] } }, 'a')).toThrow();
    expect(() => resolveSet({ a: { extends: 'b', allow: [] }, b: { extends: 'a', allow: [] } }, 'a')).toThrow();
  });
});

describe('applySet', () => {
  it('keeps user entries, deny and ask, and replaces managed entries', () => {
    const before = {
      model: 'sonnet',
      permissions: {
        allow: ['Bash(npx vitest run *)', 'mcp__gmail__send_email', 'mcp__linkedin__linkedin_connect_send'],
        deny: ['Read(./.env)'],
        ask: ['Bash(git push *)'],
      },
    };
    const after = applySet(before, real, 'read_only');
    expect(after.model).toBe('sonnet');
    expect(after.permissions?.deny).toEqual(['Read(./.env)']);
    expect(after.permissions?.ask).toEqual(['Bash(git push *)']);
    expect(after.permissions?.allow).toContain('Bash(npx vitest run *)');
    expect(after.permissions?.allow).not.toContain('mcp__gmail__send_email');
    expect(after.permissions?.allow).toContain('mcp__db__get_funnel');
  });

  it('is idempotent', () => {
    const once = applySet({}, real, 'outreach_send');
    expect(applySet(once, real, 'outreach_send')).toEqual(once);
  });

  it('detects which set is active, or custom', () => {
    expect(detectSet(applySet({}, real, 'full'), real)).toBe('full');
    expect(detectSet(applySet({}, real, 'read_only'), real)).toBe('read_only');
    expect(detectSet({ permissions: { allow: ['mcp__gmail__send_email'] } }, real)).toBe('custom');
  });

  it('switching full back to read_only keeps user entries and deny', () => {
    const full = applySet({ permissions: { allow: ['Bash(ls)'], deny: ['Bash(rm *)'] } }, real, 'full');
    const ro = applySet(full, real, 'read_only');
    expect(ro.permissions?.allow).toContain('Bash(ls)');
    expect(ro.permissions?.allow).not.toContain('mcp__gmail');
    expect(ro.permissions?.deny).toEqual(['Bash(rm *)']);
  });
});

describe('applySetToFile', () => {
  it('creates the file, backs up an existing one, and refuses to overwrite invalid JSON', () => {
    const dir = mkdtempSync(join(base, 'perm-'));
    const path = join(dir, 'settings.local.json');
    applySetToFile(path, real, 'read_only');
    expect(JSON.parse(readFileSync(path, 'utf8')).permissions.allow).toContain('mcp__db__get_funnel');

    applySetToFile(path, real, 'outreach_send');
    expect(existsSync(`${path}.bak`)).toBe(true);

    writeFileSync(path, '{ not json');
    expect(() => applySetToFile(path, real, 'read_only')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
    expect(readFileSync(`${path}.invalid.bak`, 'utf8')).toBe('{ not json');
  });
});

describe('manifest-based ownership, mode and shape validation', () => {
  const mk = () => join(mkdtempSync(join(base, 'perm-')), 'settings.local.json');
  const allowOf = (p: string): string[] => JSON.parse(readFileSync(p, 'utf8')).permissions.allow;

  it('removes a stale entry dropped from a set definition', () => {
    const p = mk();
    applySetToFile(p, { read_only: { allow: ['mcp__a__x', 'mcp__a__send'] } }, 'read_only');
    applySetToFile(p, { read_only: { allow: ['mcp__a__x'] } }, 'read_only');
    expect(allowOf(p)).toEqual(['mcp__a__x']);
  });

  it('keeps a user-owned entry equal to a managed name across a switch', () => {
    const p = mk();
    writeFileSync(p, JSON.stringify({ permissions: { allow: ['mcp__gmail__send_email'] } }));
    applySetToFile(p, real, 'outreach_send');
    applySetToFile(p, real, 'read_only');
    expect(allowOf(p)).toContain('mcp__gmail__send_email');
    expect(JSON.parse(readFileSync(manifestPath(p), 'utf8')).entries).not.toContain('mcp__gmail__send_email');
  });

  it('full back to read_only removes only ours; deny and ask untouched', () => {
    const p = mk();
    writeFileSync(
      p,
      JSON.stringify({ permissions: { allow: ['Bash(ls)'], deny: ['Read(./.env)'], ask: ['Bash(git push *)'] } }),
    );
    applySetToFile(p, real, 'full');
    applySetToFile(p, real, 'read_only');
    const out = JSON.parse(readFileSync(p, 'utf8'));
    expect(out.permissions.allow).toContain('Bash(ls)');
    expect(out.permissions.allow).not.toContain('mcp__gmail');
    expect(out.permissions.allow).not.toContain('mcp__gmail__send_email');
    expect(out.permissions.deny).toEqual(['Read(./.env)']);
    expect(out.permissions.ask).toEqual(['Bash(git push *)']);
  });

  it('writes settings and manifest with mode 0600', () => {
    const p = mk();
    applySetToFile(p, real, 'read_only');
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(manifestPath(p)).mode & 0o777).toBe(0o600);
  });

  it('keeps the first .bak on a later apply', () => {
    const p = mk();
    writeFileSync(p, JSON.stringify({ model: 'orig' }));
    applySetToFile(p, real, 'read_only');
    applySetToFile(p, real, 'outreach_send');
    expect(JSON.parse(readFileSync(`${p}.bak`, 'utf8'))).toEqual({ model: 'orig' });
  });

  it('refuses wrong shapes without overwriting', () => {
    const bad = [
      '{"permissions":[]}', '{"permissions":"x"}', '{"permissions":null}',
      '{"permissions":{"allow":"x"}}', '{"permissions":{"allow":{}}}',
      '{"permissions":{"deny":[1]}}', '[]', '"x"', 'null',
    ];
    for (const text of bad) {
      const p = mk();
      writeFileSync(p, text);
      expect(() => applySetToFile(p, real, 'read_only')).toThrow();
      expect(readFileSync(p, 'utf8')).toBe(text);
      expect(readFileSync(`${p}.invalid.bak`, 'utf8')).toBe(text);
    }
  });

  // Deliberate change: a present-but-invalid manifest used to fail open (treated as absent).
  it('refuses an unparseable manifest and leaves settings and manifest untouched', () => {
    const p = mk();
    applySetToFile(p, real, 'full');
    writeFileSync(manifestPath(p), '{ nope');
    const before = readFileSync(p, 'utf8');
    expect(() => applySetToFile(p, real, 'read_only')).toThrow(/manifest|managed|not valid JSON/);
    expect(readFileSync(p, 'utf8')).toBe(before);
    expect(readFileSync(manifestPath(p), 'utf8')).toBe('{ nope');
  });

  it('refuses a wrong-shaped manifest', () => {
    const p = mk();
    applySetToFile(p, real, 'full');
    writeFileSync(manifestPath(p), JSON.stringify({ entries: 'nope' }));
    const before = readFileSync(p, 'utf8');
    expect(() => applySetToFile(p, real, 'read_only')).toThrow(/invalid shape/);
    expect(readFileSync(p, 'utf8')).toBe(before);
  });

  it('a missing manifest is fine, and manifest entries absent from settings are ignored', () => {
    const p = mk();
    writeFileSync(p, JSON.stringify({ permissions: { allow: ['Bash(ls)'] } }));
    writeFileSync(manifestPath(p), JSON.stringify({ set: 'full', entries: ['mcp__ghost__tool'] }));
    applySetToFile(p, real, 'read_only');
    expect(allowOf(p)).toContain('Bash(ls)');
    expect(allowOf(p)).not.toContain('mcp__ghost__tool');
    const q = mk();
    expect(() => applySetToFile(q, real, 'read_only')).not.toThrow();
  });

  it('validateSets rejects a non-array allow', () => {
    expect(() => validateSets({ s: { allow: 'x' as unknown as string[] } })).toThrow(/array/);
  });
});
