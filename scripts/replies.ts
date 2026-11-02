// Owner commands for the LinkedIn reply drafts that the inbox read stores for plain requests (a resume, a simple question).
//   npm run replies -- list [all|drafted|approved|sent|failed|skipped]   show drafts (default: drafted, approved, failed)
//   npm run replies -- approve <id>                                      the LinkedIn drip lane may send this draft
//   npm run replies -- skip <id>                                         never send it
// Approve and skip only change the status. A draft is never sent before you approve it; the drip lane sends it (kind reply, no cadence change).
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { runRepliesCli } from '../src/outreach/replyDraftsCli.js';

const db = openDb(dbPath());
const r = runRepliesCli(db, process.argv.slice(2), new Date());
for (const l of r.lines) console.log(l);
db.close();
process.exitCode = r.code;
