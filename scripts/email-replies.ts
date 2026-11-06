// Owner commands for the automatic EMAIL replies (EMAIL_AUTO_REPLY=true).
//   npm run email-replies -- list [all|drafted|approved|sending|sent|failed|cancelled]   show replies (default: drafted, approved, sending, failed)
//   npm run email-replies -- show <id>                                                    the full text of one reply
//   npm run email-replies -- skip <id>                                                    cancel a reply before it is sent
//   npm run email-replies -- resolve <id> sent|cancelled                                  repair a stuck "sending" row after checking Gmail Sent
// A reply that passed every gate is approved at once and sent by the mail drip lane; skip stops it before it goes out. Nothing here sends mail.
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { runEmailRepliesCli } from '../src/outreach/emailRepliesCli.js';

const db = openDb(dbPath());
const r = runEmailRepliesCli(db, process.argv.slice(2));
for (const l of r.lines) console.log(l);
db.close();
process.exitCode = r.code;
