// tests/dash-docs.test.ts
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DOC = 'docs/dashboard-exposure.md';
const text = existsSync(DOC) ? readFileSync(DOC, 'utf8') : '';
const envExample = readFileSync('.env.example', 'utf8');

describe('dashboard exposure doc', () => {
  it('exists and names the four options', () => {
    expect(existsSync(DOC)).toBe(true);
    for (const w of ['Tailscale', 'Cloudflare Tunnel', 'Reverse proxy', 'SSH tunnel']) {
      expect(text).toContain(w);
    }
  });
  it('mentions the host and proxy keys', () => {
    expect(text).toContain('WEB_ALLOWED_HOSTS');
    expect(text).toContain('WEB_TRUST_PROXY');
  });
  it('only warns against the any-address', () => {
    const any = ['0', '0', '0', '0'].join('.');
    for (const line of text.split('\n').filter((l) => l.includes(any))) {
      expect(/never|do not/i.test(line)).toBe(true);
    }
  });
  it('names only npm scripts that exist', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts as Record<string, string>;
    const names = [...text.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(scripts[n]).toBeTruthy();
  });
  it('only names WEB_ env keys present in .env.example', () => {
    for (const m of text.matchAll(/\b(WEB_[A-Z_]+)\b/g)) expect(envExample).toContain(m[1]);
  });
});
