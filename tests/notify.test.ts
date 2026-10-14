import { describe, it, expect, vi } from 'vitest';
import { telegramNotifier, consoleNotifier } from '../src/platform/notify.js';

const TOKEN = '123456:SECRET-token_abc';
const env = { TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '42, 99' } as NodeJS.ProcessEnv;

describe('telegramNotifier', () => {
  it('posts to the first allowed user without parse_mode', async () => {
    const f = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const r = await telegramNotifier(env, f as unknown as typeof fetch).send('hello');
    expect(r.ok).toBe(true);
    expect(r.detail).not.toContain(TOKEN);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain(TOKEN);
    expect(url).toContain('sendMessage');
    const body = String(init.body);
    expect(body).not.toContain('parse_mode');
    expect(body).toContain('42');
    expect(body).toContain('hello');
  });

  it('is not configured without token or users', async () => {
    const f = vi.fn();
    for (const e of [{ ALLOWED_USERS: '1' }, { TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: ' ' }, {}]) {
      const r = await telegramNotifier(e as NodeJS.ProcessEnv, f as unknown as typeof fetch).send('x');
      expect(r).toEqual({ ok: false, detail: 'telegram not configured' });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('network errors never throw and never leak the token', async () => {
    const f = vi.fn(async () => { throw new Error(`connect failed for https://api.telegram.org/bot${TOKEN}/sendMessage`); });
    const r = await telegramNotifier(env, f as unknown as typeof fetch).send('x');
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain(TOKEN);
  });

  it('http errors report ok false without the token', async () => {
    const f = vi.fn(async () => new Response(`bad ${TOKEN}`, { status: 401 }));
    const r = await telegramNotifier(env, f as unknown as typeof fetch).send('x');
    expect(r.ok).toBe(false);
    expect(r.detail).not.toContain(TOKEN);
  });
});

describe('consoleNotifier', () => {
  it('prints and reports ok', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await consoleNotifier.send('hi');
    expect(r.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith('hi');
    spy.mockRestore();
  });
});
