// tests/tmux-single-session.test.ts
// Piece 1: everything lives in ONE tmux session named Jobber (defaults, env override, run window names, keep-open option).
import { describe, expect, it } from 'vitest';
import { JOBBER_TMUX_SESSION } from '../src/platform/tmux.js';
import { ENV_CATALOG } from '../src/settings/envCatalog.js';
import { DEFAULT_STACK_SESSION } from '../src/stack/plan.js';
import { stackSession } from '../src/stack/up.js';
import { validateRunnerConfig } from '../src/web/env.js';

const spec = (k: string) => ENV_CATALOG.find((s) => s.key === k);

describe('the single Jobber session', () => {
  it('the shared constant is Jobber', () => {
    expect(JOBBER_TMUX_SESSION).toBe('Jobber');
    expect(DEFAULT_STACK_SESSION).toBe('Jobber');
  });
  it('the three session env keys all default to it', () => {
    for (const k of ['STACK_TMUX_SESSION', 'SCHEDULER_TMUX_SESSION', 'WEB_TMUX_SESSION']) expect(spec(k)?.default, k).toBe('Jobber');
  });
  it('the stack session defaults to Jobber and an env value overrides it', () => {
    expect(stackSession({})).toBe('Jobber');
    expect(stackSession({ STACK_TMUX_SESSION: '  ' })).toBe('Jobber');
    expect(stackSession({ STACK_TMUX_SESSION: 'other' })).toBe('other');
    expect(() => stackSession({ STACK_TMUX_SESSION: 'bad name' })).toThrow();
  });
  it('the dashboard chat session defaults to Jobber and WEB_TMUX_SESSION overrides it', () => {
    const sess = (e: Record<string, string>): string | undefined => {
      const r = validateRunnerConfig(e, { accountStored: true });
      return r.ok ? r.config.session : undefined;
    };
    expect([sess({}), sess({ WEB_TMUX_SESSION: 'mine' })]).toEqual(['Jobber', 'mine']);
  });
});
