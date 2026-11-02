// Read-only: is the saved Naukri session still logged in? Prints one line, exit 0 on OK, 1 on FAIL.
//   npm run naukri:check
// It tests the session the way the platform tools use it: the shared browser host profile (topped up from the
// Naukri state file) when the host is on, else the platform's own profile, else the state file alone.
// A second line says which profile was tested.
import { fileURLToPath } from 'node:url';
import * as check from '../src/sessions/check.js';
import { checkNaukriSession, readOnlyHalt, type CheckDeps } from '../src/sessions/check.js';

export async function main(deps: CheckDeps & { log?: (line: string) => void } = {}): Promise<number> {
  const { log = console.log, ...rest } = deps;
  const r = await checkNaukriSession({ halted: readOnlyHalt('naukri'), ...rest });
  log(r.line);
  log(`profile tested: ${check.lastTestedProfile}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((c) => process.exit(c));
}
