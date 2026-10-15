import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage } from 'node:http';
import { createWebServer, redactSecrets, startWebServer, STATUS_COMMANDS } from '../src/web/server.js';
import { loadStatic } from '../src/web/page.js';
import { readJson } from '../src/web/router.js';
import { makeHarness, type Harness } from './helpers/webHarness.js';

let h: Harness | null = null;
afterEach(async () => {
  if (h) await h.close();
  h = null;
});

const HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

describe('host and bind', () => {
  it('wrong Host is 421, allowed hosts and loopback pass', async () => {
    h = await makeHarness({ allowedHosts: ['jobber.example.test'] });
    expect((await h.call('GET', '/api/health', { headers: { host: 'evil.example' } })).status).toBe(421);
    expect((await h.call('GET', '/api/health', { headers: { host: `127.0.0.1:${h.port + 1}` } })).status).toBe(421);
    expect((await h.call('GET', '/api/health', { headers: { host: `localhost:${h.port}` } })).status).toBe(200);
    expect((await h.call('GET', '/api/health', { headers: { host: 'jobber.example.test' } })).status).toBe(200);
    expect((await h.call('GET', '/api/health', { headers: { host: 'JOBBER.example.test' } })).status).toBe(200);
  });

  it('refuses a non-loopback bind unless allowRemoteBind', async () => {
    const anyAddr = ['0', '0', '0', '0'].join('.');
    h = await makeHarness();
    const base = {
      port: 0, bind: anyAddr, allowRemoteBind: false, allowedHosts: [], trustProxy: false, auth: h.auth, authMode: 'token' as const,
      oidc: undefined as never, oidcCfg: { redirectUri: 'x', reauthMaxAgeSec: 300 }, data: h.data, cfg: {} as never,
      run: (async () => ({ stdout: '', code: 0 })) as never, sessionsToShow: [],
      chat: { enabled: false, session: 's', window: 'w', send: async () => {} },
    };
    expect(() => createWebServer(base)).toThrow();
    expect(() => createWebServer({ ...base, bind: '10.1.2.3' })).toThrow();
    const ok = createWebServer({ ...base, allowRemoteBind: true });
    ok.close();
    expect(() => createWebServer({ ...base, bind: '::1' })).not.toThrow();
  });

  it('startWebServer listens on the given loopback address', async () => {
    h = await makeHarness();
    const s = await startWebServer({
      port: 0, bind: '127.0.0.1', allowRemoteBind: false, allowedHosts: [], trustProxy: false, auth: h.auth, authMode: 'token' as const,
      oidc: undefined as never, oidcCfg: { redirectUri: 'x', reauthMaxAgeSec: 300 }, data: h.data, cfg: {} as never,
      run: (async () => ({ stdout: '', code: 0 })) as never, sessionsToShow: [],
      chat: { enabled: false, session: 's', window: 'w', send: async () => {} },
    });
    expect((s.address() as AddressInfo).address).toBe('127.0.0.1');
    s.close();
  });
});

