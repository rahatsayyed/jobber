// Offline audit of config/portals.json, config/platforms.json and config/portals-seed.json (no network, no database).
//   npm run portals:validate [-- --strict] [--json]
// Exit codes: 0 clean (or only warnings), 1 errors (or warnings with --strict).
import { auditPortals } from '../src/sources/portalsAudit.js';

const strict = process.argv.includes('--strict');
const r = auditPortals();
if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
else {
  for (const x of r.findings) console.log(`${x.level === 'error' ? 'ERROR  ' : 'warning'} ${x.where}: ${x.message}`);
  console.log(`${r.errors} error(s), ${r.warnings} warning(s)`);
}
process.exit(r.errors > 0 || (strict && r.warnings > 0) ? 1 : 0);
