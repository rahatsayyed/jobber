// tests/setup-mode.test.ts
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/setup/cli.js';
import { GUIDE_CHECK_IDS, configuredSteps, formatStatus, guideReadiness, launchGuide } from '../src/setup/guide.js';
import { scriptedIO, type ScriptItem } from '../src/setup/io.js';
import { resolveMode, startGuideForMode, type ModeDeps } from '../src/setup/mode.js';
import { emptyState, type SetupMode } from '../src/setup/state.js';
import type { Run } from '../src/platform/tmux.js';

function make(
  script: ScriptItem[],
  o: { flag?: SetupMode; stored?: SetupMode; noGuide?: boolean; interactive?: boolean; ready?: boolean; why?: string; offered?: boolean } = {},
) {
  const io = scriptedIO(script);
  const state = emptyState();
  if (o.stored) state.mode = o.stored;
  if (o.offered) state.guide_offered = true;
  let saves = 0;
  const deps: ModeDeps = {
    io,
    state,
    now: () => new Date('2026-10-15T10:00:00.000Z'),
    save: () => void saves++,
    flagMode: o.flag,
    noGuide: o.noGuide ?? false,
    interactive: o.interactive ?? true,
    guideReady: async () => ({ ready: o.ready ?? true, why: o.why }),
  };
  return { deps, state, io, saves: () => saves };
}

describe('resolveMode', () => {
  it('flag wins, persists and prints one line', async () => {
    const m = make([], { flag: 'terminal', stored: 'agent' });
    expect(await resolveMode(m.deps)).toBe('terminal');
    expect(m.state.mode).toBe('terminal');
    expect(m.state.mode_at).toBe('2026-10-15T10:00:00.000Z');
    expect(m.saves()).toBe(1);
    expect(m.io.transcript.filter((l) => l.startsWith('say:') && l.includes('mode:'))).toHaveLength(1);
  });

  it('stored mode wins without asking or saving', async () => {
    const m = make([], { stored: 'agent' });
    expect(await resolveMode(m.deps)).toBe('agent');
    expect(m.saves()).toBe(0);
  });

  it('no TTY or --step gives terminal and stores nothing', async () => {
    const m = make([], { interactive: false });
    expect(await resolveMode(m.deps)).toBe('terminal');
    expect(m.state.mode).toBeUndefined();
    expect(m.saves()).toBe(0);
  });

  it('--no-guide gives terminal and stores nothing', async () => {
    const m = make([], { noGuide: true });
    expect(await resolveMode(m.deps)).toBe('terminal');
    expect(m.state.mode).toBeUndefined();
    expect(m.saves()).toBe(0);
  });

  it('chooser defaults to agent only when the guide is ready', async () => {
    const m = make([{ choose: '' }], { ready: true });
    expect(await resolveMode(m.deps)).toBe('agent');
    expect(m.state.mode).toBe('agent');
    expect(m.state.mode_at).toBe('2026-10-15T10:00:00.000Z');
  });

  it('defaults to terminal and prints the reason when not ready', async () => {
    const m = make([{ choose: '' }], { ready: false, why: 'tmux is not available' });
    expect(await resolveMode(m.deps)).toBe('terminal');
    expect(m.io.transcript.join('\n')).toContain('tmux is not available');
  });

  it('stores the typed answer', async () => {
    const m = make([{ choose: 'terminal' }], { ready: true });
    expect(await resolveMode(m.deps)).toBe('terminal');
    expect(m.state.mode).toBe('terminal');
    expect(m.saves()).toBe(1);
  });

  it('an 8E state with guide_offered and no mode asks once', async () => {
    const m = make([{ choose: '' }], { offered: true, ready: false });
    expect(await resolveMode(m.deps)).toBe('terminal');
    expect(m.state.mode).toBe('terminal');
    expect(m.io.transcript.some((l) => l.startsWith('choose:'))).toBe(true);
  });
});

