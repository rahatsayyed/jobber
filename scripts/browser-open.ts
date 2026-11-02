// Owner CLI: open a page HEADED in one of the project's persistent Chrome profiles.
//   npm run browser:open -- [--profile <web|linkedin-main|naukri|wellfound>] [<https url>]
// --profile web (the default) is the web profile that scout, applier, search and apply:assist use: clear a consent or CAPTCHA page on
// Google, DuckDuckGo, Bing or a job site once by hand; the cookies then stay in the profile for the headless tasks.
// --profile linkedin-main | naukri | wellfound opens that platform's own profile (secrets/browser-profile-<name>/): use it to install
// or configure a browser extension (Bitwarden) once from the Chrome Web Store (the default page). Installed extensions load in the
// unattended headless runs of that platform too.
// Press Enter in the terminal when done. Nothing you type is read, and no password is stored. It refuses while the profile's lock is held.
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHeaded, type HeadedDeps, type HeadedIo } from '../src/webcore/headed.js';
import { runHeadedProfile } from '../src/webcore/headedProfile.js';
import { isPlatformProfileName, extensionIds, platformProfileDir } from '../src/webcore/platformProfile.js';
import { readdirSync } from 'node:fs';

export interface CliDeps { io?: HeadedIo; launcher?: HeadedDeps['launcher']; lockPath?: string; sessionDir?: string; profileDir?: string | null; /** Secrets directory of the platform profiles (tests). */ root?: string }

export const CHROME_WEB_STORE = 'https://chromewebstore.google.com/';
const USAGE = 'usage: npm run browser:open -- [--profile <web|linkedin-main|naukri|wellfound>] [<https url>]';
const OWN_SESSION_HOSTS = /(^|\.)(linkedin\.com|naukri\.com|wellfound\.com|angel\.co)$/i;

/** Pure argument parsing: at most one --profile and at most one URL; anything else is a usage error. */
export function parseArgs(argv: string[]): { profile: string; url: string | null } | null {
  let profile: string | null = null;
  let url: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile' || a.startsWith('--profile=')) {
      if (profile !== null) return null;
      const v = a === '--profile' ? argv[++i] : a.slice('--profile='.length);
      if (!v) return null;
      profile = v;
    } else if (a.startsWith('-')) return null;
    else { if (url !== null) return null; url = a; }
  }
  return { profile: profile ?? 'web', url };
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<{ code: number; lines: string[] }> {
  const parsed = parseArgs(argv);
  if (!parsed) return { code: 2, lines: [USAGE] };
  if (parsed.profile !== 'web' && !isPlatformProfileName(parsed.profile)) return { code: 2, lines: [`unknown profile "${parsed.profile.slice(0, 40)}"; choose web, linkedin-main, naukri or wellfound`] };
  let u: URL;
  try { u = new URL(parsed.url ?? CHROME_WEB_STORE); } catch { return { code: 2, lines: [USAGE] }; }
  if (u.protocol !== 'https:' || u.username || u.password) return { code: 2, lines: ['only an https address without credentials is opened'] };
  const out: string[] = [];
  const io: HeadedIo = deps.io ?? {
    log: (l) => console.log(l),
    ask: (q) => new Promise((resolve) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, () => { rl.close(); resolve(''); }); }),
  };
  const wrapped: HeadedIo = { ask: io.ask, log: (l) => { out.push(l); io.log(l); } };
  if (parsed.profile !== 'web') {
    const name = parsed.profile as Parameters<typeof platformProfileDir>[0];
    const r = await runHeadedProfile(u.href, { name, io: wrapped, launcher: deps.launcher, root: deps.root });
    if (!r.ok) return { code: 1, lines: [...out, `not opened: ${r.reason}`] };
    const ids = extensionIds((p) => readdirSync(p), r.profileDir);
    return { code: 0, lines: [...out, `closed the ${name} profile (${ids.length} extension${ids.length === 1 ? '' : 's'} installed)`] };
  }
  if (OWN_SESSION_HOSTS.test(u.hostname)) return { code: 1, lines: ['LinkedIn, Naukri and Wellfound have their own login commands; the web profile is for the other sites (use --profile linkedin-main, naukri or wellfound to open their own profile)'] };
  const r = await runHeaded(u.href, { io: wrapped, launcher: deps.launcher, lockPath: deps.lockPath, sessionDir: deps.sessionDir, profileDir: deps.profileDir });
  if (!r.ok) return { code: 1, lines: [...out, `not saved: ${r.reason}`] };
  return { code: 0, lines: [...out, `saved the browser state for ${r.host} (${r.cookies} cookies${r.profile ? ', in the browser profile' : ', in the per-host session file'})`] };
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(process.argv.slice(2)).then((r) => { console.log(r.lines[r.lines.length - 1]); process.exit(r.code); }, () => { console.error('browser:open failed'); process.exit(1); });
}
