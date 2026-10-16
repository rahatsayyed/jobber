// tests/setup-final-skips.test.ts
// Plan 8F task 8: terminal-mode coaching for prereqs, claude and sessions (agent transcripts stay
// byte-identical) and the skip-aware final summary.
import { describe, expect, it } from 'vitest';
import type { DoctorContext } from '../src/platform/doctor.js';
import { COACH_TEXT } from '../src/setup/coach.js';
import { scriptedIO, type ScriptItem } from '../src/setup/io.js';
import type { SetupContext, SetupFs } from '../src/setup/runner.js';
import { emptyState } from '../src/setup/state.js';
import { claudeStep } from '../src/setup/steps/claude.js';
import { finalStep } from '../src/setup/steps/final.js';
import { prereqsStep } from '../src/setup/steps/prereqs.js';
import { sessionsStep } from '../src/setup/steps/sessions.js';

function memFs(seed: Record<string, string> = {}): SetupFs {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    exists: (p) => files.has(p),
    read: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    write: (p, d) => void files.set(p, d),
    rename: (a, b) => {
      files.set(b, files.get(a) ?? '');
      files.delete(a);
    },
    chmod: () => undefined,
    remove: (p) => void files.delete(p),
    mkdirp: () => undefined,
    copy: () => undefined,
    list: () => [],
  };
}

function mk(
  mode: 'agent' | 'terminal' | undefined,
  script: ScriptItem[],
  opts: { files?: Record<string, string>; skipped?: string[]; env?: NodeJS.ProcessEnv } = {},
) {
  const fs = memFs(opts.files);
  const sio = scriptedIO(script);
  const run = (async () => ({ stdout: '', stderr: '', code: 1 })) as unknown as SetupContext['run'];
  const doctor = {
    root: 'proj',
    env: opts.env ?? {},
    run,
    fs: { exists: (p: string) => fs.exists(p), read: (p: string) => fs.read(p), mode: () => null },
  } as unknown as DoctorContext;
  const state = emptyState();
  for (const id of opts.skipped ?? []) state.steps[id] = { status: 'skipped', at: '2026-10-14T00:00:00Z' };
  const ctx: SetupContext = {
    io: Object.assign(sio, { registerSecret() {} }),
    root: 'proj',
    env: opts.env ?? {},
    fs,
    run,
    spawnInteractive: async () => 0,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    now: () => new Date('2026-10-14T00:00:00Z'),
    doctor,
    state,
    statePath: 'proj/user-data/.setup-state.json',
    envPath: 'proj/.env',
    mode,
  };
  return { ctx, sio };
}

const coachLines = (ids: string[]): string[] => ids.flatMap((id) => COACH_TEXT[id] ?? []);
const swallow = async (p: Promise<unknown>): Promise<void> => {
  try {
    await p;
  } catch {
    /* the step throws after its last round */
  }
};