describe('parseArgs --mode', () => {
  it('accepts valid values', () => {
    expect(parseArgs(['--mode', 'agent']).mode).toBe('agent');
    expect(parseArgs(['--mode', 'terminal', '--no-guide'])).toMatchObject({ mode: 'terminal', noGuide: true });
    expect(parseArgs(['--mode', 'agent', '--guide-only']).error).toBeUndefined();
  });
  it('rejects bad arity and values', () => {
    for (const a of [['--mode'], ['--mode', 'x'], ['--mode', '--redo']]) {
      expect(parseArgs(a).error).toBe('--mode needs agent or terminal');
    }
  });
  it('rejects combinations', () => {
    expect(parseArgs(['--mode', 'agent', '--no-guide']).error).toBeDefined();
    expect(parseArgs(['--mode', 'terminal', '--guide-only']).error).toBeDefined();
    expect(parseArgs(['--mode', 'agent', '--list']).error).toBe('--mode cannot be used with --list or --status');
    expect(parseArgs(['--mode', 'terminal', '--status']).error).toBe('--mode cannot be used with --list or --status');
  });
});

describe('launch split', () => {
  function runner(session = false) {
    const calls: string[][] = [];
    const run = (async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args[0] === 'has-session') return { stdout: '', code: session ? 0 : 1 };
      return { stdout: '', code: 0 };
    }) as unknown as Run;
    return { run, calls };
  }

  it('launchGuide starts one new-session and never send-keys', async () => {
    const r = runner();
    const said: string[] = [];
    expect(await launchGuide({ io: { say: (l) => void said.push(l) }, root: 'proj', run: r.run })).toBe('started-tmux');
    expect(r.calls.filter((c) => c[1] === 'new-session')).toHaveLength(1);
    expect(r.calls.some((c) => c[1] === 'send-keys')).toBe(false);
  });

  it('guideReadiness reports the first failing check and missing tmux', async () => {
    const pass = GUIDE_CHECK_IDS.map((id) => ({ id, title: id, result: { status: 'pass' as const, detail: '' } }));
    const r = runner();
    expect((await guideReadiness({ run: r.run, checks: async () => pass })).ready).toBe(true);
    const bad = pass.map((o, i) => (i === 1 ? { ...o, result: { status: 'fail' as const, detail: '' } } : o));
    const g = await guideReadiness({ run: r.run, checks: async () => bad });
    expect(g.ready).toBe(false);
    expect(g.why).toContain(GUIDE_CHECK_IDS[1]);
    const noTmux = (async () => ({ stdout: '', code: 1 })) as unknown as Run;
    expect((await guideReadiness({ run: noTmux, checks: async () => pass })).why).toContain('tmux');
  });
});

describe('startGuideForMode', () => {
  function go(o: { mode: SetupMode; noGuide?: boolean; interactive?: boolean; ready?: boolean; why?: string }) {
    const calls: string[][] = [];
    const said: string[] = [];
    const run = (async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return { stdout: '', code: args[0] === 'has-session' ? 1 : 0 };
    }) as unknown as Run;
    const state = emptyState();
    state.mode = o.mode;
    let saves = 0;
    const p = startGuideForMode({
      io: { say: (l) => void said.push(l) },
      root: 'proj',
      run,
      state,
      mode: o.mode,
      noGuide: o.noGuide ?? false,
      interactive: o.interactive ?? true,
      readiness: async () => ({ ready: o.ready ?? true, why: o.why }),
      save: () => void saves++,
    });
    return { p, calls, said, state, saves: () => saves };
  }

  it('agent and ready: one new-session, guide_offered set and saved', async () => {
    const t = go({ mode: 'agent' });
    expect(await t.p).toEqual({ mode: 'agent', launch: 'started-tmux' });
    expect(t.calls.filter((c) => c[1] === 'new-session')).toHaveLength(1);
    expect(t.state.guide_offered).toBe(true);
    expect(t.saves()).toBe(1);
  });
  it('agent and not ready: reason printed, no tmux call at all', async () => {
    const t = go({ mode: 'agent', ready: false, why: 'tmux is not available' });
    expect((await t.p).launch).toBe('not-ready');
    expect(t.calls).toHaveLength(0);
    expect(t.said.join('\n')).toContain('tmux is not available');
    expect(t.state.guide_offered).toBeUndefined();
  });
  it('terminal: zero calls', async () => {
    const t = go({ mode: 'terminal' });
    expect(await t.p).toEqual({ mode: 'terminal', launch: 'none' });
    expect(t.calls).toHaveLength(0);
  });
  it('--step (not interactive): nothing launched', async () => {
    const t = go({ mode: 'agent', interactive: false });
    expect(await t.p).toEqual({ mode: 'agent', launch: 'none' });
    expect(t.calls).toHaveLength(0);
  });
  it('--no-guide with stored agent: terminal, no launch, stored mode untouched', async () => {
    const t = go({ mode: 'agent', noGuide: true });
    expect(await t.p).toEqual({ mode: 'terminal', launch: 'none' });
    expect(t.calls).toHaveLength(0);
    expect(t.state.mode).toBe('agent');
  });
});

