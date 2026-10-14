import { describe, it, expect } from 'vitest';
import { parseWebEnv } from '../src/web/env.js';

describe('parseWebEnv', () => {
  it('applies defaults', () => {
    expect(parseWebEnv({})).toEqual({
      ok: true,
      config: { port: 8787, session: 'ccgram', window: 'JobApplier' },
    });
  });
  it('rejects bad ports', () => {
    for (const p of ['80', '1023', '65536', 'abc', '8787.5', '-1']) {
      expect(parseWebEnv({ WEB_PORT: p }).ok).toBe(false);
    }
    expect(parseWebEnv({ WEB_PORT: '1024' }).ok).toBe(true);
    expect(parseWebEnv({ WEB_PORT: '65535' }).ok).toBe(true);
  });
  it('treats a whitespace-only WEB_PORT like empty: default 8787', () => {
    const r = parseWebEnv({ WEB_PORT: '   ' });
    expect(r.ok && r.config.port).toBe(8787);
  });
  it('rejects invalid tmux names', () => {
    expect(parseWebEnv({ WEB_TMUX_SESSION: 'a b' }).ok).toBe(false);
    expect(parseWebEnv({ WEB_TMUX_WINDOW: '-x' }).ok).toBe(false);
    expect(parseWebEnv({ WEB_TMUX_WINDOW: 'w;rm' }).ok).toBe(false);
  });
});