describe('terminal-mode coaching text', () => {
  it('prereqs: only terminal mode prints the intro; prompts are identical', async () => {
    const script: ScriptItem[] = [{ pause: true }, { pause: true }];
    const a = mk('agent', script);
    const u = mk(undefined, script);
    const t = mk('terminal', script);
    await prereqsStep.run(a.ctx);
    await prereqsStep.run(u.ctx);
    await prereqsStep.run(t.ctx);
    expect(a.sio.transcript).toEqual(u.sio.transcript);
    const want = coachLines(['prereqs.intro']);
    expect(want.length).toBeGreaterThan(0);
    expect(t.sio.transcript.map((l) => l.replace(/^say: /, ''))).toEqual(
      expect.arrayContaining(want),
    );
    for (const l of want) expect(a.sio.transcript.join('\n')).not.toContain(l);
    expect(t.sio.transcript.filter((l) => !want.some((w) => l.includes(w)))).toEqual(a.sio.transcript);
    expect(want.join(' ')).toContain('bash scripts/bootstrap.sh');
  });

  it('claude: only terminal mode prints how to log in', async () => {
    const script: ScriptItem[] = [{ pause: true }, { pause: true }, { pause: true }];
    const a = mk('agent', script);
    const t = mk('terminal', script);
    await swallow(claudeStep.run(a.ctx));
    await swallow(claudeStep.run(t.ctx));
    const want = coachLines(['claude.intro']);
    expect(want.length).toBeGreaterThan(0);
    for (const l of want) expect(a.sio.transcript.join('\n')).not.toContain(l);
    for (const l of want) expect(t.sio.transcript.join('\n')).toContain(l);
    expect(t.sio.transcript.filter((l) => !want.some((w) => l.includes(w)))).toEqual(a.sio.transcript);
  });

  it('sessions: only terminal mode prints why, the window text and the lose line on skip', async () => {
    const script: ScriptItem[] = [{ confirm: false }, { confirm: false }];
    const a = mk('agent', script);
    const t = mk('terminal', script);
    expect(await sessionsStep.run(a.ctx)).toBe('done');
    expect(await sessionsStep.run(t.ctx)).toBe('done');
    const want = coachLines([
      'sessions.why',
      'sessions.window',
      'sessions.lose.linkedin_main',
      'sessions.lose.naukri',
    ]);
    for (const l of want) expect(a.sio.transcript.join('\n')).not.toContain(l);
    for (const l of want) expect(t.sio.transcript.join('\n')).toContain(l);
    expect(t.sio.transcript.filter((l) => !want.some((w) => l.includes(w)))).toEqual(a.sio.transcript);
    expect(want.join(' ')).toMatch(/unmeasured/);
  });
});

describe('final summary', () => {
  const text = (t: string[]): string => t.join('\n');

  it('nothing skipped: today lines plus the pointers, no skipped list', async () => {
    const { ctx, sio } = mk('agent', []);
    expect(await finalStep.run(ctx)).toBe('done');
    const out = text(sio.transcript);
    expect(out).not.toContain('Skipped by choice');
    expect(out).toContain('bash scripts/ccgram/start.sh');
    expect(out).toContain('/health');
    expect(out).toContain('npm run dashboard -- token');
    expect(out).toContain('npm run dry-run');
    expect(out).toContain('npm run up');
    expect(out).toContain('first supervised /runhunt');
  });

  it('telegram and dashboard skipped: listed with commands, no bridge, health or token line', async () => {
    const { ctx, sio } = mk('terminal', [], { skipped: ['telegram', 'dashboard'] });
    expect(await finalStep.run(ctx)).toBe('done');
    const out = text(sio.transcript);
    expect(out).toContain('Skipped by choice');
    expect(out).toContain('npm run setup -- --step telegram');
    expect(out).toContain('npm run setup -- --step dashboard');
    const next = out.slice(out.indexOf('Next, yourself:'));
    expect(next).not.toContain('bash scripts/ccgram/start.sh');
    expect(next).not.toContain('/health');
    expect(next).not.toContain('dashboard -- token');
    expect(next).toContain('npm run dry-run');
    expect(next).toContain('npm run up');
  });

  it('a skipped feature that is configured anyway is not listed', async () => {
    const { ctx, sio } = mk('agent', [], {
      skipped: ['telegram'],
      files: { 'proj/.env': 'TELEGRAM_BOT_TOKEN=abc\n' },
    });
    await finalStep.run(ctx);
    expect(text(sio.transcript)).not.toContain('Skipped by choice');
  });

  it('open classifier model appears under Not ready for live, with its re-run command', async () => {
    const { ctx, sio } = mk('agent', []);
    await finalStep.run(ctx);
    const out = text(sio.transcript);
    expect(out).toContain('Not ready for live');
    const section = out.slice(out.indexOf('Not ready for live'));
    expect(section).toMatch(/classifier/i);
    expect(section).toContain('npm run setup -- --step classifier');
  });

  it('prints no secret and never fails', async () => {
    const secret = 'GOCSPX-canary-secret-value-123';
    const { ctx, sio } = mk('terminal', [], {
      skipped: ['gmail'],
      files: { 'proj/.env': `TELEGRAM_BOT_TOKEN=${secret}\n` },
    });
    expect(await finalStep.run(ctx)).toBe('done');
    expect(text(sio.transcript)).not.toContain(secret);
  });
});