describe('stored line and status', () => {
  it('stored agent with --no-guide says so', async () => {
    const m = make([], { stored: 'agent', noGuide: true });
    await resolveMode(m.deps);
    expect(m.io.transcript.join('\n')).toContain('--no-guide makes this run terminal-only');
  });
  it('formatStatus labels a recommended skip and a plain skip', () => {
    const st = emptyState();
    st.mode = 'agent';
    st.steps.telegram = { status: 'skipped', at: 't1' };
    st.steps.resume = { status: 'skipped', at: 't2' };
    const out = formatStatus(['telegram', 'resume'], st);
    expect(out).toBe('mode: agent\ntelegram  skipped (recommended)  t1\nresume  skipped  t2');
  });
  it('formatStatus shows configured (not via setup) for an unrecorded or skipped step that is configured, and changes no state', () => {
    const st = emptyState();
    st.steps.dashboard = { status: 'skipped', at: 't9' };
    st.steps.resume = { status: 'done', at: 't2' };
    const before = JSON.stringify(st);
    const out = formatStatus(['telegram', 'gmail', 'sessions', 'dashboard', 'resume', 'limits'], st, new Set(['telegram', 'sessions', 'dashboard', 'resume']));
    expect(out).toBe([
      'mode: unset',
      'telegram  configured (not via setup)',
      'gmail  pending',
      'sessions  configured (not via setup)',
      'dashboard  configured (not via setup)',
      'resume  done  t2',
      'limits  pending',
    ].join('\n'));
    expect(JSON.stringify(st)).toBe(before);
  });
  it('configuredSteps: skippable features by the configured rule, other steps when all their checks pass (injected, no network)', () => {
    const res = (id: string, status: 'pass' | 'warn' | 'fail') => ({ id, title: id, result: { status, detail: id } });
    const got = configuredSteps({
      steps: [
        { id: 'telegram', checkIds: ['telegram-api', 'ccgram-env'] },
        { id: 'gmail', checkIds: ['gmail-oauth'] },
        { id: 'apikeys', checkIds: ['api-keys'] },
        { id: 'sessions', checkIds: ['sessions'] },
        { id: 'resume', checkIds: ['resume-valid'] },
        { id: 'classifier', checkIds: ['classifier_model'] },
        { id: 'dashboard', checkIds: [] },
        { id: 'final', checkIds: [] },
      ],
      results: [res('sessions', 'pass'), res('resume-valid', 'warn'), res('classifier_model', 'pass')],
      env: { TELEGRAM_BOT_TOKEN: 'x', WEB_AUTH_MODE: 'google_desktop' },
      fs: { exists: () => false },
      root: 'r',
    });
    expect([...got].sort()).toEqual(['classifier', 'dashboard', 'sessions', 'telegram']);
  });
});
