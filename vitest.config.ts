import { defineConfig } from 'vitest/config';

// .superpowers/ holds git-ignored scratch (cloned third-party repos, eval harness, SDD workspaces).
// Their test files must never be collected or executed by `npm test`.
// JOBAPPLIER_DB (read by src/dbPath.ts) points every module-level openDb at a private in-memory database, so a test run
// can never open or migrate the real data.sqlite. In-memory (not a shared temp file) so parallel workers never contend on one file.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '.superpowers/**', 'renderer/automation/**'],
    // JOBBER_DRY_RUN=true is the safety net for any test that reads process.env by default: nothing can send for real.
    env: { JOBAPPLIER_DB: ':memory:', JOBAPPLIER_USER_DATA: 'user-data.example', JOBBER_DRY_RUN: 'true' },
  },
});
