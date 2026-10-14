// scripts/scheduler-units.ts
// Writes launchd/systemd unit files under <project>/.jobber/units and PRINTS the install
// commands. It never runs them and never writes outside the project root.
import { resolve } from 'node:path';
import { writeUnits } from '../src/scheduler/units.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

try {
  const root = resolve(process.cwd());
  const r = writeUnits({
    projectRoot: root,
    nodePath: arg('--node') ?? process.execPath,
    outDir: arg('--out'),
  });
  console.log(`wrote ${r.plistPath}`);
  console.log(`wrote ${r.servicePath}`);
  console.log('\nInstall (run these yourself, nothing was run):');
  for (const c of r.commands) console.log(c);
} catch (e) {
  console.error(`scheduler-units: ${(e as Error).message}`);
  process.exit(1);
}
