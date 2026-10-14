// src/web/page.ts
// Static shell loader: reads src/web/static once at start into memory. Nothing is read per request, and only a
// fixed extension allowlist is served, so a stray file in the directory is never exposed.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

export interface StaticFile { type: string; body: Buffer }

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

/** Keys are URL paths: `/` for index.html, `/app.js`, `/views/jobs.js`, ... */
export function loadStatic(dir: string): Map<string, StaticFile> {
  const out = new Map<string, StaticFile>();
  function walk(abs: string, rel: string): void {
    let names: string[];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const name of names) {
      const a = join(abs, name);
      const r = `${rel}/${name}`;
      let st;
      try {
        st = lstatSync(a);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(a, r);
        continue;
      }
      const type = TYPES[extname(name).toLowerCase()];
      if (!st.isFile() || !type) continue;
      const key = r === '/index.html' ? '/' : r;
      out.set(key, { type, body: readFileSync(a) });
    }
  }
  walk(dir, '');
  return out;
}
