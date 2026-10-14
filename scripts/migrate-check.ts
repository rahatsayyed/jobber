// Opens (and so migrates) the database named by JOBAPPLIER_DB, which must be a copy.
// Prints only an error message, never rows.
import { basename, resolve } from 'node:path';
import { openDb } from '../src/db.js';

const root = resolve(import.meta.dirname, '..');
const raw = process.env.JOBAPPLIER_DB;
if (!raw || !raw.trim()) {
  console.error('migrate-check: JOBAPPLIER_DB is not set; refusing to touch the live database');
  process.exit(1);
}
const target = raw.trim();
if (basename(target) === 'data.sqlite' || resolve(target) === resolve(root, 'data.sqlite')) {
  console.error('migrate-check: JOBAPPLIER_DB points at the live data.sqlite; refusing');
  process.exit(1);
}
try {
  const db = openDb(target);
  db.close();
  process.exit(0);
} catch (e) {
  console.error(`migrate-check failed: ${e instanceof Error ? e.message : 'unknown error'}`);
  process.exit(1);
}
