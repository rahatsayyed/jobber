// Owner CLI: open any page HEADED in the web profile (the one persistent Chrome profile that scout, applier, search and apply:assist use).
//   npm run browser:open -- <https url>
// Use it to clear a consent or CAPTCHA page on Google, DuckDuckGo, Bing or a job site once by hand: the cookies then stay in the profile
// for the headless tasks. Press Enter in the terminal when done; the session is saved. Nothing you type is read, and no password is stored.
// It never touches the LinkedIn, Naukri or Wellfound sessions.
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHeaded, type HeadedDeps, type HeadedIo } from '../src/webcore/headed.js';

export interface CliDeps { io?: HeadedIo; launcher?: HeadedDeps['launcher']; lockPath?: string; sessionDir?: string; profileDir?: string | null }

const OWN_SESSION_HOSTS = /(^|\.)(linkedin\.com|naukri\.com|wellfound\.com|angel\.co)$/i;

export async function run(argv: string[], deps: CliDeps = {}): Promise<{ code: number; lines: string[] }> {
  if (argv.length !== 1) return { code: 2, lines: ['usage: npm run browser:open -- <https url>'] };
  let u: URL;
  try { u = new URL(argv[0]); } catch { return { code: 2, lines: ['usage: npm run browser:open -- <https url>'] }; }
  if (u.protocol !== 'https:' || u.username || u.password) return { code: 2, lines: ['only an https address without credentials is opened'] };
  if (OWN_SESSION_HOSTS.test(u.hostname)) return { code: 1, lines: ['LinkedIn, Naukri and Wellfound have their own login commands; this profile is for the other sites'] };
  const out: string[] = [];
  const io: HeadedIo = deps.io ?? {
    log: (l) => console.log(l),
    ask: (q) => new Promise((resolve) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, () => { rl.close(); resolve(''); }); }),
  };
  const r = await runHeaded(u.href, { io: { ask: io.ask, log: (l) => { out.push(l); io.log(l); } }, launcher: deps.launcher, lockPath: deps.lockPath, sessionDir: deps.sessionDir, profileDir: deps.profileDir });
  if (!r.ok) return { code: 1, lines: [...out, `not saved: ${r.reason}`] };
  return { code: 0, lines: [...out, `saved the browser state for ${r.host} (${r.cookies} cookies${r.profile ? ', in the browser profile' : ', in the per-host session file'})`] };
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(process.argv.slice(2)).then((r) => { console.log(r.lines[r.lines.length - 1]); process.exit(r.code); }, () => { console.error('browser:open failed'); process.exit(1); });
}
