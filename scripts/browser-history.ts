// Owner CLI: read-only view of the web profile's OWN Chrome history (secrets/browser-profile/Default/History).
//   npm run browser:history -- [--host example.com] [--limit 50]
// Chrome keeps that file locked while it runs, so it is copied to a temp directory first and the copy is read. Nothing is written to
// data.sqlite and nothing in the profile is changed. Newest visit first: host, last visit, visit count, title, address (query string
// removed: it can carry tokens).
import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { DEFAULT_PROFILE_DIR } from '../src/webcore/profile.js';
import { cleanUntrusted } from '../src/manual/report.js';

export interface HistoryRow { host: string; lastVisit: string; visits: number; title: string; url: string }

const WEBKIT_EPOCH_OFFSET_MS = 11_644_473_600_000;
export const chromeTimeToIso = (t: number): string => new Date(t / 1000 - WEBKIT_EPOCH_OFFSET_MS).toISOString();

export function readHistory(profileDir: string, opts: { host?: string; limit?: number } = {}): { ok: true; rows: HistoryRow[] } | { ok: false; reason: string } {
  const src = path.join(profileDir, 'Default', 'History');
  if (!existsSync(src)) return { ok: false, reason: `no browser profile history yet (${src} is missing); it appears after the first web task or npm run browser:open` };
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'jobber-history-'));
  try {
    const copy = path.join(tmp, 'History');
    copyFileSync(src, copy);
    for (const ext of ['-wal', '-journal']) if (existsSync(src + ext)) copyFileSync(src + ext, copy + ext);
    const db = new Database(copy, { readonly: true, fileMustExist: true });
    try {
      const limit = Math.min(1000, Math.max(1, opts.limit ?? 50));
      const want = opts.host?.toLowerCase().replace(/^www\./, '');
      const raw = db.prepare('SELECT url, title, visit_count, last_visit_time FROM urls ORDER BY last_visit_time DESC LIMIT ?').all(want ? 20000 : limit) as
        { url: string; title: string | null; visit_count: number; last_visit_time: number }[];
      const rows: HistoryRow[] = [];
      for (const r of raw) {
        let host = '';
        let clean = r.url;
        try { const u = new URL(r.url); host = u.hostname.toLowerCase(); clean = `${u.origin}${u.pathname}`; } catch { /* keep raw */ }
        if (want && host !== want && !host.endsWith(`.${want}`)) continue;
        rows.push({ host, lastVisit: chromeTimeToIso(r.last_visit_time), visits: r.visit_count, title: cleanUntrusted(r.title ?? '', 80), url: cleanUntrusted(clean, 160) });
        if (rows.length >= limit) break;
      }
      return { ok: true, rows };
    } finally {
      db.close();
    }
  } catch {
    return { ok: false, reason: 'the history file could not be read (copy or query failed)' };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function run(argv: string[], profileDir: string = DEFAULT_PROFILE_DIR): { code: number; lines: string[] } {
  let host: string | undefined;
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--host' && argv[i + 1]) host = argv[++i];
    else if (argv[i] === '--limit' && /^\d+$/.test(argv[i + 1] ?? '')) limit = Number(argv[++i]);
    else return { code: 2, lines: ['usage: npm run browser:history -- [--host example.com] [--limit 50]'] };
  }
  const r = readHistory(profileDir, { host, limit });
  if (!r.ok) return { code: 1, lines: [r.reason] };
  if (!r.rows.length) return { code: 0, lines: ['no history rows'] };
  return { code: 0, lines: r.rows.map((x) => `${x.lastVisit}  x${x.visits}  ${x.host}  ${x.title ? `"${x.title}"  ` : ''}${x.url}`) };
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = run(process.argv.slice(2));
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
