// The headed browser of the platform login commands (linkedin:login, naukri:login, wellfound:login). First choice: the shared browser
// host switched to a window on the ONE shared profile (secrets/browser-profile/), so the login lands in the same cookies and history
// the headless tasks use; closing it closes the tab and stops the host, and the next task starts it headless again. Extensions are
// allowed (whatever the owner installed in the profile loads). When the host is off, busy or unreachable: the platform's old profile
// (secrets/browser-profile-<name>/, mode 0700), and a launcher that cannot open a profile (fakes, old builds) falls back to a plain
// headed browser. The login command still writes the platform state file. This file launches through src/webcore/launch.ts only.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPersistentChrome, launchRealChrome, persistentSupported, type LiBrowser, type LiLauncher } from './launch.js';
import { prepareProfileDir } from './profile.js';
import { resolveHost, type HostAttach } from './hostClient.js';

const SECRETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'secrets');

export function loginProfileDir(name: string, root: string = SECRETS): string {
  return path.join(root, `browser-profile-${name.replace(/[^a-z0-9-]/gi, '')}`);
}

export async function launchLoginBrowser(opts: { name: string; launcher?: LiLauncher; root?: string; host?: HostAttach | null }): Promise<LiBrowser> {
  const shared = resolveHost(opts.host, process.env, opts.launcher);
  if (shared) {
    const r = await shared({ headed: true });
    if (r.ok) return r.browser;
    if (r.code === 'busy' || r.code === 'busy_headed') throw new Error(`session_locked: ${r.reason}`);
    if (r.code === 'halted') throw new Error('halted: the kill switch is on');
  }
  const dir = loginProfileDir(opts.name, opts.root);
  if (persistentSupported(opts.launcher) && prepareProfileDir(dir).ok) {
    try {
      const pc = await launchPersistentChrome({ userDataDir: dir, headed: true, launcher: opts.launcher });
      return { newContext: async () => pc, close: () => pc.close() };
    } catch {
      /* fall through to a plain headed browser */
    }
  }
  return launchRealChrome({ headed: true, launcher: opts.launcher });
}
