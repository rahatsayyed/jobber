import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { connectSend, sendLinkedinMessage } from '../src/mcp/connect.js';
import { openDb } from '../src/db.js';
import type Database from 'better-sqlite3';

const PROFILE = 'https://www.linkedin.com/in/some-person';

describe('legacy connect kill switch', () => {
  let db: Database.Database;
  let saved: string | undefined;

  beforeEach(() => {
    db = openDb(':memory:');
    saved = process.env.LEGACY_CONNECT_DISABLED;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.LEGACY_CONNECT_DISABLED;
    else process.env.LEGACY_CONNECT_DISABLED = saved;
  });

  function counterRows(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM daily_counters').get() as { n: number }).n;
  }

  it('connectSend refuses before launch or counter when disabled', async () => {
    process.env.LEGACY_CONNECT_DISABLED = 'true';
    const launch = vi.fn();
    const res = await connectSend({ profile_url: PROFILE, note: 'hi' }, { db, chromium: { launch } as never });
    expect(res.status).toBe('failed');
    expect(res.reason).toContain('deprecated');
    expect(launch).not.toHaveBeenCalled();
    expect(counterRows()).toBe(0);
  });

  it('sendLinkedinMessage refuses before launch or counter when disabled', async () => {
    process.env.LEGACY_CONNECT_DISABLED = 'true';
    const launch = vi.fn();
    const res = await sendLinkedinMessage(
      { profile_url: PROFILE, message: 'hello' },
      { db, chromium: { launch } as never }
    );
    expect(res.status).toBe('failed');
    expect(res.reason).toContain('deprecated');
    expect(launch).not.toHaveBeenCalled();
    expect(counterRows()).toBe(0);
  });

  it('is unchanged when the env var is unset', async () => {
    delete process.env.LEGACY_CONNECT_DISABLED;
    const launch = vi.fn().mockRejectedValue(new Error('no browser in tests'));
    const res = await connectSend({ profile_url: PROFILE, note: 'hi' }, { db, chromium: { launch } as never });
    expect(res.status).toBe('failed');
    expect(res.reason ?? '').not.toContain('deprecated');
    const res2 = await sendLinkedinMessage(
      { profile_url: PROFILE, message: 'hello' },
      { db, chromium: { launch } as never }
    );
    expect(res2.status).toBe('failed');
    expect(res2.reason ?? '').not.toContain('deprecated');
  });
});
