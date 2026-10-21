// Owner repair for an email that never left the machine (for example a hook denial marked it failed).
//   npm run mail:release -- <job_id>            same-day failure: gives today's send_email slot back and makes the rows sendable
//   npm run mail:release -- <job_id> --reset    failure of any age: makes the rows sendable, counter untouched
// Sent rows are never touched.
import { openDb, releaseEmailSend, resetFailedEmail } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';

const jobId = process.argv[2];
if (!jobId || jobId.startsWith('--')) {
  console.error('usage: npm run mail:release -- <job_id> [--reset]');
  process.exit(2);
}
const db = openDb(dbPath());
console.log(JSON.stringify(process.argv.includes('--reset') ? resetFailedEmail(db, jobId) : releaseEmailSend(db, jobId)));
