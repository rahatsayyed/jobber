// tests/bootstrap-state.test.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildState, readState, statePath, writeState } from '../src/bootstrap/state.js';
import { main, type MainDeps } from '../scripts/bootstrap.js';

let dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'bs-state-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
  dirs = [];
});

describe('bootstrap state', () => {
  it('round trips with modes 600/700 and no secrets', () => {
    const root = tmp();
    const secret = 'sk-invented-secret-value-123';
    process.env.TEST_BOOTSTRAP_SECRET = secret;
    const st = buildState('darwin', [{ id: 'tmux', outcome: 'ok', version: '3.4' }, { id: 'age', outcome: 'skipped' }], new Date(0));
    writeState(root, st);
    delete process.env.TEST_BOOTSTRAP_SECRET;
    expect(readState(root)).toEqual(st);
    expect(st.declined).toEqual(['age']);
    expect(statSync(statePath(root)).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, '.jobber')).mode & 0o777).toBe(0o700);
    expect(readFileSync(statePath(root), 'utf8')).not.toContain(secret);
  });
  it('rejects unknown version and corrupt JSON without throwing', () => {
    const root = tmp();
    expect(readState(root)).toBeNull();
    mkdirSync(join(root, '.jobber'));
    writeFileSync(statePath(root), '{"version":2,"items":{},"declined":[]}');
    expect(readState(root)).toBeNull();
    writeFileSync(statePath(root), '{not json');
    expect(readState(root)).toBeNull();
  });
});

function deps(over: Partial<MainDeps>): MainDeps {
  return {
    platform: 'darwin',
    root: '/fake',
    env: {},
    run: async () => ({ code: 0, stdout: 'tool 99.0.0' }),
    fs: {
      exists: () => true,
      read: (p) => (p.endsWith('ccgram.pin.json') ? '{"version":"4.16.0"}' : p.endsWith('classifier-models.json') ? '{"default_profile":"x"}' : '{"engines":{"node":">=20"}}'),
      list: () => [],
    },
    now: () => new Date(0),
    ask: async () => false,
    say: () => {},
    download: async () => ({ path: '', bytes: 0, sha256: '' }),
    mkTempDir: () => '/fake/tmp',
    interactive: false,
    ...over,
  };
}

describe('bootstrap main state writing', () => {
  it('writes after a normal run, not for --check or --plan, and survives failure', async () => {
    const saved: unknown[] = [];
    const saveState = (_r: string, s: unknown): void => void saved.push(s);
    await main(['--only', 'git'], deps({ saveState }));
    expect(saved).toHaveLength(1);
    await main(['--check'], deps({ saveState }));
    await main(['--plan'], deps({ saveState }));
    expect(saved).toHaveLength(1);
    const code = await main(['--only', 'git'], deps({ saveState: () => { throw new Error('disk full'); } }));
    expect(code).toBe(0);
  });
});
