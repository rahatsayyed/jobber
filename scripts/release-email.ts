// Owner repair for an email that never left the machine (for example a hook denial marked it failed).
//   npm run mail:release -- <job_id>            same-day failure: gives today's send_email slot back and makes the rows sendable
//   npm run mail:release -- <job_id> --reset    failure of any age: makes the rows sendable, counter untouched
//   npm run mail:release -- --quarantine        lists the cold rows the mail drip held after a run that ended without a recorded send
//   npm run mail:release -- --quarantine <id>   releases ONE held row (outreach_queue id) so the drip may pick it again; check Gmail Sent first
// Sent rows are never touched. Nothing here sends an email; the quarantine release only changes state and never touches the send counter.
import { openDb, releaseEmailSend, resetFailedEmail } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { listDripQuarantine, releaseDripQuarantine } from '../src/scheduler/mailDrip.js';

const first = process.argv[2];
if (first === '--quarantine') {
  const db = openDb(dbPath());
  const arg = process.argv[3];
  if (arg === undefined) {
    console.log(JSON.stringify(listDripQuarantine(db)));
  } else if (/^\d+$/.test(arg)) {
    console.log(JSON.stringify(releaseDripQuarantine(db, Number(arg), new Date())));
  } else {
    console.error('usage: npm run mail:release -- --quarantine [<row_id>]');
    process.exit(2);
  }
} else {
  if (!first || first.startsWith('--')) {
    console.error('usage: npm run mail:release -- <job_id> [--reset] | --quarantine [<row_id>]');
    process.exit(2);
  }
  const db = openDb(dbPath());
  console.log(JSON.stringify(process.argv.includes('--reset') ? resetFailedEmail(db, first) : releaseEmailSend(db, first)));
}
