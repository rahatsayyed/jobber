// tests/bootstrap-cli.test.ts
import { describe, expect, it } from 'vitest';
import { main, parseArgs, type MainDeps } from '../scripts/bootstrap.js';

function mk(over: Partial<MainDeps> & { present?: boolean } = {}): { deps: MainDeps; out: string[]; asked: string[]; ran: string[] } {
  const out: string[] = [];
  const asked: string[] = [];
  const ran: string[] = [];
  const present = over.present ?? true;
  const deps: MainDeps = {
    platform: 'darwin',
    root: '/fake',
    env: {},
    run: async (cmd, args) => {
      ran.push([cmd, ...args].join(' '));
      return { code: present ? 0 : 1, stdout: present ? 'tool 99.0.0' : '' };
    },
    fs: {
      exists: () => present,
      read: (p) => (p.endsWith('ccgram.pin.json') ? '{"version":"4.16.0"}' : '{"engines":{"node":">=20"}}'),
      list: () => [],
    },
    now: () => new Date(0),
    ask: async (q) => {
      asked.push(q);
      return false;
    },
    say: (l) => out.push(l),
    download: async () => ({ path: '/fake/x', bytes: 0, sha256: '' }),
    mkTempDir: () => '/fake/tmp',
    interactive: false,
    ...over,
  };
  delete (deps as unknown as { present?: boolean }).present;
  return { deps, out, asked, ran };
}

describe('parseArgs', () => {
  it('parses every flag', () => {
    const r = parseArgs(['--yes', '--allow-sudo', '--check', '--with-optional', '--skip-model', '--json', '--only', 'git,tmux']);
    expect(r).toEqual({
      ok: true,
      args: { yes: true, allowSudo: true, check: true, plan: false, withOptional: true, skipModel: true, json: true, help: false, only: ['git', 'tmux'] },
    });
    const h = parseArgs(['--help', '--plan']);
    expect(h.ok && h.args.help && h.args.plan).toBe(true);
  });
  it('rejects bad arities and unknown flags', () => {
    expect(parseArgs(['--only']).ok).toBe(false);
    expect(parseArgs(['--only', '--yes']).ok).toBe(false);
    expect(parseArgs(['--only', 'nope']).ok).toBe(false);
    expect(parseArgs(['--bogus']).ok).toBe(false);
    expect(parseArgs(['--check', '--plan']).ok).toBe(false);
  });
});

describe('main', () => {
  it('unknown flag exits 2', async () => {
    const { deps } = mk();
    expect(await main(['--nope'], deps)).toBe(2);
  });
  it('--help exits 0', async () => {
    const { deps, out } = mk();
    expect(await main(['--help'], deps)).toBe(0);
    expect(out.join('\n')).toContain('usage');
  });
  it('--check never asks and --json prints ItemResult[] only', async () => {
    const { deps, out, asked } = mk({ present: false, interactive: true });
    const code = await main(['--check', '--json', '--only', 'git,tmux'], deps);
    expect(asked).toEqual([]);
    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    const parsed = JSON.parse(out[0]!) as Array<{ id: string; outcome: string }>;
    expect(parsed.map((r) => r.id)).toEqual(['git', 'tmux']);
    expect(parsed.every((r) => typeof r.outcome === 'string')).toBe(true);
  });
  it('everything present exits 0', async () => {
    const { deps } = mk({ present: true });
    expect(await main(['--check', '--only', 'git'], deps)).toBe(0);
  });
  it('non-interactive without --yes with an action needed exits 3', async () => {
    const { deps } = mk({ present: false });
    expect(await main(['--only', 'tmux'], deps)).toBe(3);
  });
  it('unsupported platform with nothing checkable exits 4', async () => {
    const { deps } = mk({ present: false, platform: 'unsupported' });
    expect(await main(['--check', '--only', 'git'], deps)).toBe(4);
  });
  it('does not print the environment', async () => {
    const { deps, out } = mk({ env: { SECRET_TOKEN: 'sekrit-value' } });
    await main(['--check'], deps);
    expect(out.join('\n')).not.toContain('sekrit-value');
  });
});
