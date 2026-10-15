// tests/dash-cli-token.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openAuthStore, listAudit } from '../src/dash/authStore.js';
import { createSession, validateSession } from '../src/dash/sessions.js';
import { verifyToken, tokenStatus } from '../src/dash/accessToken.js';
import { main, parseArgs } from '../scripts/dashboard.js';

const now = new Date('2026-10-15T10:00:00Z');

function harness(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jobber-'));
  const dbPath = join(dir, 'auth.sqlite');
  const out: string[] = [];
  const errs: string[] = [];
  const env = { WEB_AUTH_DB: dbPath, ...extraEnv };
  const run = (argv: string[], o: { isTTY?: boolean; yes?: boolean } = {}) =>
    main(argv, {
      env, stdout: (l) => out.push(l), stderr: (l) => errs.push(l),
      isTTY: o.isTTY ?? true, now: () => now, confirm: async () => o.yes ?? true,
    });
  const tokenFrom = (lines: string[]) => {
    const m = lines.join('\n').match(/#token=([A-Za-z0-9_-]{43})\b/);
    return m ? m[1] : null;
  };
  return { dbPath, out, errs, run, tokenFrom };
}

describe('parseArgs token/rotate', () => {
  it('parses each form', () => {
    expect(parseArgs(['token'])).toEqual({ ok: true, cmd: 'token', port: null, print: false });
    expect(parseArgs(['rotate', '--port', '9000'])).toEqual({ ok: true, cmd: 'rotate', port: 9000, print: false });
    expect(parseArgs(['token', '--print', '--port', '8788'])).toEqual({ ok: true, cmd: 'token', port: 8788, print: true });
  });
  it('rejects bad arities', () => {
    for (const a of [['token', 'x'], ['token', '--port'], ['token', '--port', 'abc'], ['token', '--port', '80'],
      ['rotate', '--port', '70000'], ['token', '--port', '2000', '--port', '3000'], ['rotate', '--bogus']]) {
      expect(parseArgs(a).ok).toBe(false);
    }
  });
});

describe('dashboard token / rotate / status', () => {
  it('token creates a hash and prints one URL line with a 43-char token', async () => {
    const h = harness();
    expect(await h.run(['token'])).toBe(0);
    expect(h.out[0]).toBe('Dashboard access token (shown once, not stored anywhere readable):');
    expect(h.out[1]).toMatch(/^http:\/\/127\.0\.0\.1:8787\/#token=[A-Za-z0-9_-]{43}$/);
    const db = openAuthStore(h.dbPath);
    expect(tokenStatus(db).set).toBe(true);
    expect(verifyToken(db, h.tokenFrom(h.out))).toBe(true);
    db.close();
  });
  it('uses --port, then WEB_PORT, and never WEB_BIND', async () => {
    const a = harness({ WEB_PORT: '9100', WEB_BIND: '0.0.0.0' });
    await a.run(['token']);
    expect(a.out[1]).toMatch(/^http:\/\/127\.0\.0\.1:9100\//);
    const b = harness({ WEB_PORT: '9100' });
    await b.run(['token', '--port', '9200']);
    expect(b.out[1]).toMatch(/^http:\/\/127\.0\.0\.1:9200\//);
  });
  it('a second token refuses and prints no token', async () => {
    const h = harness();
    await h.run(['token']);
    h.out.length = 0;
    expect(await h.run(['token'])).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.errs.join('\n')).toContain('rotate');
  });
  it('rotate invalidates the old token and revokes sessions', async () => {
    const h = harness();
    await h.run(['token']);
    const oldToken = h.tokenFrom(h.out)!;
    const db = openAuthStore(h.dbPath);
    const s = createSession(db, '127.0.0.1', now, now);
    db.close();
    h.out.length = 0;
    expect(await h.run(['rotate'])).toBe(0);
    const newToken = h.tokenFrom(h.out)!;
    expect(newToken).not.toBe(oldToken);
    const db2 = openAuthStore(h.dbPath);
    expect(verifyToken(db2, oldToken)).toBe(false);
    expect(verifyToken(db2, newToken)).toBe(true);
    expect(validateSession(db2, s.cookieValue, now)).toBeNull();
    db2.close();
  });
  it('rotate declined by confirm changes nothing', async () => {
    const h = harness();
    await h.run(['token']);
    const oldToken = h.tokenFrom(h.out)!;
    h.out.length = 0;
    expect(await h.run(['rotate'], { yes: false })).toBe(1);
    expect(h.tokenFrom(h.out)).toBeNull();
    const db = openAuthStore(h.dbPath);
    expect(verifyToken(db, oldToken)).toBe(true);
    db.close();
  });
  it('rotate with no token refuses', async () => {
    const h = harness();
    expect(await h.run(['rotate'])).toBe(1);
    expect(h.tokenFrom(h.out)).toBeNull();
  });
  it('non-TTY without --print refuses and stores nothing; --print works', async () => {
    const h = harness();
    expect(await h.run(['token'], { isTTY: false })).toBe(1);
    expect(h.out).toEqual([]);
    expect(h.errs.join('\n')).toContain('run this in a terminal; the token is shown once');
    const db = openAuthStore(h.dbPath);
    expect(tokenStatus(db).set).toBe(false);
    db.close();
    expect(await h.run(['token', '--print'], { isTTY: false })).toBe(0);
    expect(h.tokenFrom(h.out)).not.toBeNull();
  });
  it('status shows mode and dates but neither token nor hash', async () => {
    const h = harness();
    await h.run(['token']);
    const token = h.tokenFrom(h.out)!;
    const db = openAuthStore(h.dbPath);
    const hash = (db.prepare('SELECT token_hash FROM access_token WHERE id = 1').get() as { token_hash: string }).token_hash;
    db.close();
    h.out.length = 0;
    expect(await h.run(['status'])).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('auth mode: token');
    expect(text).toContain('access token set: yes');
    expect(text).toContain('2026-10-15T10:00:00.000Z');
    expect(text).not.toContain(token);
    expect(text).not.toContain(hash);
  });
  it('status with no token', async () => {
    const h = harness();
    await h.run(['status']);
    expect(h.out.join('\n')).toContain('access token set: no');
  });
  it('audit rows hold no token', async () => {
    const h = harness();
    await h.run(['token']);
    const token = h.tokenFrom(h.out)!;
    await h.run(['rotate']);
    const token2 = h.tokenFrom(h.out)!;
    const db = openAuthStore(h.dbPath);
    const rows = listAudit(db, 50);
    db.close();
    expect(rows.map((r) => r.kind).sort()).toEqual(['token_created', 'token_rotated']);
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(token2);
  });
});
