// Test helper: a child process that opens the db given as argv[2] and prints the migration marker (used by the concurrent-open test).
import { openDb } from '../../src/db.js';

const db = openDb(process.argv[2]!);
console.log(JSON.stringify({ user_version: db.pragma('user_version', { simple: true }) }));
db.close();
