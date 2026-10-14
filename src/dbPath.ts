/** The SQLite file every db-opening module uses: JOBAPPLIER_DB when set and non-empty, else the real 'data.sqlite'.
 *  vitest.config.ts points JOBAPPLIER_DB at an in-memory database so a test run can never open the real file. */
export function dbPath(): string {
  const p = process.env.JOBAPPLIER_DB;
  return p && p.trim() ? p : 'data.sqlite';
}
