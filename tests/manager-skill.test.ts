// tests/manager-skill.test.ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SUBCOMMANDS } from '../src/platform/manager.js';

const raw = readFileSync('.claude/skills/manager/SKILL.md', 'utf8');
const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
const front = m?.[1] ?? '';
const body = m?.[2] ?? '';

function field(name: string): string {
  const line = front.split('\n').find((l) => l.startsWith(`${name}:`));
  return line ? line.slice(name.length + 1).trim() : '';
}

describe('manager skill', () => {
  it('has parseable front matter', () => {
    expect(m).not.toBeNull();
    expect(field('name')).toBe('manager');
    expect(field('description').length).toBeGreaterThan(20);
  });

  it('allowed-tools are exact patterns', () => {
    const tools = field('allowed-tools');
    expect(tools).not.toBe('');
    const items = tools.split(/,\s*(?=Bash\()/);
    for (const t of items) {
      expect(t).toMatch(/^Bash\(npx tsx scripts\/(manager|status)\.ts [a-z]+(:\*)?\)$/);
    }
    expect(tools).not.toMatch(/tmux/);
    expect(tools).not.toMatch(/scripts\/status\.ts[^)]*\*/);
    expect(items.some((t) => t === 'Bash')).toBe(false);
  });

  it('body has the required strings and none of the forbidden', () => {
    for (const s of ['telegram-format', 'untrusted', 'Never type', 'ccgram-daemon']) {
      expect(body).toContain(s);
    }
    expect(body).not.toContain('send-keys');
    for (const line of body.split('\n')) {
      if (line.includes('skip-permissions')) expect(line).toContain('Never');
    }
  });

  it('names only known manager subcommands', () => {
    const subs = [...body.matchAll(/scripts\/manager\.ts ([a-z]+)/g)].map((x) => x[1]);
    expect(subs.length).toBeGreaterThan(0);
    for (const s of subs) expect(SUBCOMMANDS as readonly string[]).toContain(s);
  });
});
