// tests/setup-guide-offer.test.ts
import { describe, expect, it } from 'vitest';
import type { CheckOutcome } from '../src/platform/doctor.js';
import { parseArgs } from '../src/setup/cli.js';
import { formatStatus, offerGuide, runGuideOnly, type GuideDeps } from '../src/setup/guide.js';
import { emptyState, loadState } from '../src/setup/state.js';

const pass = (id: string): CheckOutcome => ({ id, title: id, result: { status: 'pass', detail: 'ok' } });
const ALL = ['claude-cli', 'claude-login', 'setup_guide_ready'].map(pass);

interface Opts {
  answer?: boolean;
  tmux?: boolean;
  windows?: string;
  session?: boolean;
  noGuide?: boolean;
  tty?: boolean;
  checks?: () => Promise<CheckOutcome[]>;
}

function make(o: Opts = {}) {
  const calls: string[][] = [];
  const said: string[] = [];
  let asked = 0;
  let saves = 0;
  const state = emptyState();
  const deps: GuideDeps = {
    io: {
      say: (l) => void said.push(l),
      confirm: async () => {
        asked++;
        return o.answer ?? true;
      },
    },
    root: 'proj',
    run: (async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args[0] === '-V') return { stdout: '', code: o.tmux === false ? 1 : 0 };
      if (args[0] === 'has-session') return { stdout: '', code: o.session ? 0 : 1 };
      if (args[0] === 'list-windows') return { stdout: o.windows ?? '', code: 0 };
      return { stdout: '', code: 0 };
    }) as GuideDeps['run'],
    state,
    noGuide: o.noGuide ?? false,
    tty: o.tty ?? true,
    checks: o.checks ?? (async () => ALL),
    save: () => void saves++,
  };
  return { deps, calls, said, state, asked: () => asked, saves: () => saves };
}

describe('offerGuide', () => {
  it('skips when --no-guide, no tty, already offered, or a check does not pass', async () => {
    const failing: CheckOutcome = { id: 'claude-login', title: '', result: { status: 'fail', detail: '' } };
    for (const o of [
      { noGuide: true },
      { tty: false },
      { checks: async () => ALL.slice(0, 2) },
      { checks: async () => [ALL[0], failing, ALL[2]] },
    ] as Opts[]) {
      const m = make(o);
      expect(await offerGuide(m.deps)).toBe('skipped');
      expect(m.asked()).toBe(0);
      expect(m.calls.length).toBe(0);
    }
    const m = make();
    m.state.guide_offered = true;
    expect(await offerGuide(m.deps)).toBe('skipped');
    expect(m.asked()).toBe(0);
  });

  it('accepted: one new-session with the launcher, no send-keys, offer persisted', async () => {
    const m = make();
    expect(await offerGuide(m.deps)).toBe('started-tmux');
    const ns = m.calls.filter((c) => c[1] === 'new-session');
    expect(ns).toHaveLength(1);
    expect(ns[0].slice(0, 9)).toEqual(['tmux', 'new-session', '-d', '-s', 'jobber-setup', '-n', 'guide', '-c', 'proj']);
    expect(ns[0]).toContain('scripts/run-claude.sh');
    expect(ns[0]).toContain('setup_guide');
    expect(ns[0]).toContain('--interactive');
    expect(m.calls.some((c) => c.includes('send-keys'))).toBe(false);
    expect(m.said.join('\n')).toContain('tmux attach -t jobber-setup');
    expect(m.said.join('\n')).toContain('Keep entering keys in THIS window');
    expect(m.state.guide_offered).toBe(true);
    expect(m.saves()).toBe(1);
  });

  it('existing guide window: nothing is created', async () => {
    const m = make({ session: true, windows: 'guide\n' });
    expect(await offerGuide(m.deps)).toBe('already-running');
    expect(m.calls.some((c) => c[1] === 'new-session' || c[1] === 'new-window')).toBe(false);
  });

  it('no tmux prints the second-terminal command', async () => {
    const m = make({ tmux: false });
    expect(await offerGuide(m.deps)).toBe('no-tmux');
    expect(m.said.join('\n')).toContain('npm run setup -- --guide-only');
    expect(m.calls.some((c) => c[1] === 'new-session')).toBe(false);
  });

  it('decline persists', async () => {
    const m = make({ answer: false });
    expect(await offerGuide(m.deps)).toBe('declined');
    expect(m.state.guide_offered).toBe(true);
    expect(m.saves()).toBe(1);
    expect(m.calls.some((c) => c[1] === 'new-session')).toBe(false);
  });
});

describe('guide-only, status, args', () => {
  it('guide-only goes through the injected spawner with the fixed prompt', async () => {
    const seen: string[][] = [];
    const code = await runGuideOnly(async (c, a) => {
      seen.push([c, ...a]);
      return 0;
    });
    expect(code).toBe(0);
    expect(seen).toEqual([
      ['bash', 'scripts/run-claude.sh', 'setup_guide', '--interactive', 'Use the setup-guide skill. Start by running the doctor.'],
    ]);
  });

  it('status prints ids, statuses and times only', () => {
    const st = loadState('p', {
      exists: () => true,
      read: () =>
        JSON.stringify({
          version: 1,
          steps: { env: { status: 'done', at: '2026-10-14T00:00:00Z' }, limits: { status: 'skipped', at: '2026-10-14T01:00:00Z' } },
          answers: { WEB_PORT: 'invented-value-xyz' },
        }),
    });
    const out = formatStatus(['env', 'limits', 'final'], st);
    expect(out).toBe('env  done  2026-10-14T00:00:00Z\nlimits  skipped  2026-10-14T01:00:00Z\nfinal  pending');
    expect(out).not.toContain('invented-value');
  });

  it('guide_offered round-trips through loadState', () => {
    const st = loadState('p', {
      exists: () => true,
      read: () => JSON.stringify({ version: 1, steps: {}, answers: {}, guide_offered: true }),
    });
    expect(st.guide_offered).toBe(true);
  });

  it('parseArgs handles the new flags and rejects the combination', () => {
    expect(parseArgs(['--no-guide']).noGuide).toBe(true);
    expect(parseArgs(['--guide-only']).guideOnly).toBe(true);
    expect(parseArgs(['--status']).status).toBe(true);
    expect(parseArgs(['--guide-only', '--no-guide']).error).toBeDefined();
  });
});
