// tests/setup-coach.test.ts
// Coach helpers: skip offer, done-confirm loop, text catalog lint.
import { describe, expect, it } from 'vitest';
import { scriptedIO } from '../src/setup/io.js';
import type { ScriptItem } from '../src/setup/io.js';
import type { SetupContext } from '../src/setup/runner.js';
import { COACH_TEXT, coachOn, confirmDone, offerSkip, say } from '../src/setup/coach.js';
import { SKIP_SPECS } from '../src/setup/skips.js';

function mk(mode: 'agent' | 'terminal' | undefined, script: ScriptItem[]) {
  const io = scriptedIO(script);
  const ctx = { io: { ...io, registerSecret() {} }, mode } as unknown as SetupContext;
  return { io, ctx };
}
const tg = SKIP_SPECS.find((s) => s.id === 'telegram')!;
const opt = SKIP_SPECS.find((s) => s.label === 'OPTIONAL')!;

describe('coachOn and say', () => {
  it('is on only for terminal and say prints nothing otherwise', () => {
    expect(coachOn({ mode: 'terminal' })).toBe(true);
    expect(coachOn({ mode: 'agent' })).toBe(false);
    expect(coachOn({})).toBe(false);
    const a = mk('agent', []);
    say(a.ctx, 'generic.outside_terminal');
    expect(a.io.transcript).toEqual([]);
    const t = mk('terminal', []);
    say(t.ctx, 'generic.outside_terminal');
    expect(t.io.transcript.length).toBe(COACH_TEXT['generic.outside_terminal'].length);
  });
});

describe('offerSkip', () => {
  for (const mode of ['agent', 'terminal'] as const) {
    it(`prints label and lose lines and returns each choice (${mode})`, async () => {
      for (const [pick, want] of [
        ['now', 'now'],
        ['later', 'later'],
        ['', 'now'],
      ] as const) {
        const { io, ctx } = mk(mode, [{ choose: pick }]);
        expect(await offerSkip(ctx, tg)).toBe(want);
        const t = io.transcript.join('\n');
        expect(t).toContain(`[${tg.label}] ${tg.title}`);
        for (const l of tg.lose) expect(t).toContain(l);
        io.assertDone();
      }
    });
  }
  it('call site default applies for an optional item', async () => {
    const { ctx } = mk('agent', [{ choose: '' }]);
    expect(await offerSkip(ctx, opt, 'later')).toBe('later');
  });
});

describe('confirmDone', () => {
  const o = { id: 'x', action: 'Do it', explain: ['1. one'], again: ['Again, slowly.'] };
  it('yes first time', async () => {
    const { io, ctx } = mk('terminal', [{ confirm: true }]);
    expect(await confirmDone(ctx, o)).toBe('done');
    const t = io.transcript.join('\n');
    expect(t).toContain('1. one');
    expect(t).not.toContain('Again, slowly.');
  });
  it('no then yes prints the re-explanation once', async () => {
    const { io, ctx } = mk('terminal', [{ confirm: false }, { confirm: true }]);
    expect(await confirmDone(ctx, o)).toBe('done');
    expect(io.transcript.filter((l) => l.includes('Again, slowly.')).length).toBe(1);
  });
  it('three no answers skip with allowSkip and throw without', async () => {
    const three: ScriptItem[] = [{ confirm: false }, { confirm: false }, { confirm: false }];
    expect(await confirmDone(mk('agent', three).ctx, { ...o, allowSkip: true })).toBe('skip');
    await expect(confirmDone(mk('agent', three).ctx, o)).rejects.toThrow('step not confirmed');
  });
  it('honours maxRounds', async () => {
    const { ctx } = mk('agent', [{ confirm: false }]);
    expect(await confirmDone(ctx, { ...o, maxRounds: 1, allowSkip: true })).toBe('skip');
  });
});

describe('mode never changes the prompts issued', () => {
  const prompts = (t: string[]) => t.filter((l) => !l.startsWith('say:'));
  it('offerSkip and confirmDone issue identical prompts in both modes', async () => {
    const run = async (mode: 'agent' | 'terminal') => {
      const { io, ctx } = mk(mode, [{ choose: 'now' }, { confirm: false }, { confirm: true }]);
      await offerSkip(ctx, tg);
      await confirmDone(ctx, { id: 'x', action: 'A', explain: ['e'], again: ['g'] });
      say(ctx, 'generic.outside_terminal');
      io.assertDone();
      return prompts(io.transcript);
    };
    expect(await run('agent')).toEqual(await run('terminal'));
  });
});

describe('COACH_TEXT lint', () => {
  it('has generic entries', () => {
    expect(Object.keys(COACH_TEXT).length).toBeGreaterThan(0);
  });
  for (const [id, lines] of Object.entries(COACH_TEXT)) {
    it(`entry ${id} is clean`, () => {
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) {
        expect(l).toMatch(/^[\x20-\x7E]*$/);
        expect(l).not.toMatch(/[–—]/);
        expect(l.length).toBeLessThanOrEqual(110);
        expect(l).not.toMatch(/\d{5,}:[A-Za-z0-9_-]{10,}/);
        expect(l).not.toContain('GOCSPX-');
        expect(l).not.toMatch(/sk-/);
        expect(l).not.toMatch(/=\s*\S/);
      }
    });
  }
});
