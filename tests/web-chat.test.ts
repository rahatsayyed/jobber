import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { confirmSend, prepareSend, STATUS_COMMANDS, validateChatText } from '../src/web/chat.js';
import { refreshAuth } from '../src/dash/sessions.js';
import { makeHarness, START, type Harness } from './helpers/webHarness.js';

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.close();
  h = null;
});

const sha = (s: string): string => createHash('sha256').update(s).digest('hex');

async function setup(enabled = true) {
  const sent: string[] = [];
  h = await makeHarness({
    chat: { enabled, session: 'ccgram', window: 'JobApplier', send: async (t) => { sent.push(t); } },
  });
  const { cookie } = await h.login();
  const sess = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body);
  const post = (path: string, body: unknown, cookieHdr = cookie, csrf = sess.csrf) =>
    h!.call('POST', path, {
      headers: {
        cookie: cookieHdr, 'x-csrf-token': csrf, origin: `http://127.0.0.1:${h!.port}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  return { sent, cookie, csrf: sess.csrf as string, post };
}

describe('validateChatText', () => {
  it('accepts plain text and bare status commands', () => {
    expect(validateChatText('hello there')).toEqual({ ok: true, text: 'hello there' });
    expect(validateChatText('/limits').ok).toBe(true);
    expect([...STATUS_COMMANDS]).toEqual(['limits', 'working', 'health']);
  });
  it('rejects bad input', () => {
    for (const t of ['!ls', '#x', '&y', 'a\nb', 'a\tb', 'x'.repeat(2001), '/login-as-admin', '/limits now', '   ', '', 5, null]) {
      expect(validateChatText(t).ok, String(t)).toBe(false);
    }
  });
});

describe('prepareSend / confirmSend', () => {
  it('single use, text and session bound, expires', async () => {
    h = await makeHarness();
    const t0 = new Date(START);
    const p = prepareSend(h.auth, 'sessA', 'hi', t0);
    expect(p.expiresInSec).toBe(60);
    expect(confirmSend(h.auth, 'sessB', p.token, 'hi', t0)).toEqual({ ok: false, reason: 'session' });
    expect(confirmSend(h.auth, 'sessA', 'nope', 'hi', t0)).toEqual({ ok: false, reason: 'unknown' });
    expect(confirmSend(h.auth, 'sessA', p.token, 'hi', t0)).toEqual({ ok: true });
    expect(confirmSend(h.auth, 'sessA', p.token, 'hi', t0)).toEqual({ ok: false, reason: 'used' });
    const p2 = prepareSend(h.auth, 'sessA', 'hi', t0);
    expect(confirmSend(h.auth, 'sessA', p2.token, 'other', t0)).toEqual({ ok: false, reason: 'mismatch' });
    const p3 = prepareSend(h.auth, 'sessA', 'hi', t0);
    expect(confirmSend(h.auth, 'sessA', p3.token, 'hi', new Date(START + 61_000))).toEqual({ ok: false, reason: 'expired' });
    const rows = h.auth.prepare('SELECT * FROM chat_pending').all();
    expect(JSON.stringify(rows)).not.toContain(p.token);
  });
});

describe('chat endpoints', () => {
  it('prepare then confirm sends once with the exact text', async () => {
    const s = await setup();
    const p = await s.post('/api/send/prepare', { text: 'run the thing' });
    expect(p.status).toBe(200);
    const pj = JSON.parse(p.body);
    expect(pj.preview).toBe('run the thing');
    const c = await s.post('/api/send/confirm', { token: pj.token, text: 'run the thing' });
    expect(c.status).toBe(200);
    expect(s.sent).toEqual(['run the thing']);
    h!.clock.t += 3000;
    const again = await s.post('/api/send/confirm', { token: pj.token, text: 'run the thing' });
    expect(again.status).toBe(409);
    expect(s.sent.length).toBe(1);
  });

  it('mismatched text does not send', async () => {
    const s = await setup();
    const pj = JSON.parse((await s.post('/api/send/prepare', { text: 'one' })).body);
    const c = await s.post('/api/send/confirm', { token: pj.token, text: 'two' });
    expect(c.status).toBe(409);
    expect(s.sent).toEqual([]);
  });

  it('expired token', async () => {
    const s = await setup();
    const pj = JSON.parse((await s.post('/api/send/prepare', { text: 'one' })).body);
    h!.clock.t += 61_000;
    const c = await s.post('/api/send/confirm', { token: pj.token, text: 'one' });
    expect(c.status).toBe(409);
    expect(JSON.parse(c.body).error).toBe('expired');
    expect(s.sent).toEqual([]);
  });

  it('another session cannot confirm', async () => {
    const s = await setup();
    const other = await h!.login();
    const sess2 = JSON.parse((await h!.call('GET', '/api/session', { headers: { cookie: other.cookie } })).body);
    const pj = JSON.parse((await s.post('/api/send/prepare', { text: 'one' })).body);
    const c = await s.post('/api/send/confirm', { token: pj.token, text: 'one' }, other.cookie, sess2.csrf);
    expect(c.status).toBe(409);
    expect(s.sent).toEqual([]);
  });

  it('disabled is 404', async () => {
    const s = await setup(false);
    expect((await s.post('/api/send/prepare', { text: 'x' })).status).toBe(404);
    expect((await s.post('/api/send/confirm', { token: 'a', text: 'x' })).status).toBe(404);
  });

  it('stale sign-in is 401 reauth_required at prepare and confirm, works after refreshAuth', async () => {
    const s = await setup();
    const pj = JSON.parse((await s.post('/api/send/prepare', { text: 'one' })).body);
    h!.clock.t += 20_000;
    h!.auth.prepare('UPDATE sessions SET auth_at = ?').run(new Date(START - 600_000).toISOString());
    const c = await s.post('/api/send/confirm', { token: pj.token, text: 'one' });
    expect(c.status).toBe(401);
    expect(JSON.parse(c.body)).toEqual({ error: 'reauth_required', url: '/auth/login?reauth=1' });
    const p = await s.post('/api/send/prepare', { text: 'one' });
    expect(p.status).toBe(401);
    expect(JSON.parse(p.body)).toEqual({ error: 'reauth_required', url: '/auth/login?reauth=1' });
    const row = h!.auth.prepare('SELECT id_hash FROM sessions').get() as { id_hash: string };
    refreshAuth(h!.auth, row.id_hash, h!.now());
    const p2 = JSON.parse((await s.post('/api/send/prepare', { text: 'one' })).body);
    expect((await s.post('/api/send/confirm', { token: p2.token, text: 'one' })).status).toBe(200);
    expect(s.sent).toEqual(['one']);
  });

  it('invalid text is 400 and audited with a hash only', async () => {
    const s = await setup();
    for (const t of ['!ls', 'a\nb', 'x'.repeat(2001), '/login-as-admin']) {
      const r = await s.post('/api/send/prepare', { text: t });
      expect(r.status, t.slice(0, 20)).toBe(400);
    }
    const rows = h!.auth.prepare("SELECT * FROM audit_log WHERE kind = 'chat_reject'").all() as Record<string, string>[];
    expect(rows.length).toBe(4);
    expect(rows[0].text_hash).toBe(sha('!ls'));
    expect(JSON.stringify(rows)).not.toContain('login-as-admin');
    expect((await s.post('/api/send/prepare', { text: '/limits' })).status).toBe(200);
  });

  it('second send within 2 s is 429', async () => {
    const s = await setup();
    const a = JSON.parse((await s.post('/api/send/prepare', { text: 'a' })).body);
    expect((await s.post('/api/send/confirm', { token: a.token, text: 'a' })).status).toBe(200);
    const b = JSON.parse((await s.post('/api/send/prepare', { text: 'b' })).body);
    expect((await s.post('/api/send/confirm', { token: b.token, text: 'b' })).status).toBe(429);
    expect(s.sent).toEqual(['a']);
    h!.clock.t += 2_500;
    expect((await s.post('/api/send/confirm', { token: b.token, text: 'b' })).status).toBe(200);
    expect(s.sent).toEqual(['a', 'b']);
  });

  it('audit rows hold a hash and no raw text; GET routes never send', async () => {
    const s = await setup();
    const pj = JSON.parse((await s.post('/api/send/prepare', { text: 'secret words here' })).body);
    await s.post('/api/send/confirm', { token: pj.token, text: 'secret words here' });
    const dump = JSON.stringify(h!.auth.prepare('SELECT * FROM audit_log').all());
    expect(dump).not.toContain('secret words');
    expect(dump).toContain(sha('secret words here'));
    expect(JSON.stringify(h!.auth.prepare('SELECT * FROM chat_pending').all())).not.toContain('secret words');
    for (const p of ['/api/send/prepare', '/api/send/confirm', '/api/send']) {
      const r = await h!.call('GET', p, { headers: { cookie: s.cookie } });
      expect([404, 405]).toContain(r.status);
    }
    expect(s.sent).toEqual(['secret words here']);
  });
});
