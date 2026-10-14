// Read-only doctor checks for the LinkedIn browser: real Google Chrome and patchright. Neither launches a browser.
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Check } from '../platform/doctor.js';

export interface ChromeCheckDeps {
  exists?: (p: string) => boolean;
  importPatchright?: () => Promise<unknown>;
  platform?: NodeJS.Platform;
}

const MAC_CHROME = path.join(path.sep, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome');
const LINUX_VENDOR = path.join(path.sep, 'opt', 'google', 'chrome', 'chrome');
const LINUX_NAMES = ['google-chrome', 'google-chrome-stable'];

export function linkedinBrowserChecks(deps: ChromeCheckDeps = {}): Check[] {
  const exists = deps.exists ?? ((p: string) => existsSync(p));
  const importPatchright = deps.importPatchright ?? (() => import('patchright'));
  const platform = deps.platform ?? process.platform;
  return [
    {
      id: 'linkedin.chrome-installed',
      title: 'LinkedIn browser: Google Chrome installed',
      async run(ctx) {
        let found = false;
        if (platform === 'darwin') found = exists(MAC_CHROME);
        else {
          found = exists(LINUX_VENDOR);
          if (!found) {
            const dirs = (ctx.env.PATH ?? '').split(path.delimiter).filter(Boolean);
            found = dirs.some((d) => LINUX_NAMES.some((n) => exists(path.join(d, n))));
          }
        }
        return found
          ? { status: 'pass', detail: 'Google Chrome found' }
          : {
              status: 'fail',
              detail: 'Google Chrome is not installed',
              fix: 'Install Google Chrome (the real browser, not a bundled test browser); the LinkedIn tools only use installed Chrome',
            };
      },
    },
    {
      id: 'linkedin.patchright-importable',
      title: 'LinkedIn browser: patchright importable',
      async run() {
        try {
          await importPatchright();
          return { status: 'pass', detail: 'patchright resolves' };
        } catch {
          return { status: 'fail', detail: 'patchright cannot be imported', fix: 'Run the project dependency install' };
        }
      },
    },
  ];
}
