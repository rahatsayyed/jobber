import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd(), 'apps', 'dashboard', 'src');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

describe('Next.js dashboard frontend', () => {
  it('ships the App Router surface and API proxy', () => {
    for (const path of [
      'app/page.tsx', 'app/[section]/page.tsx', 'app/login/page.tsx',
      'app/api/[...path]/route.ts', 'app/auth/[...path]/route.ts',
      'lib/dashboard-proxy.ts', 'components/dashboard/dashboard-shell.tsx',
    ]) expect(existsSync(join(ROOT, path)), path).toBe(true);
  });

  it('does not reintroduce executable markup sinks', () => {
    const sources = [
      'components/dashboard/dashboard-shell.tsx', 'components/dashboard/login-panel.tsx',
      'lib/dashboard-api.ts', 'lib/dashboard-proxy.ts',
    ].map(read);
    for (const source of sources) {
      expect(source).not.toMatch(/dangerouslySetInnerHTML|document\.write|\beval\(|new Function/);
    }
  });

  it('keeps the access token transient and uses the authenticated proxy', () => {
    const login = read('components/dashboard/login-panel.tsx');
    expect(login).toContain('fetch("/auth/token"');
    expect(login).not.toMatch(/localStorage|sessionStorage|document\.cookie/);
    const proxy = read('lib/dashboard-proxy.ts');
    expect(proxy).toContain('JOBBER_API_ORIGIN');
    expect(proxy).toContain('getSetCookie');
    expect(read('../next.config.ts')).toContain('Content-Security-Policy');
  });
});
