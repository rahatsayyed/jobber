// tests/setup-final-notready.test.ts
// Plan 8F task 8 fix: which doctor results make `Not ready for live` list an item.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scriptedIO } from '../src/setup/io.js';
import type { SetupContext } from '../src/setup/runner.js';
import { emptyState } from '../src/setup/state.js';

type St = 'pass' | 'warn' | 'fail' | 'skip';
let fake: Record<string, { status: St; detail: string }> = {};

vi.mock('../src/platform/doctor.js', async (orig) => {
  const real = await orig<typeof import('../src/platform/doctor.js')>();
  return {
    ...real,
    runChecks: async () =>
      Object.entries(fake).map(([id, result]) => ({ id, title: id, result })),
  };
});

const { finalStep } = await import('../src/setup/steps/final.js');

const ALL_PASS: typeof fake = {
  classifier_model: { status: 'pass', detail: 'ok' },
  'permission-set': { status: 'pass', detail: 'read_only' },
  'resume-valid': { status: 'pass', detail: 'ok' },
  'profile-valid': { status: 'pass', detail: 'ok' },
};

async function out(over: typeof fake): Promise<string> {
  fake = { ...ALL_PASS, ...over };
  const sio = scriptedIO([]);
  const ctx = {
    io: sio,
    root: 'proj',
    env: {},
    fs: { exists: () => false, read: () => '', chmod: () => undefined },
    doctor: { root: 'proj', env: {}, fs: { exists: () => false, read: () => '', mode: () => null, list: () => [] } },
    run: async () => ({ stdout: '', stderr: '', code: 0 }),
    state: emptyState(),
    envPath: 'proj/.env',
  } as unknown as SetupContext;
  expect(await finalStep.run(ctx)).toBe('done');
  return sio.transcript.join('\n');
}

describe('Not ready for live', () => {
  beforeEach(() => {
    fake = {};
  });
  it('is absent when all four checks pass', async () => {
    expect(await out({})).not.toContain('Not ready for live');
  });
  it('does not list the deliberate full or custom permission set', async () => {
    const full = { status: 'warn' as const, detail: 'full: every tool, including Gmail and LinkedIn send, is allowed' };
    const custom = { status: 'warn' as const, detail: 'allow list matches no named set (custom)' };
    expect(await out({ 'permission-set': full })).not.toContain('Not ready for live');
    expect(await out({ 'permission-set': custom })).not.toContain('Not ready for live');
  });
  it('lists a missing settings file and a failing permission check', async () => {
    const missing = { status: 'warn' as const, detail: 'no .claude/settings.local.json yet' };
    const text = await out({ 'permission-set': missing });
    expect(text).toContain('Not ready for live');
    expect(text).toContain('npm run setup -- --step access');
    expect(await out({ 'permission-set': { status: 'fail', detail: 'settings.local.json is invalid JSON' } })).toContain(
      'Not ready for live',
    );
  });
  it('lists warn or fail for the other three, never skip', async () => {
    for (const id of ['classifier_model', 'resume-valid', 'profile-valid']) {
      expect(await out({ [id]: { status: 'warn', detail: 'x' } })).toContain('Not ready for live');
      expect(await out({ [id]: { status: 'fail', detail: 'x' } })).toContain('Not ready for live');
      expect(await out({ [id]: { status: 'skip', detail: 'x' } })).not.toContain('Not ready for live');
    }
  });
});
