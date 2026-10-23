import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { haltPlatform, clearHalt } from '../src/outreach/limits.js';
import { readControl, setStop, clearStop, defaultDeps, type ControlDeps } from '../src/scheduler/control.js';

const NOW = new Date('2026-10-15T10:00:00Z');
let dir: string;
let db: ReturnType<typeof openDb>;

function deps(over: Partial<ControlDeps> = {}, env: NodeJS.ProcessEnv = {}): ControlDeps {
  return {
    stopFile: join(dir, '.jobber', 'STOP'),
    env,
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, 'utf8'),
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jobber-ctl-'));
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('readControl', () => {
  it('allows both platforms with no signals', () => {
    const s = readControl(db, deps());
    expect(s.killed).toBe(false);
    expect(s.allowed).toEqual(['linkedin', 'naukri', 'wellfound']);
    expect(s.readError).toBeNull();
  });

  it('kills on STOP file and shows reason', () => {
    const d = deps();
    setStop(d.stopFile, 'captcha seen', NOW);
    const s = readControl(db, d);
    expect(s.killed).toBe(true);
    expect(s.killReason).toContain('captcha seen');
    expect(s.allowed).toEqual([]);
  });

  it('kills on JOBBER_KILL=1', () => {
    const s = readControl(db, deps({}, { JOBBER_KILL: '1' }));
    expect(s.killed).toBe(true);
    expect(s.allowed).toEqual([]);
  });

  it('kills on halt all', () => {
    haltPlatform(db, 'all', 'maintenance', NOW);
    const s = readControl(db, deps());
    expect(s.killed).toBe(true);
    expect(s.killReason).toContain('maintenance');
  });

  it('platform halt leaves the other allowed, and clearing re-allows', () => {
    haltPlatform(db, 'linkedin', 'restricted', NOW);
    let s = readControl(db, deps());
    expect(s.killed).toBe(false);
    expect(s.halted.linkedin).toBe('restricted');
    expect(s.allowed).toEqual(['naukri', 'wellfound']);
    clearHalt(db, 'linkedin', NOW);
    s = readControl(db, deps());
    expect(s.allowed).toEqual(['linkedin', 'naukri', 'wellfound']);
    // a wellfound halt stops only wellfound
    haltPlatform(db, 'wellfound', 'bot wall', NOW);
    s = readControl(db, deps());
    expect(s.allowed).toEqual(['linkedin', 'naukri']);
    expect(s.halted.wellfound).toBe('bot wall');
  });

  it('fails closed when exists throws', () => {
    const s = readControl(db, deps({ exists: () => { throw new Error('EACCES'); } }));
    expect(s.killed).toBe(true);
    expect(s.readError).toContain('EACCES');
    expect(s.allowed).toEqual([]);
  });

  it('fails closed on a sqlite error', () => {
    db.exec('DROP TABLE halt_flags');
    const s = readControl(db, deps());
    expect(s.killed).toBe(true);
    expect(s.readError).not.toBeNull();
  });
});

describe('fail closed hardening', () => {
  it('STOP exists but read throws: killed with readError', () => {
    const s = readControl(db, deps({ exists: () => true, read: () => { throw new Error('EIO'); } }));
    expect(s.killed).toBe(true);
    expect(s.readError).toContain('STOP file unreadable');
    expect(s.killReason).toContain('STOP file');
  });

  it('active halt row with empty reason still halts', () => {
    db.prepare("INSERT INTO halt_flags (platform, reason, set_at, cleared_at) VALUES ('all', '', ?, NULL)").run(NOW.toISOString());
    const s = readControl(db, deps());
    expect(s.killed).toBe(true);
    expect(s.killReason).toContain('halt flag set (no reason)');
    db.prepare("INSERT INTO halt_flags (platform, reason, set_at, cleared_at) VALUES ('naukri', '', ?, NULL)").run(NOW.toISOString());
    db.prepare("UPDATE halt_flags SET cleared_at = ? WHERE platform = 'all'").run(NOW.toISOString());
    const t = readControl(db, deps());
    expect(t.killed).toBe(false);
    expect(t.halted.naukri).toBe('halt flag set (no reason)');
    expect(t.allowed).toEqual(['linkedin', 'wellfound']);
  });

  it('all plus platform halt together is killed', () => {
    haltPlatform(db, 'all', 'big', NOW);
    haltPlatform(db, 'linkedin', 'small', NOW);
    const s = readControl(db, deps());
    expect(s.killed).toBe(true);
    expect(s.halted.linkedin).toBe('small');
    expect(s.allowed).toEqual([]);
  });

  it('long reasons keep every key and the total stays within 200', () => {
    const d = deps();
    setStop(d.stopFile, 'z'.repeat(500), NOW);
    haltPlatform(db, 'all', 'y'.repeat(500), NOW);
    const s = readControl(db, { ...d, env: { JOBBER_KILL: '1' } });
    expect(s.killReason!.length).toBeLessThanOrEqual(200);
    expect(s.killReason).toContain('STOP file');
    expect(s.killReason).toContain('JOBBER_KILL=1');
    expect(s.killReason).toContain('halt all');
  });

  const unprivileged = typeof process.getuid === 'function' && process.getuid() !== 0;
  it.skipIf(!unprivileged)('default exists on an unstattable path kills with readError; clearStop throws', () => {
    const parent = join(dir, 'locked');
    mkdirSync(join(parent, 'sub'), { recursive: true });
    const f = join(parent, 'sub', 'STOP');
    writeFileSync(f, 'x');
    chmodSync(parent, 0o000);
    try {
      const s = readControl(db, defaultDeps({}, f));
      expect(s.killed).toBe(true);
      expect(s.readError).toContain('STOP file unreadable');
      expect(() => clearStop(f)).toThrow();
    } finally {
      chmodSync(parent, 0o755);
    }
  });
});

describe('setStop / clearStop', () => {
  it('round trips true then false', () => {
    const f = join(dir, 'sub', 'STOP');
    setStop(f, 'x', NOW);
    expect(clearStop(f)).toBe(true);
    expect(clearStop(f)).toBe(false);
  });

  it('truncates the reason to 200 characters', () => {
    const d = deps();
    setStop(d.stopFile, 'a'.repeat(500), NOW);
    const s = readControl(db, d);
    expect(s.killReason!.length).toBeLessThanOrEqual(200);
    expect(readFileSync(d.stopFile, 'utf8').split('\n')[0]).toHaveLength(200);
  });
});
