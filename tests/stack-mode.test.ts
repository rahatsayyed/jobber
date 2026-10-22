// tests/stack-mode.test.ts
import { describe, expect, it } from 'vitest';
import { currentMode, fileFlags, shellDivergence } from '../src/stack/mode.js';

describe('currentMode', () => {
  it('is LIVE when the flag is unset (the default is live, never a guess of dry)', () => {
    const m = currentMode({});
    expect(m.mode).toBe('LIVE');
    expect(m.lines[0]).toContain('MODE: LIVE');
    expect(m.flags.JOBBER_DRY_RUN).toBe('(unset, runs LIVE)');
  });
  it('is DRY RUN only for 1 or true, any case, trimmed', () => {
    for (const v of ['1', 'true', 'TRUE', ' True ']) {
      const m = currentMode({ JOBBER_DRY_RUN: v });
      expect(m.mode, v).toBe('DRY RUN');
      expect(m.lines[0]).toBe('MODE: DRY RUN (nothing is sent)');
    }
    for (const v of ['false', '0', '', 'yes', 'dry']) expect(currentMode({ JOBBER_DRY_RUN: v }).mode, v).toBe('LIVE');
  });
  it('ignores the retired per-area flags', () => {
    expect(currentMode({ SCHEDULER_DRY_RUN: 'true', LINKEDIN_DRY_RUN: 'true', WEB_DRY_RUN: 'true' }).mode).toBe('LIVE');
    expect(currentMode({ JOBBER_DRY_RUN: 'true', SCHEDULER_DRY_RUN: 'false', LINKEDIN_DRY_RUN: 'false' }).mode).toBe('DRY RUN');
  });
  it('fileFlags carries only the master flag', () => {
    expect(fileFlags({ JOBBER_DRY_RUN: 'true', SCHEDULER_DRY_RUN: 'false', OTHER: 'x' })).toEqual({ JOBBER_DRY_RUN: 'true' });
    expect(shellDivergence({ JOBBER_DRY_RUN: 'true' }, { SCHEDULER_DRY_RUN: 'false' })).toEqual([]);
  });
  it('does not mutate its input', () => {
    const env = { JOBBER_DRY_RUN: 'true' };
    currentMode(env);
    expect(env).toEqual({ JOBBER_DRY_RUN: 'true' });
  });
});
