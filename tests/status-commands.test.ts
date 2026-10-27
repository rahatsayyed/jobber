import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveSet, type RawSets } from '../src/platform/permissions.js';

const sets = JSON.parse(readFileSync('config/permission-sets.json', 'utf8')) as RawSets;

describe('escalations command', () => {
  it('/escalations command file names only its own script call, and the script accepts it', () => {
    const text = readFileSync('.claude/commands/escalations.md', 'utf8');
    expect(text.match(/^allowed-tools:\s*(.+)$/m)?.[1].trim()).toBe('Bash(npx tsx scripts/status.ts escalations:*)');
    expect(text).toMatch(/^description:/m);
    expect(readFileSync('scripts/status.ts', 'utf8')).toContain("'escalations'");
  });
});

describe('status commands', () => {
  for (const sub of ['limits', 'working', 'health']) {
    it(`/${sub} command file names only its own script call`, () => {
      const text = readFileSync(`.claude/commands/${sub}.md`, 'utf8');
      const m = text.match(/^allowed-tools:\s*(.+)$/m);
      expect(m?.[1].trim()).toBe(`Bash(npx tsx scripts/status.ts ${sub}:*)`);
      expect(text).toMatch(/^description:/m);
    });
  }
  it('read_only holds exactly the four status entries, no wildcard', () => {
    const bash = resolveSet(sets, 'read_only').filter((e) => e.startsWith('Bash('));
    expect(bash.sort()).toEqual([
      'Bash(npx tsx scripts/status.ts escalations)',
      'Bash(npx tsx scripts/status.ts health)',
      'Bash(npx tsx scripts/status.ts limits)',
      'Bash(npx tsx scripts/status.ts working)',
    ]);
    expect(JSON.stringify(sets)).not.toContain('status.ts:*');
    for (const n of ['outreach_send', 'full']) {
      expect(sets[n].allow.some((e) => e.startsWith('Bash('))).toBe(false);
    }
  });
});
