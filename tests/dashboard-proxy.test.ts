import { afterEach, describe, expect, it, vi } from 'vitest';
import { proxyDashboardRequest } from '../apps/dashboard/src/lib/dashboard-proxy.js';

const originalFetch = global.fetch;
const originalOrigin = process.env.JOBBER_API_ORIGIN;

afterEach(() => {
  global.fetch = originalFetch;
  if (originalOrigin === undefined) delete process.env.JOBBER_API_ORIGIN;
  else process.env.JOBBER_API_ORIGIN = originalOrigin;
});

describe('Next dashboard API proxy', () => {
  it('does not add a forwarded header to a direct loopback token login', async () => {
    process.env.JOBBER_API_ORIGIN = 'http://127.0.0.1:8788';
    let headers: Headers | undefined;
    global.fetch = vi.fn(async (_url, init) => {
      headers = new Headers(init?.headers);
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;

    const response = await proxyDashboardRequest(new Request('http://127.0.0.1:8787/auth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"token":"x"}',
    }), ['auth', 'token']);

    expect(response.status).toBe(200);
    expect(headers?.get('x-forwarded-proto')).toBeNull();
    expect(headers?.get('origin')).toBe('http://127.0.0.1:8788');
  });

  it('passes a PDF download through with its content type and attachment name', async () => {
    process.env.JOBBER_API_ORIGIN = 'http://127.0.0.1:8788';
    global.fetch = vi.fn(async () => new Response('%PDF-1.4', {
      status: 200,
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="Rahat-Sayyed-Resume.pdf"', 'X-Secret': 'no' },
    })) as typeof fetch;
    const response = await proxyDashboardRequest(new Request('http://127.0.0.1:8787/api/manual-apply/3/resume'), ['api', 'manual-apply', '3', 'resume']);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toBe('attachment; filename="Rahat-Sayyed-Resume.pdf"');
    expect(response.headers.get('x-secret')).toBeNull();
    expect(await response.text()).toBe('%PDF-1.4');
  });

  it('forwards the HTTPS signal only when the public listener received HTTPS', async () => {
    process.env.JOBBER_API_ORIGIN = 'http://127.0.0.1:8788';
    let headers: Headers | undefined;
    global.fetch = vi.fn(async (_url, init) => {
      headers = new Headers(init?.headers);
      return new Response('{"ok":true}', { status: 200 });
    }) as typeof fetch;

    await proxyDashboardRequest(new Request('https://jobber.example.test/api/health', {
      headers: { 'x-forwarded-proto': 'https' },
    }), ['api', 'health']);

    expect(headers?.get('x-forwarded-proto')).toBe('https');
  });
});
