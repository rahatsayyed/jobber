import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { haltPlatform, clearHalt } from '../src/outreach/limits.js';
import { readControl, setStop, clearStop, type ControlDeps } from '../src/scheduler/control.js';

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
    expect(s.allowed).toEqual(['linkedin', 'naukri']);
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
    expect(s.allowed).toEqual(['naukri']);
    clearHalt(db, 'linkedin', NOW);
    s = readControl(db, deps());
    expect(s.allowed).toEqual(['linkedin', 'naukri']);
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
