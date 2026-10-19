// Finding 11: one shared reader of the dashboard token state for doctor, stack and the skip catalog.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateToken, setToken } from '../src/dash/accessToken.js';
import { openAuthStore } from '../src/dash/authStore.js';
import { readAuthToken } from '../src/dash/authRead.js';
import { SKIP_SPECS, skippedForRoot } from '../src/setup/skips.js';
import { emptyState } from '../src/setup/state.js';

const NOW = new Date('2026-10-15T08:00:00Z');
const tmpRoot = (): string => mkdtempSync(join(tmpdir(), 'dash-tok-'));
const realFs = { exists: (p: string) => existsSync(p), read: (p: string) => readFileSync(p, 'utf8') };

describe('readAuthToken', () => {
  it('null for a missing file, not set for an empty store, set after setToken', () => {
    const p = join(tmpRoot(), 'auth.sqlite');
    expect(readAuthToken(p)).toBeNull();
    const db = openAuthStore(p);
    expect(readAuthToken(p)).toEqual({ set: false, createdAt: null });
    setToken(db, generateToken(), NOW);
    expect(readAuthToken(p)).toEqual({ set: true, createdAt: NOW.toISOString() });
    db.close();
  });
});

describe('dashboard skip catalog with a token on disk', () => {
  it('configured is true when the token store holds a token, false otherwise', () => {
    const root = tmpRoot();
    const spec = SKIP_SPECS.find((s) => s.id === 'dashboard')!;
    expect(spec.configured({}, realFs, root)).toBe(false);
    const db = openAuthStore(join(root, '.dashboard', 'auth.sqlite'));
    expect(spec.configured({}, realFs, root)).toBe(false);
    setToken(db, generateToken(), NOW);
    db.close();
    expect(spec.configured({}, realFs, root)).toBe(true);
  });

  it('a stale skip record is ignored once the token exists (up and doctor see no skip)', () => {
    const root = tmpRoot();
    mkdirSync(join(root, 'user-data'), { recursive: true });
    const st = emptyState();
    st.steps.dashboard = { status: 'skipped', at: NOW.toISOString() };
    writeFileSync(join(root, 'user-data', '.setup-state.json'), JSON.stringify(st));
    expect(skippedForRoot({ root, env: {}, fs: realFs })).toContain('dashboard');
    const db = openAuthStore(join(root, '.dashboard', 'auth.sqlite'));
    setToken(db, generateToken(), NOW);
    db.close();
    expect(skippedForRoot({ root, env: {}, fs: realFs })).not.toContain('dashboard');
  });
});

describe('doctor and stack read the same helper', () => {
  it('neither script carries its own access_token query', () => {
    for (const f of ['scripts/doctor.ts', 'scripts/stack.ts']) {
      const src = readFileSync(join(import.meta.dirname, '..', f), 'utf8');
      expect(src).not.toContain('FROM access_token');
      expect(src).toContain('readAuthToken');
    }
  });
});
