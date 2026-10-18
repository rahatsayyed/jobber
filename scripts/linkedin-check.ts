// Read-only: is the saved MAIN LinkedIn session still logged in? Prints one line, exit 0 on OK, 1 on FAIL.
//   npm run linkedin:check
import { fileURLToPath } from 'node:url';
import { checkLinkedinSession, readOnlyHalt, type CheckDeps } from '../src/sessions/check.js';

export async function main(deps: CheckDeps & { log?: (line: string) => void } = {}): Promise<number> {
  const { log = console.log, ...rest } = deps;
  const r = await checkLinkedinSession({ halted: readOnlyHalt('linkedin'), ...rest });
  log(r.line);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((c) => process.exit(c));
}
