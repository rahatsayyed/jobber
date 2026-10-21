// Owner repair: undo a send that never left the machine (hook denial). Usage: npm run mail:release -- <job_id>
// Gives today's send_email slot back and makes the job's failed email rows sendable again. Never touches sent rows.
import { openDb, releaseEmailSend } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';

const jobId = process.argv[2];
if (!jobId) {
  console.error('usage: npm run mail:release -- <job_id>');
  process.exit(2);
}
const db = openDb(dbPath());
console.log(JSON.stringify(releaseEmailSend(db, jobId)));
