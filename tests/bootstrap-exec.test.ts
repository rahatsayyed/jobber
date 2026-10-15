// tests/bootstrap-exec.test.ts
import { describe, expect, it } from 'vitest';
import { exitCodeFor, renderTable, runBootstrap, type ExecDeps, type ExecOptions } from '../src/bootstrap/exec.js';
import type { Action, Detection, Item, ItemId, Plan } from '../src/bootstrap/types.js';

interface Env {
  present: Set<string>;
  calls: string[][];
  asks: string[];
  said: string[];
  downloads: number;
  failCmd?: string;
}
// Fake Run: rejects a single-string command (shell use); a successful call marks its last arg "present".
function mk(env: Env, platform: 'darwin' | 'linux' = 'darwin'): ExecDeps {
  return {
    platform,
    root: '/proj',
    env: {},
    now: () => new Date(0),
    fs: { exists: () => false, read: () => Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n'), list: () => [] },
    run: (async () => ({ code: 0, stdout: '' })) as ExecDeps['run'],
    exec: async (cmd: string, args: string[]) => {
      if (/\s/.test(cmd)) throw new Error('shell string');
      env.calls.push([cmd, ...args]);
      if (env.failCmd && cmd === env.failCmd) return { code: 1 };
      const t = args[args.length - 1];
      if (t) env.present.add(t);
      return { code: 0 };
    },
    ask: async (p) => {
      env.asks.push(p);
      return true;
    },
    say: (l) => {
      env.said.push(l);
    },
    download: async () => {
      env.downloads++;
      return { path: '/tmp/x/uv.sh', bytes: 10, sha256: 'ab'.repeat(32) };
    },
    mkTempDir: () => '/tmp/x',
  };
}
const newEnv = (present: string[] = []): Env => ({ present: new Set(present), calls: [], asks: [], said: [], downloads: 0 });
const O = (o: Partial<ExecOptions> = {}): ExecOptions => ({
  yes: false,
  allowSudo: false,
  checkOnly: false,
  planOnly: false,
  withOptional: false,
  skipModel: false,
  interactive: true,
  ...o,
});
function item(id: ItemId, env: Env, plan: Plan, extra: Partial<Item> = {}): Item {
  return {
    id,
    title: id,
    required: true,
    detect: async (): Promise<Detection> => (env.present.has(id) ? { present: true, version: '1', detail: 'there' } : { present: false, detail: 'gone' }),
    plan: () => plan,
    ...extra,
  };
}
const act = (id: string, over: Partial<Action> = {}): Action => ({ id: `${id}:a`, summary: `get ${id}`, argv: ['inst', id], needsSudo: false, network: false, ...over });
const acts = (id: string, over: Partial<Action> = {}): Plan => ({ kind: 'actions', actions: [act(id, over)] });

describe('executor consent table', () => {
  it('non-sudo, no --yes, TTY: asks once and runs on yes', async () => {
    const e = newEnv();
    const r = await runBootstrap([item('tmux', e, acts('tmux'))], mk(e), O());
    expect(e.asks).toHaveLength(1);
    expect(r[0]!.outcome).toBe('installed');
  });
  it('non-sudo, --yes: runs without asking', async () => {
    const e = newEnv();
    const r = await runBootstrap([item('tmux', e, acts('tmux'))], mk(e), O({ yes: true, interactive: false }));
    expect(e.asks).toHaveLength(0);
    expect(r[0]!.outcome).toBe('installed');
  });
  it('non-sudo, no --yes, no TTY: skipped needs --yes', async () => {
    const e = newEnv();
    const r = await runBootstrap([item('tmux', e, acts('tmux'))], mk(e), O({ interactive: false }));
    expect(e.calls).toHaveLength(0);
    expect(r[0]).toMatchObject({ outcome: 'skipped', note: 'needs --yes' });
  });
  it('sudo without --allow-sudo: asks on TTY, refuses without', async () => {
    const e = newEnv();
    const p = acts('git', { needsSudo: true });
    await runBootstrap([item('git', e, p)], mk(e), O({ yes: true }));
    expect(e.asks).toHaveLength(1);
    expect(e.calls[0]![0]).toBe('sudo');
    const e2 = newEnv();
    const r = await runBootstrap([item('git', e2, p)], mk(e2), O({ yes: true, interactive: false }));
    expect(r[0]!.outcome).toBe('needs_owner');
    expect(e2.calls).toHaveLength(0);
  });
  it('--allow-sudo without --yes still asks on TTY; needs_owner without', async () => {
    const e = newEnv();
    await runBootstrap([item('git', e, acts('git', { needsSudo: true }))], mk(e), O({ allowSudo: true }));
    expect(e.asks).toHaveLength(1);
    const e2 = newEnv();
    const r = await runBootstrap([item('git', e2, acts('git', { needsSudo: true }))], mk(e2), O({ allowSudo: true, interactive: false }));
    expect(r[0]!.outcome).toBe('needs_owner');
    expect(e2.calls).toHaveLength(0);
  });
  it('prints argv, sudo and network before running on the --yes path', async () => {
    const e = newEnv();
    await runBootstrap([item('tmux', e, acts('tmux', { network: true, url: 'https://example.invalid/t' }))], mk(e), O({ yes: true }));
    const said = e.said.join('\n');
    expect(said).toContain('inst tmux');
    expect(said).toContain('network: yes');
    expect(said).toContain('https://example.invalid/t');
  });
  it('declined ask: nothing is run', async () => {
    const e = newEnv();
    const d = mk(e);
    d.ask = async () => false;
    const r = await runBootstrap([item('tmux', e, acts('tmux')), item('git', e, acts('git', { needsSudo: true }))], d, O());
    expect(r.map((x) => x.outcome)).toEqual(['skipped', 'skipped']);
    expect(e.calls).toHaveLength(0);
  });
  it('--yes on non-TTY with a downloadsScript: no download', async () => {
    const e = newEnv();
    const p = acts('uv', { downloadsScript: true, url: 'https://example.invalid/uv.sh', argv: ['sh', '{script}'] });
    const r = await runBootstrap([item('uv', e, p)], mk(e), O({ yes: true, interactive: false }));
    expect(e.downloads).toBe(0);
    expect(r[0]!.outcome).toBe('needs_owner');
  });
  it('sudo plus downloadsScript is refused', async () => {
    const e = newEnv();
    const p = acts('uv', { downloadsScript: true, needsSudo: true, url: 'https://example.invalid/uv.sh', argv: ['sh', '{script}'] });
    const r = await runBootstrap([item('uv', e, p)], mk(e), O({ yes: true, allowSudo: true }));
    expect(r[0]!.outcome).toBe('failed');
    expect(e.calls).toHaveLength(0);
    expect(e.downloads).toBe(0);
  });
  it('a throwing run or download fails the item, not the run', async () => {
    const e = newEnv();
    const d = mk(e);
    d.exec = async () => {
      throw new Error('spawn exploded');
    };
    d.download = async () => {
      throw new Error('net down');
    };
    const p = acts('uv', { downloadsScript: true, url: 'https://example.invalid/uv.sh', argv: ['sh', '{script}'] });
    const r = await runBootstrap([item('tmux', e, acts('tmux')), item('uv', e, p), item('git', e, acts('git'))], d, O({ yes: true }));
    expect(r.map((x) => x.outcome)).toEqual(['failed', 'failed', 'failed']);
  });
  it('--only, --skip-model, --with-optional without an install action', async () => {
    const e = newEnv();
    const r = await runBootstrap([item('git', e, acts('git')), item('tmux', e, acts('tmux'))], mk(e), O({ yes: true, only: ['tmux'] }));
    expect(r.map((x) => x.id)).toEqual(['tmux']);
    const m = await runBootstrap([item('classifier-model', e, acts('classifier-model'))], mk(e), O({ yes: true, skipModel: true }));
    expect(m[0]!.outcome).toBe('skipped');
    const a = item('age', e, { kind: 'owner', message: 'brew install age' }, { required: false, optionalKind: 'report_only' });
    const w = await runBootstrap([a], mk(e), O({ yes: true, withOptional: true }));
    expect(w[0]!.outcome).toBe('skipped');
  });
  it('dependency chains and unselected dependency re-detection', async () => {
    const e = newEnv();
    e.failCmd = 'inst';
    const items = [item('node', e, acts('node')), item('npm-deps', e, acts('npm-deps')), item('renderer-deps', e, acts('renderer-deps'))];
    const r = await runBootstrap(items, mk(e), O({ yes: true }));
    expect(r.map((x) => x.outcome)).toEqual(['failed', 'skipped', 'skipped']);
    expect(r[2]!.note).toBe('waiting for npm-deps');
    const e2 = newEnv();
    const r2 = await runBootstrap([item('node', e2, acts('node')), item('npm-deps', e2, acts('npm-deps'))], mk(e2), O({ yes: true, only: ['npm-deps'] }));
    expect(r2[0]).toMatchObject({ outcome: 'skipped', note: 'waiting for node' });
    expect(e2.calls).toHaveLength(0);
  });
  it('sudo with --yes --allow-sudo: runs with sudo argv[0], no prompt', async () => {
    const e = newEnv();
    await runBootstrap([item('git', e, acts('git', { needsSudo: true }))], mk(e), O({ yes: true, allowSudo: true, interactive: false }));
    expect(e.asks).toHaveLength(0);
    expect(e.calls[0]!.slice(0, 2)).toEqual(['sudo', 'inst']);
  });
  it('downloadsScript: asks again even with --yes, shows details, replaces placeholder', async () => {
    const e = newEnv();
    const p = acts('uv', { downloadsScript: true, url: 'https://example.invalid/uv.sh', argv: ['sh', '{script}'] });
    await runBootstrap([item('uv', e, p)], mk(e), O({ yes: true }));
    expect(e.downloads).toBe(1);
    expect(e.asks).toHaveLength(1);
    expect(e.calls[0]).toEqual(['sh', '/tmp/x/uv.sh']);
    const said = e.said.join('\n');
    expect(said).toContain('line39');
    expect(said).not.toContain('line40');
    expect(said).toContain('abab');
    const e2 = newEnv();
    const r2 = await runBootstrap([item('uv', e2, p)], mk(e2), O({ yes: true, interactive: false }));
    expect(r2[0]!.outcome).toBe('needs_owner');
    expect(e2.calls).toHaveLength(0);
  });
  it('uv owner plan on linux reaches UV_INSTALLER_ACTION', async () => {
    const e = newEnv();
    const it = item('uv', e, { kind: 'owner', message: 'install uv', url: 'https://example.invalid/uv' });
    await runBootstrap([it], mk(e, 'linux'), O({ yes: true }));
    expect(e.downloads).toBe(1);
    expect(e.calls[0]).toEqual(['sh', '/tmp/x/uv.sh']);
  });
  it('owner plan: printed, needs_owner, never run', async () => {
    const e = newEnv();
    const r = await runBootstrap([item('claude-cli', e, { kind: 'owner', message: 'do it', url: 'https://example.invalid/c' })], mk(e), O({ yes: true }));
    expect(r[0]!.outcome).toBe('needs_owner');
    expect(e.calls).toHaveLength(0);
    expect(e.said.join('\n')).toContain('https://example.invalid/c');
  });
  it('offer() actions are optional installs under consent rules', async () => {
    const e = newEnv();
    const it = item('claude-cli', e, { kind: 'owner', message: 'm' }, { offer: async () => [act('claude-cli')] });
    const r = await runBootstrap([it], mk(e), O({ yes: true }));
    expect(r[0]!.outcome).toBe('installed');
    const e2 = newEnv();
    const r2 = await runBootstrap([item('claude-cli', e2, { kind: 'owner', message: 'm' }, { offer: async () => [act('claude-cli')] })], mk(e2), O({ interactive: false }));
    expect(r2[0]!.outcome).toBe('needs_owner');
    expect(e2.calls).toHaveLength(0);
  });
  it('report_only: reported unless --with-optional and an install action exists', async () => {
    const e = newEnv();
    const mkI = () => item('age', e, { kind: 'owner', message: 'brew install age' }, { required: false, optionalKind: 'report_only', offer: async () => [act('age')] });
    const r = await runBootstrap([mkI()], mk(e), O({ yes: true }));
    expect(r[0]!.outcome).toBe('skipped');
    expect(e.calls).toHaveLength(0);
    const r2 = await runBootstrap([mkI()], mk(e), O({ yes: true, withOptional: true }));
    expect(r2[0]!.outcome).toBe('installed');
  });
});

describe('executor other rules', () => {
  it('checkOnly never asks, downloads or acts', async () => {
    const e = newEnv(['git']);
    const items = [item('git', e, acts('git')), item('tmux', e, acts('tmux'))];
    const r = await runBootstrap(items, mk(e), O({ checkOnly: true }));
    expect(e.calls).toHaveLength(0);
    expect(e.asks).toHaveLength(0);
    expect(e.downloads).toBe(0);
    expect(r.map((x) => x.outcome)).toEqual(['ok', 'needs_owner']);
    expect(exitCodeFor(r)).toBe(1);
  });
  it('failed action: redacted last line; dependents skipped; others still run', async () => {
    const e = newEnv();
    e.failCmd = 'inst';
    const items = [
      item('uv', e, acts('uv')),
      item('ccgram', e, acts('ccgram')),
      item('git', e, { kind: 'actions', actions: [{ ...act('git'), argv: ['other', 'git'] }] }),
    ];
    const r = await runBootstrap(items, mk(e), O({ yes: true }));
    expect(r[0]!.outcome).toBe('failed');
    expect(r[0]!.note).toContain('exit 1');
    expect(r[0]!.note).toContain('see output above');
    expect(r[1]).toMatchObject({ outcome: 'skipped', note: 'waiting for uv' });
    expect(r[2]!.outcome).toBe('installed');
  });
  it('a thrown exec error carrying a credential marker is redacted', async () => {
    const e = newEnv();
    const fake = mk(e);
    fake.exec = async () => {
      throw new Error('TOKEN=abc123');
    };
    const r = await runBootstrap([item('tmux', e, acts('tmux'))], fake, O({ yes: true }));
    expect(r[0]!.outcome).toBe('failed');
    expect(r[0]!.note).not.toContain('abc123');
  });
  it('real actions go through exec, never run; a slow exec is not subject to the detection timeout', async () => {
    const e = newEnv();
    const fake = mk(e);
    let runCalls = 0;
    fake.run = (async () => {
      runCalls++;
      return { code: 0, stdout: '' };
    }) as ExecDeps['run'];
    fake.exec = async (cmd, args) => {
      await new Promise((r) => setTimeout(r, 60));
      e.present.add(args[args.length - 1]!);
      e.calls.push([cmd, ...args]);
      return { code: 0 };
    };
    const r = await runBootstrap([item('tmux', e, acts('tmux'))], fake, O({ yes: true }));
    expect(r[0]!.outcome).toBe('installed');
    expect(runCalls).toBe(0);
    expect(e.calls).toEqual([['inst', 'tmux']]);
  });
  it('required skipped items fail the exit code except in plan mode; reasons are structured', async () => {
    const e = newEnv();
    const r = await runBootstrap([item('tmux', e, acts('tmux'))], mk(e), O({ interactive: false }));
    expect(r[0]).toMatchObject({ outcome: 'skipped', reason: 'needs_yes' });
    expect(exitCodeFor(r)).toBe(1);
    expect(exitCodeFor(r, { planOnly: true })).toBe(0);
    const e2 = newEnv();
    const w = await runBootstrap([item('uv', e2, acts('uv')), item('ccgram', e2, acts('ccgram'))], { ...mk(e2), exec: async () => ({ code: 1 }) }, O({ yes: true }));
    expect(w[1]).toMatchObject({ outcome: 'skipped', reason: 'waiting' });
    const e3 = newEnv();
    const d = await runBootstrap([item('tmux', e3, acts('tmux'))], { ...mk(e3), ask: async () => false }, O());
    expect(d[0]).toMatchObject({ outcome: 'skipped', reason: 'declined' });
    expect(exitCodeFor(d)).toBe(1);
  });
  it('only a present re-detection counts as installed', async () => {
    const e = newEnv();
    const it = item('tmux', e, { kind: 'actions', actions: [{ ...act('tmux'), argv: ['inst', 'nope'] }] });
    const r = await runBootstrap([it], mk(e), O({ yes: true }));
    expect(r[0]!.outcome).toBe('failed');
  });
  it('planOnly prints actions and runs nothing', async () => {
    const e = newEnv();
    const r = await runBootstrap([item('tmux', e, acts('tmux'))], mk(e), O({ planOnly: true }));
    expect(e.calls).toHaveLength(0);
    expect(e.said.join('\n')).toContain('would run: inst tmux');
    expect(exitCodeFor(r, { planOnly: true })).toBe(0);
  });
  it('all-present machine runs nothing; table has no env values', async () => {
    const e = newEnv(['git', 'tmux']);
    const d = mk(e);
    d.env = { SECRET_VALUE: 'hunter2zzz' };
    const r = await runBootstrap([item('git', e, acts('git')), item('tmux', e, acts('tmux'))], d, O({ yes: true }));
    expect(e.calls).toHaveLength(0);
    const t = renderTable(r);
    expect(t).not.toContain('hunter2zzz');
    expect(t.split('\n')[0]).toMatch(/^item\s+required\s+result\s+version\s+note/);
  });
});
