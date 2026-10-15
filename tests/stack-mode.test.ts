// tests/stack-mode.test.ts
import { describe, expect, it } from 'vitest';
import { currentMode } from '../src/stack/mode.js';

describe('currentMode', () => {
  it('is DRY RUN when everything is unset', () => {
    const m = currentMode({});
    expect(m.mode).toBe('DRY RUN');
    expect(m.lines[0]).toBe('MODE: DRY RUN (nothing is sent)');
    expect(m.flags.SCHEDULER_DRY_RUN).toBe('(unset)');
  });
  it('is LIVE only when all three are explicitly live', () => {
    const live = { SCHEDULER_DRY_RUN: 'false', LINKEDIN_DRY_RUN: 'false', JOBBER_DRY_RUN: '0' };
    expect(currentMode(live).mode).toBe('LIVE');
    expect(currentMode(live).lines[0]).toContain('MODE: LIVE');
    expect(currentMode({ ...live, JOBBER_DRY_RUN: '1' }).mode).toBe('DRY RUN');
    expect(currentMode({ ...live, LINKEDIN_DRY_RUN: 'true' }).mode).toBe('DRY RUN');
    expect(currentMode({ ...live, SCHEDULER_DRY_RUN: undefined }).mode).toBe('DRY RUN');
  });
  it('does not mutate its input', () => {
    const env = { SCHEDULER_DRY_RUN: 'true' };
    currentMode(env);
    expect(env).toEqual({ SCHEDULER_DRY_RUN: 'true' });
  });
});