describe('headers and methods', () => {
  it('security headers on 200, 401, 404, 405 and 421, never Access-Control-*', async () => {
    h = await makeHarness();
    const rs = [
      await h.call('GET', '/'),
      await h.call('GET', '/api/status'),
      await h.call('GET', '/nope'),
      await h.call('POST', '/'),
      await h.call('GET', '/api/health', { headers: { host: 'evil.example' } }),
    ];
    expect(rs.map((r) => r.status)).toEqual([200, 401, 404, 405, 421]);
    for (const r of rs) {
      for (const [k, v] of Object.entries(HEADERS)) expect(r.headers[k], k).toBe(v);
      expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
      expect(r.headers['strict-transport-security']).toBeUndefined();
    }
  });

  it('HSTS appears only when secure', async () => {
    h = await makeHarness({ trustProxy: true });
    const r = await h.call('GET', '/api/health', { headers: { 'x-forwarded-proto': 'https' } });
    expect(r.headers['strict-transport-security']).toBe('max-age=31536000');
    expect((await h.call('GET', '/api/health')).headers['strict-transport-security']).toBeUndefined();
  });

  it('OPTIONS is 405 and PUT, DELETE, HEAD are not served', async () => {
    h = await makeHarness();
    expect((await h.call('OPTIONS', '/api/jobs', { headers: { origin: 'http://evil.example' } })).status).toBe(405);
    expect((await h.call('OPTIONS', '/')).status).toBe(405);
    expect((await h.call('PUT', '/api/jobs')).status).toBe(405);
    expect((await h.call('DELETE', '/api/jobs')).status).toBe(405);
  });

  it('health leaks nothing and the shell is served without a session', async () => {
    h = await makeHarness();
    const health = await h.call('GET', '/api/health');
    expect(JSON.parse(health.body)).toEqual({ ok: true });
    const shell = await h.call('GET', '/');
    expect(shell.status).toBe(200);
    expect(shell.headers['content-type']).toContain('text/html');
    expect(shell.body).toContain('<div id="app">');
    expect(shell.body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(shell.body).not.toMatch(/\sstyle=|<style/i);
  });

  it('path traversal and unlisted files are 404', async () => {
    h = await makeHarness();
    for (const p of ['/../.env', '/%2e%2e/secrets/x', '/..%2f.env', '/views/../../.env', '/app.js/../../x', '/package.json', '/index.html', '/views/nothing.js']) {
      const r = await h.call('GET', p);
      expect(r.status, p).toBe(404);
    }
  });

  it('known api path with the wrong method is 405 when authenticated', async () => {
    h = await makeHarness();
    const { cookie } = await h.login();
    expect((await h.call('POST', '/api/jobs', { headers: { cookie } })).status).toBe(405);
    expect((await h.call('GET', '/api/logout', { headers: { cookie } })).status).toBe(405);
    expect((await h.call('GET', '/api/nothing', { headers: { cookie } })).status).toBe(404);
  });

  it('clientError responses carry the security headers', async () => {
    h = await makeHarness();
    const raw = await new Promise<string>((resolve, reject) => {
      const c = net.connect(h!.port, '127.0.0.1', () => c.write('GARBAGE\r\n\r\n'));
      let buf = '';
      c.on('data', (d) => (buf += d));
      c.on('close', () => resolve(buf));
      c.on('error', reject);
    });
    expect(raw).toContain('400');
    expect(raw.toLowerCase()).toContain('content-security-policy');
    expect(raw.toLowerCase()).toContain('x-frame-options: deny');
    expect(raw.toLowerCase()).toContain('x-content-type-options: nosniff');
  });
});

describe('static files', () => {
  it('loadStatic reads only allowlisted extensions once and maps index to /', () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-static-'));
    mkdirSync(join(dir, 'views'));
    writeFileSync(join(dir, 'index.html'), '<html></html>');
    writeFileSync(join(dir, 'app.js'), 'x');
    writeFileSync(join(dir, 'style.css'), 'x');
    writeFileSync(join(dir, 'views', 'jobs.js'), 'x');
    writeFileSync(join(dir, 'secret.env'), 'TOKEN=1');
    writeFileSync(join(dir, 'notes.json'), '{}');
    const m = loadStatic(dir);
    expect([...m.keys()].sort()).toEqual(['/', '/app.js', '/style.css', '/views/jobs.js']);
    expect(m.get('/')!.type).toContain('text/html');
    expect(m.get('/app.js')!.type).toContain('javascript');
    expect(m.get('/style.css')!.type).toContain('text/css');
    expect(loadStatic(join(dir, 'missing')).size).toBe(0);
  });

  it('the shipped static files contain no innerHTML or inline handlers', () => {
    const root = join(__dirname, '..', 'src', 'web', 'static');
    const walk = (d: string): string[] =>
      readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    for (const f of walk(root)) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(/);
      expect(text, f).not.toMatch(/\son[a-z]+\s*=/i);
    }
  });
});

describe('readJson', () => {
  const mk = (body: string, headers: Record<string, string>) => {
    const r = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
    r.headers = headers;
    return r;
  };
  it('parses json, 415 for another type, 413 over the cap, 400 for bad json', async () => {
    expect(await readJson(mk('{"a":1}', { 'content-type': 'application/json' }), 100)).toEqual({ a: 1 });
    await expect(readJson(mk('a=1', { 'content-type': 'text/plain' }), 100)).rejects.toMatchObject({ status: 415 });
    await expect(readJson(mk('{"a":"' + 'x'.repeat(200) + '"}', { 'content-type': 'application/json' }), 100)).rejects.toMatchObject({ status: 413 });
    await expect(readJson(mk('{', { 'content-type': 'application/json' }), 100)).rejects.toMatchObject({ status: 400 });
  });
});

describe('redactSecrets', () => {
  it('replaces secret shapes and web secret lines', () => {
    const out = redactSecrets('a ghp_abcdefghijklmnopqrstuvwx b\nWEB_OIDC_CLIENT_SECRET=1\nAKIAABCDEFGHIJKLMNOP');
    expect(out).toBe('a [redacted] b\n[redacted]\n[redacted]');
  });
  it('handles repeated matches (global regex state)', () => {
    const s = 'sk-abcdefghijklmnopqrstuv sk-abcdefghijklmnopqrstuv';
    expect(redactSecrets(s)).toBe('[redacted] [redacted]');
    expect(redactSecrets(s)).toBe('[redacted] [redacted]');
  });
  it('handles a long secret split across two lines', () => {
    const out = redactSecrets('x sk-abcdefghijklmnop\nqrstuvwxyz0123 y');
    expect(out).not.toContain('qrstuv');
    expect(out).not.toContain('abcdefgh');
  });
  it('STATUS_COMMANDS is unchanged for Task 10', () => {
    expect([...STATUS_COMMANDS]).toEqual(['limits', 'working', 'health']);
  });
});

describe('pane redaction across the cut', () => {
  it('redacts the whole capture before slicing to 40 lines', async () => {
    h = await makeHarness();
    const { cookie } = await h.login();
    const secret = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWX';
    const lines = Array.from({ length: 80 }, (_, i) => 'row' + i);
    lines[39] = 'pre ' + secret.slice(0, 20);
    lines[40] = secret.slice(20) + ' post';
    h.paneText.value = lines.join('\n');
    const r = await h.call('GET', '/api/pane?window=JobApplier', { headers: { cookie } });
    const text = JSON.parse(r.body).text as string;
    expect(text).not.toContain('QRSTUVWX');
    expect(text.split('\n').length).toBe(40);
  });
});
