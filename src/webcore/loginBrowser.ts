// The headed browser of the platform login commands (linkedin:login, naukri:login, wellfound:login). It opens a persistent Chrome
// profile of that platform (secrets/browser-profile-<name>/, mode 0700) with extensions allowed, so the owner's password manager
// extension (Bitwarden) is there while logging in by hand. The unattended headless runs are unchanged: they keep loading the
// platform's saved state file, which the login command still writes. A launcher that cannot open a profile (fakes, old builds)
// falls back to a plain headed browser. This file launches through src/webcore/launch.ts only.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPersistentChrome, launchRealChrome, persistentSupported, type LiBrowser, type LiLauncher } from './launch.js';
import { prepareProfileDir } from './profile.js';

const SECRETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'secrets');

export function loginProfileDir(name: string, root: string = SECRETS): string {
  return path.join(root, `browser-profile-${name.replace(/[^a-z0-9-]/gi, '')}`);
}

export async function launchLoginBrowser(opts: { name: string; launcher?: LiLauncher; root?: string }): Promise<LiBrowser> {
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
