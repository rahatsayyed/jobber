import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(process.cwd(), 'src', 'web', 'static');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(ROOT);
const read = (p: string) => readFileSync(p, 'utf8');
const js = files.filter((f) => f.endsWith('.js'));

describe('static frontend lint', () => {
  it('has the expected files', () => {
    for (const n of ['index.html', 'style.css', 'app.js', 'api.js', 'dom.js']) expect(existsSync(join(ROOT, n)), n).toBe(true);
    for (const v of ['login', 'overview', 'jobs', 'people', 'mail', 'outcomes', 'sessions', 'runs', 'config', 'chat', 'audit']) {
      expect(existsSync(join(ROOT, 'views', `${v}.js`)), v).toBe(true);
    }
  });

  it('contains no dangerous sinks', () => {
    const banned = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function',
      'setTimeout("', "setTimeout('", 'javascript:', '.href =', "setAttribute('href'", 'setAttribute("href"'];
    for (const f of files) {
      const t = read(f);
      for (const b of banned) expect(t.includes(b), `${f} contains ${b}`).toBe(false);
    }
  });

  it('index.html is CSP clean and has the shell', () => {
    const h = read(join(ROOT, 'index.html'));
    expect(h).toContain('name="viewport"');
    expect(h).toContain('<div id="app">');
    expect(h).toContain('<script type="module" src="/app.js"></script>');
    expect(h).toContain('<link rel="stylesheet" href="/style.css">');
    for (const m of h.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) expect(m[1].trim()).toBe('');
    expect(/\sstyle\s*=/i.test(h)).toBe(false);
    expect(/\son[a-z]+\s*=/i.test(h)).toBe(false);
  });

  it('every relative import in js resolves to a file', () => {
    for (const f of js) {
      for (const m of read(f).matchAll(/(?:import|export)[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]/g)) {
        const spec = m[1] ?? m[2];
        const target = spec.startsWith('/') ? join(ROOT, spec) : resolve(dirname(f), spec);
        expect(existsSync(target), `${f} imports ${spec}`).toBe(true);
      }
    }
  });

  it('style.css has dark mode and a max-width query, 16px base', () => {
    const c = read(join(ROOT, 'style.css'));
    expect(c).toContain('prefers-color-scheme: dark');
    expect(c).toMatch(/@media[^{]*max-width/);
    expect(c).toContain('16px');
    expect(c).toContain(':focus-visible');
  });

  it('localStorage only holds a theme or last tab, never tokens', () => {
    for (const f of js) {
      for (const line of read(f).split('\n')) {
        if (!/localStorage/.test(line)) continue;
        expect(/theme|lastTab/.test(line), `${f}: ${line}`).toBe(true);
        expect(/csrf|token|cookie|session/i.test(line), `${f}: ${line}`).toBe(false);
      }
    }
  });

  it('dom helper has no href in its attribute allowlist and views never pass href', () => {
    expect(read(join(ROOT, 'dom.js'))).not.toMatch(/['"]href['"]/);
    for (const f of js) expect(/\bhref\s*:/.test(read(f)), f).toBe(false);
  });
});
