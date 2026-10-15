# Plan 7D: AUTO_UPDATE and backup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per project preference, dispatch subagents with `model: sonnet`.

**Goal:** (1) A conservative, opt-in daily self-update (`AUTO_UPDATE`, default false) that only fast-forwards signed commits, verifies the result (install, migrations on a copy, doctor, tests) and rolls back on any failure, never touching the permission set or the pinned ccgram. (2) A scheduled, encrypted backup of the SQLite database and the user's config and data, with a restore command that verifies before it overwrites anything, a restore drill, and doctor warnings when backup is unconfigured.

**Architecture:** Everything is pure planning functions plus a thin orchestrator that takes injected ports (`Exec` for git, npm and other processes; `fs`; `Clock`; `Rng`; `Notifier`; `LockPort`; `BackupDestination`). No test needs a network, a real git remote, a real `age` binary or a real Telegram bot. Real implementations live in the CLI entry points (`scripts/auto-update.ts`, `scripts/backup.ts`, `scripts/restore.ts`) and are exercised only in the owner checklist. Scheduling (when to call the entry points) belongs to plan 6D's scheduler; this plan provides `--tick` style entry points that are cheap and idempotent.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), vitest, Node `child_process.execFile`/`spawn` (argument arrays only), `better-sqlite3` `.backup()`, system `git`, `tar`, and `age` (encryption), optional `rclone`.

**Spec:** `docs/superpowers/specs/2026-10-14-platform-sessions-dashboard-setup-requirements.md` (sections "Auto-update", "Backup", "Config and data hygiene", "Credentials, `.env` and ccgram" are binding).

**Format reference:** `docs/superpowers/plans/2026-10-14-7a-tmux-ccgram-foundation.md`. Plan 7A's doctor framework (`src/platform/doctor.ts`, `src/platform/checks.ts`) is reused as is.

## Global Constraints

- Test baseline before and after every task: `npx tsc --noEmit` clean; `npx vitest run` has exactly 5 known failures (`tests/renderChecked.test.ts` x4, `tests/resume.test.ts` x1) and no others.
- Subprocesses use `execFile`/`spawn` with an argument array. Never a shell string, never `sh -c`.
- Tests never touch the real repo's git state, real `data.sqlite`, `user-data/`, `secrets/`, `.env`, a real network, or the real `~/.claude`. Use temp dirs under `os.tmpdir()`, in-memory fakes and injected ports. (`vitest.config.ts` already points `JOBAPPLIER_DB` at an in-memory database.)
- No code in this plan reads or prints the content of `user-data/`, `secrets/`, `.env` values, or database rows. Logs and notifications carry file names, counts, hashes and commit subjects only.
- Commit subjects, tags and file paths coming from git are untrusted text (a signed commit can still carry hostile text). They are length-capped, stripped of control characters, and sent to Telegram as plain text (no parse mode), never interpolated into a command.
- The update job never changes `.claude/settings.local.json`, `config/ccgram.pin.json`, or the installed ccgram. It never runs `ccgram` upgrade paths, `uv tool upgrade`, `git merge` without `--ff-only`, `git pull`, `git rebase`, `git push`, `git reset` on anything but its own recorded previous commit, or `--force` anything.
- Imports use `.js` suffixes. Tests live in `tests/*.test.ts`; run one with `npx vitest run <file>`.
- New runtime files (`.update/`, `.backups/`) are gitignored and created mode 700 (dirs) and 600 (files).
- The pre-commit hook (`.githooks/pre-commit`) blocks `secrets/`, `user-data/`, `.ccgram/`, `*.sqlite` and `.env`; do not work around it. Test fixtures must be synthetic and created at run time.
- Do not edit CLAUDE.md in these tasks (project preference: document once it works live). Task 12 lists the documentation to write after the owner checklist passes.

## Review Focus

1. **Fast-forward only, signed only:** no code path may call a git command that can create a merge commit, rewrite history or discard local work. The only destructive command is `git reset --hard <previous commit>` on rollback, after the tree was verified clean and with the previous sha taken from the state file written before the merge (Tasks 3, 5).
2. **Dirty or diverged trees are skipped, never repaired** (Task 3). Local commits not on upstream count as diverged.
3. **Lock:** the update must hold the scheduler run lock from plan 6D for the entire apply and must not start while any hunt or wake holds it (Task 6). The lock port is an assumption on plan 6D; see Decisions.
4. **Rollback completeness:** after any failure, HEAD equals the previous commit, `node_modules` is reinstalled for it, the permission fingerprint is unchanged, and the owner is told which step failed (Task 5). A failed rollback must be loud and must leave a state the doctor reports as FAIL.
5. **Permission set is untouchable:** a fingerprint of `.claude/settings.local.json` is taken before and compared after; a change means rollback. Updates that touch `.claude/settings.json`, hooks, the ccgram pin or the ccgram launcher are skipped for manual review (Tasks 3, 5).
6. **Migrations run on a copy first**, produced with the SQLite online backup API, never a raw copy of a live file (Tasks 1, 5).
7. **Backup scope:** secrets are excluded by default, opt-in only, and the archive is always encrypted to a public key whose private half is not on the machine (Tasks 7, 9).
8. **Restore never overwrites silently:** default is verify-only into a fresh directory; applying to the live tree needs the lock, a typed confirmation, and moves existing files aside rather than deleting them (Task 10).
9. **No secrets in output:** notifications, doctor output and logs must not contain env values, key material, or database content (Tasks 4, 9, 11).
10. **Time-of-day:** the random run time must land outside quiet hours in IST regardless of server timezone (Task 2).

## Decisions to confirm (assumed accepted)

| # | Decision | Cost if wrong |
|---|---|---|
| D1 | **Lock module is plan 6D's `src/platform/lock.ts`** (verified against the 6D plan text; not yet implemented code): synchronous `acquireLock(root: string, name: string, owner: string, deps?: LockDeps, opts?: { ttlMs?: number }): LockHandle | null` with `LockHandle { info; heartbeat(): void; release(): boolean }`; `null` means held. 6D names the lock `run` and says wakes and `AUTO_UPDATE` share it, so the update job calls `acquireLock(lockRoot, 'run', 'auto-update', undefined, { ttlMs })` and heartbeats during long steps; `lockRoot` is the value 6D's scheduler passes as `root`. All 6D coupling stays in `src/update/lockAdapter.ts` (Task 6). | Rewrite one adapter file (about 20 lines). Re-read 6D and adjust the adapter before executing Task 6. |
| D2 | **Signature verification uses git's SSH signing**: `AUTO_UPDATE_SIGNERS_FILE` points to an `allowed_signers` file; each commit in the range is checked with `git -c gpg.ssh.allowedSignersFile=<file> log --format=%G?`. Result `G` is good, anything else is unsigned. GPG works the same way if the owner uses GPG-signed commits and leaves the setting unset (git then uses the keyring). `AUTO_UPDATE_REQUIRE_SIGNED` defaults to `true`; with `true` and no signers file the job refuses to run (skip: `unconfigured`). | If the upstream does not sign commits yet, every update is skipped until it does or the owner sets `AUTO_UPDATE_REQUIRE_SIGNED=false` (the spec says "ideally verified", so this is allowed but doctor warns). |
| D3 | **Upstream is explicit config, not inferred**: `AUTO_UPDATE_REMOTE` (default `origin`) and `AUTO_UPDATE_BRANCH` (default `main`); optional `AUTO_UPDATE_TAG_PATTERN` (for example `v*`) switches to "newest matching signed tag". The repo currently has only a remote named `old-origin`; the doctor warns until the configured remote exists. | Updates skip with `no-upstream` until configured; no harm. |
| D4 | **Paths that force a manual review (skip, not apply)**: `.claude/settings.json`, `.claude/hooks/`, `.githooks/`, `config/ccgram.pin.json`, `scripts/ccgram/`. They define the shared baseline hooks and deny rules, or how the Telegram bridge is launched; the owner reviews and runs `git merge --ff-only` by hand. Overridable via `AUTO_UPDATE_REVIEW_PATHS`. Changes to `config/permission-sets.json` are applied but called out in the notification and by doctor (D6). | Over-skipping means more manual updates; under-skipping would be a security gap. Chosen conservative. |
| D5 | **Test gate allows the known baseline failures**: `config/update-known-failures.json` maps test file to allowed failure count (`tests/renderChecked.test.ts`: 4, `tests/resume.test.ts`: 1). Any failure outside it, or more failures in a listed file, is a failed update. Likewise the doctor gate compares against a doctor run taken before the merge and fails only on checks that newly fail. | If the baseline file goes stale, updates roll back needlessly (safe direction). |
| D6 | **"Never change the permission set"** is enforced by (a) a sha256 fingerprint of `.claude/settings.local.json` before and after (change means rollback) and (b) a doctor check `new-tools-not-allowed` that lists MCP tools in the chosen set's definition that the local allow list lacks, with "run setup to opt in". The update never writes the local file. | A hostile or buggy update script that writes it would be caught only by the fingerprint after the fact; rollback restores code but not the file (it is backed up by the backup job). Acceptable: all update steps are our own fixed commands. |
| D7 | **Encryption uses `age`** (public-key). Installable with `brew install age` or `apt install age`; single static binary, authenticated encryption. The scheduled job holds only the recipient public key (`BACKUP_AGE_RECIPIENT`), so a compromised machine cannot decrypt old backups; the private key (identity file) is held by the owner offline and is needed only to restore. `openssl enc` is rejected as the default because a symmetric passphrase must live on the machine to run unattended, and `openssl enc` is not authenticated. `age` is not currently installed on this machine (`openssl` is); installing it is an owner step. | Without `age` the backup job refuses to run and doctor FAILs the tool check (not a silent plaintext fallback). |
| D8 | **Secrets are not backed up by default.** `.env` and `secrets/` (LinkedIn, Naukri, Gmail sessions) are excluded unless `BACKUP_INCLUDE_SECRETS=true`. Reasoning: they are re-creatable (new bot token, re-login, new app password), they are the highest-value target if a backup copy or the age identity leaks, and the backup destination may be a cloud drive. Opting in is allowed because it is encrypted, but restoring a stale session may be useless anyway. | If excluded and the machine dies, the owner re-does logins (an hour). If included by default and the key leaks, every account is exposed. Chosen exclusion. |
| D9 | **Destination: local directory first** (`BACKUP_DIR`, must be set explicitly, ideally outside the project and on another disk), with an optional `rclone` mirror (`BACKUP_RCLONE_REMOTE`, for example a Google Drive remote created with `scope = drive.file`). `rclone` is not installed here; it is documented, tested through a fake `Exec`, and not required. Direct Google Drive OAuth code is not written (the spec parks it). | If rclone behaves differently from the fake, the mirror step fails loudly and the local copy still exists. |
| D10 | **Restore drill is owner-run**, because the identity is not on the machine. The job cannot drill itself; doctor warns when the last recorded drill is older than 90 days. | The owner forgets the drill; the warning nags. |
| D11 | **Quiet hours are reused** from `loadOutreachConfig` (`QUIET_HOURS_START`/`END`, IST, default 01:00 to 07:00). | None. |

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/exec.ts` | `Exec` port with timeout and env, `defaultExec` (execFile), `pipeExec` for streaming `tar` into `age` |
| `src/lib/sqliteSnapshot.ts` | `snapshotDb(src, dest)` using the online backup API, `checkSnapshot(path)` (integrity check and table counts) |
| `src/update/config.ts` | `loadUpdateConfig(env)` and validation |
| `src/update/schedule.ts` | `pickRunTime`, `isDue` (pure; shared with backup) |
| `src/update/plan.ts` | `RepoFacts`, `planUpdate` (pure) |
| `src/update/git.ts` | `gatherFacts(exec, cfg)` (fetch and read-only git queries) |
| `src/update/state.ts` | State file read, write, record (atomic, mode 600) |
| `src/update/notes.ts` | `summarizeRange`, `formatNotification` (pure, sanitizing) |
| `src/platform/notify.ts` | `Notifier`, `telegramNotifier` (plain text, `fetch` injected) |
| `src/update/verify.ts` | `evaluateTestReport`, `doctorRegression`, `fingerprint` (pure) |
| `src/update/apply.ts` | `applyUpdate` orchestrator: snapshot, ff merge, install, migrate copy, doctor, tests, rollback |
| `src/update/lockAdapter.ts` | The only file that imports the scheduler lock (decision D1) |
| `scripts/auto-update.ts` | CLI: `--tick`, `--now`, `--dry-run`, `--status` |
| `scripts/migrate-check.ts` | Opens the DB at `JOBAPPLIER_DB` with `openDb` (runs migrations) and exits 0 or 1 |
| `config/update-known-failures.json` | Allowed baseline test failures per file |
| `src/backup/config.ts` | `loadBackupConfig(env)` |
| `src/backup/entries.ts` | `planEntries`: what goes in the archive and why |
| `src/backup/manifest.ts` | Manifest build and verify (sha256 per entry, table counts) |
| `src/backup/retention.ts` | `planRetention` (pure) |
| `src/backup/destination.ts` | `BackupDestination`, `LocalDirDestination`, `RcloneDestination` |
| `src/backup/create.ts` | `createBackup`: snapshot, stage, tar, age, upload, retention, state |
| `src/backup/restore.ts` | `verifyArchive`, `planRestore`, `applyRestore`, `drill` |
| `src/backup/state.ts` | `.backups/state.json` (last backup, last drill) |
| `scripts/backup.ts`, `scripts/restore.ts` | CLIs |
| `src/platform/updateBackupChecks.ts` | Doctor checks for update and backup |
| `src/platform/doctor.ts` (modify) | add `formatJson` |
| `scripts/doctor.ts` (modify) | `--json` flag, include the new checks |
| `package.json` (modify) | scripts `auto-update`, `backup`, `restore` |
| `.gitignore`, `.env.example` (modify) | `.update/`, `.backups/`; new keys |
| `docs/backup-and-restore.md` | Owner runbook |

---

### Task 1: Shared ports and the SQLite snapshot helper

**Files:**
- Create: `src/lib/exec.ts`, `src/lib/sqliteSnapshot.ts`
- Modify: `.gitignore` (append `.update/` and `.backups/`)
- Test: `tests/sqlite-snapshot.test.ts`, `tests/exec.test.ts`

**Interfaces:**
```ts
// src/lib/exec.ts
export interface ExecOpts { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string }
export type Exec = (cmd: string, args: string[], opts?: ExecOpts) => Promise<{ stdout: string; stderr: string; code: number }>
export const defaultExec: Exec           // execFile, default timeout 120_000, maxBuffer 10 MB; code 127 when the binary is missing
// Streams `producer` stdout into `consumer` stdin; resolves when both exit. No shell.
export function pipeExec(producer: { cmd: string; args: string[]; cwd?: string },
                         consumer: { cmd: string; args: string[] }): Promise<{ producerCode: number; consumerCode: number; stderr: string }>

// src/lib/sqliteSnapshot.ts
export async function snapshotDb(srcPath: string, destPath: string): Promise<void>   // online backup, dest mode 600
export interface SnapshotCheck { ok: boolean; integrity: string; tables: Record<string, number> }
export function checkSnapshot(path: string): SnapshotCheck                           // opens readonly; PRAGMA integrity_check; row count per table
```

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sqlite-snapshot.test.ts
import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { mkdtempSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotDb, checkSnapshot } from '../src/lib/sqliteSnapshot.js';

function tmp() { return mkdtempSync(join(tmpdir(), 'snap-')); }

describe('snapshotDb', () => {
  it('copies a live WAL database consistently and with mode 600', async () => {
    const dir = tmp();
    const src = join(dir, 'src.sqlite');
    const live = new BetterSqlite3(src);
    live.pragma('journal_mode = WAL');
    live.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE u (id INTEGER)');
    live.prepare('INSERT INTO t (v) VALUES (?)').run('synthetic-a');
    live.prepare('INSERT INTO t (v) VALUES (?)').run('synthetic-b');
    const dest = join(dir, 'copy.sqlite');
    await snapshotDb(src, dest);          // source connection still open and holding the WAL
    live.close();
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    const check = checkSnapshot(dest);
    expect(check.ok).toBe(true);
    expect(check.integrity).toBe('ok');
    expect(check.tables).toEqual({ t: 2, u: 0 });
  });
  it('refuses to overwrite an existing destination and a missing source', async () => {
    const dir = tmp();
    await expect(snapshotDb(join(dir, 'nope.sqlite'), join(dir, 'x'))).rejects.toThrow();
    const src = join(dir, 's.sqlite'); new BetterSqlite3(src).close();
    await snapshotDb(src, join(dir, 'd.sqlite'));
    await expect(snapshotDb(src, join(dir, 'd.sqlite'))).rejects.toThrow(/exists/);
    expect(existsSync(join(dir, 'nope.sqlite'))).toBe(false);   // source not created as a side effect
  });
  it('checkSnapshot reports not ok for a non-database file', () => {
    const dir = tmp();
    const bad = join(dir, 'bad');
    require('node:fs').writeFileSync(bad, 'not a database'.repeat(100));
    expect(checkSnapshot(bad).ok).toBe(false);
  });
});
```

```ts
// tests/exec.test.ts  (uses the real node binary, no network)
import { describe, it, expect } from 'vitest';
import { defaultExec } from '../src/lib/exec.js';
describe('defaultExec', () => {
  it('returns stdout and code 0', async () => {
    const r = await defaultExec(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(r).toMatchObject({ stdout: 'hi', code: 0 });
  });
  it('returns the real nonzero code and 127 for a missing binary, without throwing', async () => {
    expect((await defaultExec(process.execPath, ['-e', 'process.exit(3)'])).code).toBe(3);
    expect((await defaultExec('definitely-not-a-binary-xyz', [])).code).toBe(127);
  });
  it('kills on timeout', async () => {
    const r = await defaultExec(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 200 });
    expect(r.code).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure:** `npx vitest run tests/sqlite-snapshot.test.ts tests/exec.test.ts` (expect module not found).

- [ ] **Step 3: Implement.** `snapshotDb`: throw if `src` does not exist (check before opening so no empty file is created: `new BetterSqlite3(src, { readonly: true, fileMustExist: true })`), throw `destination exists` if `dest` exists, `await db.backup(dest)`, `chmod 600`, close the source in `finally`. If a readonly WAL open fails with SQLITE_CANTOPEN, retry once with a normal connection (documented fallback; never run migrations, never use `openDb`). `checkSnapshot`: open readonly in try/catch, `PRAGMA integrity_check` first row, `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`, `SELECT COUNT(*)` per table with the name double-quoted (names come from the db itself; validate `^[A-Za-z0-9_]+$` and skip otherwise). `defaultExec` maps `ENOENT` to code 127 and never throws. `pipeExec` uses `spawn` for both ends with `stdio` pipes.

- [ ] **Step 4: Run tests to pass; run `npx tsc --noEmit`.**

- [ ] **Step 5: Commit**
```bash
git add src/lib/exec.ts src/lib/sqliteSnapshot.ts tests/sqlite-snapshot.test.ts tests/exec.test.ts .gitignore
git commit -m "feat(platform): exec port and SQLite online-backup snapshot helper"
```

---

### Task 2: Update config and the run-time picker

**Files:**
- Create: `src/update/config.ts`, `src/update/schedule.ts`
- Test: `tests/update-config.test.ts`, `tests/update-schedule.test.ts`

**Interfaces:**
```ts
// config.ts
export interface UpdateConfig {
  enabled: boolean;               // AUTO_UPDATE === 'true' exactly; anything else false
  remote: string;                 // AUTO_UPDATE_REMOTE, default 'origin'; must match ^[A-Za-z0-9_.-]{1,64}$
  branch: string;                 // AUTO_UPDATE_BRANCH, default 'main'; ^[A-Za-z0-9_./-]{1,100}$, no leading '-' and no '..'
  tagPattern: string | null;      // AUTO_UPDATE_TAG_PATTERN, ^[A-Za-z0-9_.*-]{1,50}$
  requireSigned: boolean;         // AUTO_UPDATE_REQUIRE_SIGNED, default true; only 'false' disables
  signersFile: string | null;     // AUTO_UPDATE_SIGNERS_FILE, absolute path or relative to root
  reviewPaths: string[];          // AUTO_UPDATE_REVIEW_PATHS comma list; default per decision D4
  problems: string[];             // validation messages; non-empty means the job must refuse to run
}
export function loadUpdateConfig(env: NodeJS.ProcessEnv): UpdateConfig

// schedule.ts  (shared by backup)
export interface QuietWindow { startHour: number; endHour: number; tzOffsetMinutes: number }
export type Rng = () => number
export function pickRunTime(after: Date, rng: Rng, quiet: QuietWindow): Date     // uniform over allowed minutes of the next local day after `after`'s local day
export function isDue(now: Date, nextRunAt: string | null, quiet: QuietWindow): boolean  // true when nextRunAt is null or <= now, and now is not inside quiet hours
```

- [ ] **Step 1: Write failing tests** (cover each rule):

```ts
// tests/update-config.test.ts
import { describe, it, expect } from 'vitest';
import { loadUpdateConfig } from '../src/update/config.js';

describe('loadUpdateConfig', () => {
  it('defaults: disabled, origin/main, signing required', () => {
    const c = loadUpdateConfig({});
    expect(c).toMatchObject({ enabled: false, remote: 'origin', branch: 'main', requireSigned: true, tagPattern: null, signersFile: null });
    expect(c.reviewPaths).toContain('.claude/settings.json');
    expect(c.reviewPaths).toContain('config/ccgram.pin.json');
  });
  it('enabled only for the exact string true', () => {
    for (const v of ['TRUE', '1', 'yes', ' true']) expect(loadUpdateConfig({ AUTO_UPDATE: v }).enabled).toBe(false);
    expect(loadUpdateConfig({ AUTO_UPDATE: 'true' }).enabled).toBe(true);
  });
  it('rejects option-like and traversal values for remote, branch and tag pattern', () => {
    for (const bad of ['-x', 'a b', 'a;b', '../x', '']) {
      expect(loadUpdateConfig({ AUTO_UPDATE_BRANCH: bad }).problems.length).toBeGreaterThan(0);
    }
    expect(loadUpdateConfig({ AUTO_UPDATE_REMOTE: '--upload-pack=x' }).problems.length).toBeGreaterThan(0);
  });
  it('requireSigned with no signers file is a problem; requireSigned=false is not', () => {
    expect(loadUpdateConfig({ AUTO_UPDATE: 'true' }).problems.join()).toMatch(/signers/i);
    expect(loadUpdateConfig({ AUTO_UPDATE: 'true', AUTO_UPDATE_REQUIRE_SIGNED: 'false' }).problems).toEqual([]);
  });
});
```

```ts
// tests/update-schedule.test.ts
import { describe, it, expect } from 'vitest';
import { pickRunTime, isDue } from '../src/update/schedule.js';
const quiet = { startHour: 1, endHour: 7, tzOffsetMinutes: 330 };
const istHour = (d: Date) => new Date(d.getTime() + 330 * 60000).getUTCHours();

describe('pickRunTime', () => {
  it('never lands in quiet hours (IST) for many draws, including an overnight window', () => {
    for (let i = 0; i < 500; i++) {
      const t = pickRunTime(new Date('2026-10-14T20:30:00Z'), Math.random, quiet);
      const h = istHour(t);
      expect(h >= 7 || h < 1).toBe(true);
    }
    const overnight = { startHour: 22, endHour: 6, tzOffsetMinutes: 330 };
    for (let i = 0; i < 200; i++) {
      const h = istHour(pickRunTime(new Date('2026-10-14T00:00:00Z'), Math.random, overnight));
      expect(h >= 6 && h < 22).toBe(true);
    }
  });
  it('is strictly after the input and within the next 48 hours; deterministic for a fixed rng', () => {
    const now = new Date('2026-10-14T10:00:00Z');
    const a = pickRunTime(now, () => 0.5, quiet);
    expect(a.getTime()).toBeGreaterThan(now.getTime());
    expect(a.getTime() - now.getTime()).toBeLessThan(48 * 3600_000);
    expect(pickRunTime(now, () => 0.5, quiet).getTime()).toBe(a.getTime());
  });
  it('quiet window of zero length (start equals end) allows every minute', () => {
    expect(() => pickRunTime(new Date(), Math.random, { startHour: 3, endHour: 3, tzOffsetMinutes: 0 })).not.toThrow();
  });
});

describe('isDue', () => {
  it('due when never scheduled, when time passed, not during quiet hours, not before', () => {
    const noon = new Date('2026-10-14T06:30:00Z');   // 12:00 IST
    expect(isDue(noon, null, quiet)).toBe(true);
    expect(isDue(noon, '2026-10-14T05:00:00Z', quiet)).toBe(true);
    expect(isDue(noon, '2026-10-14T07:00:00Z', quiet)).toBe(false);
    expect(isDue(new Date('2026-10-13T21:30:00Z'), null, quiet)).toBe(false); // 03:00 IST, quiet
  });
});
```

- [ ] **Step 2: Run to fail:** `npx vitest run tests/update-config.test.ts tests/update-schedule.test.ts`.
- [ ] **Step 3: Implement.** `pickRunTime`: compute local day boundaries from `tzOffsetMinutes`, enumerate the 1440 minutes of the next local day (the day after `after`'s local day), drop minutes inside the quiet window (same wrap logic as `inQuietHours` in `src/outreach/pacing.ts`; do not import it, the shapes differ, but keep the same semantics, and a test above pins them), draw `Math.floor(rng() * allowed.length)`, clamp rng to `[0, 1)`.
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit**
```bash
git add src/update/config.ts src/update/schedule.ts tests/update-config.test.ts tests/update-schedule.test.ts
git commit -m "feat(update): AUTO_UPDATE config and random run-time picker outside quiet hours"
```

---

### Task 3: Repo facts and the pure update plan

**Files:**
- Create: `src/update/plan.ts`, `src/update/git.ts`
- Test: `tests/update-plan.test.ts`, `tests/update-git.test.ts`

**Interfaces:**
```ts
// plan.ts
export type Signature = 'G' | 'U' | 'B' | 'X' | 'Y' | 'R' | 'E' | 'N'   // git %G? values; only 'G' is good
export interface RangeCommit { sha: string; subject: string; signature: Signature }
export interface RepoFacts {
  head: string;
  currentBranch: string | null;        // null when detached
  dirty: boolean;
  upstreamSha: string | null;          // null when remote ref/tag not found
  upstreamLabel: string;               // 'origin/main' or the tag name
  ahead: number;                       // commits on HEAD not in upstream
  behind: number;                      // commits in upstream not on HEAD
  commits: RangeCommit[];              // HEAD..upstream, oldest first
  changedPaths: string[];              // diff --name-only HEAD upstream
  tagSignature: Signature | null;      // tag mode only
}
export type SkipReason =
  | 'disabled' | 'unconfigured' | 'no-upstream' | 'detached-head' | 'wrong-branch' | 'dirty'
  | 'diverged' | 'unsigned' | 'reserved-paths' | 'lock-held'
export type UpdatePlan =
  | { action: 'noop'; head: string }
  | { action: 'skip'; reason: SkipReason; detail: string; head: string }
  | { action: 'apply'; from: string; to: string; commits: RangeCommit[]; changedPaths: string[]; permissionSetFileChanged: boolean }
export function planUpdate(facts: RepoFacts, cfg: UpdateConfig, opts?: { ignoreEnabled?: boolean }): UpdatePlan
export function matchesReviewPath(path: string, reviewPaths: string[]): boolean   // entry ending in '/' is a prefix, otherwise exact

// git.ts
export async function gatherFacts(exec: Exec, cfg: UpdateConfig, root: string): Promise<RepoFacts>
```

Plan order (first match wins): `disabled` (unless `ignoreEnabled`, used by `--now` and dry run), `unconfigured` (cfg.problems non-empty), `detached-head`, `wrong-branch`, `dirty`, `no-upstream`, then `noop` when `behind === 0 && ahead === 0`, `diverged` when `ahead > 0` (local commits not upstream, whether or not behind), `unsigned` when `cfg.requireSigned` and any commit signature is not `G` (or tag mode and `tagSignature !== 'G'`), `reserved-paths`, else `apply`.

- [ ] **Step 1: Write failing tests**

```ts
// tests/update-plan.test.ts
import { describe, it, expect } from 'vitest';
import { planUpdate, matchesReviewPath, type RepoFacts } from '../src/update/plan.js';
import { loadUpdateConfig } from '../src/update/config.js';

const cfg = loadUpdateConfig({ AUTO_UPDATE: 'true', AUTO_UPDATE_SIGNERS_FILE: '/x/allowed_signers' });
const A = 'a'.repeat(40), B = 'b'.repeat(40);
function facts(over: Partial<RepoFacts> = {}): RepoFacts {
  return { head: A, currentBranch: 'main', dirty: false, upstreamSha: B, upstreamLabel: 'origin/main',
    ahead: 0, behind: 1, commits: [{ sha: B, subject: 'feat: x', signature: 'G' }],
    changedPaths: ['src/a.ts'], tagSignature: null, ...over };
}

describe('planUpdate', () => {
  it('applies a clean signed fast-forward', () => {
    expect(planUpdate(facts(), cfg)).toMatchObject({ action: 'apply', from: A, to: B });
  });
  it('is disabled unless AUTO_UPDATE=true, but ignoreEnabled bypasses that for --now', () => {
    const off = loadUpdateConfig({ AUTO_UPDATE_SIGNERS_FILE: '/x' });
    expect(planUpdate(facts(), off)).toMatchObject({ action: 'skip', reason: 'disabled' });
    expect(planUpdate(facts(), off, { ignoreEnabled: true }).action).toBe('apply');
  });
  it('skips on dirty, detached, wrong branch, no upstream', () => {
    expect(planUpdate(facts({ dirty: true }), cfg)).toMatchObject({ reason: 'dirty' });
    expect(planUpdate(facts({ currentBranch: null }), cfg)).toMatchObject({ reason: 'detached-head' });
    expect(planUpdate(facts({ currentBranch: 'feature' }), cfg)).toMatchObject({ reason: 'wrong-branch' });
    expect(planUpdate(facts({ upstreamSha: null }), cfg)).toMatchObject({ reason: 'no-upstream' });
  });
  it('noop when already up to date; diverged when local commits exist (ahead or both)', () => {
    expect(planUpdate(facts({ behind: 0, commits: [] }), cfg).action).toBe('noop');
    expect(planUpdate(facts({ ahead: 2, behind: 0, commits: [] }), cfg)).toMatchObject({ reason: 'diverged' });
    expect(planUpdate(facts({ ahead: 1, behind: 3 }), cfg)).toMatchObject({ reason: 'diverged' });
  });
  it('unsigned: any non-G commit, listing the shas; allowed when requireSigned=false', () => {
    const f = facts({ commits: [{ sha: A, subject: 'a', signature: 'G' }, { sha: B, subject: 'b', signature: 'N' }] });
    const p = planUpdate(f, cfg);
    expect(p).toMatchObject({ action: 'skip', reason: 'unsigned' });
    expect((p as { detail: string }).detail).toContain(B.slice(0, 12));
    const loose = loadUpdateConfig({ AUTO_UPDATE: 'true', AUTO_UPDATE_REQUIRE_SIGNED: 'false' });
    expect(planUpdate(f, loose).action).toBe('apply');
  });
  it('an unconfigured signer (requireSigned, no file) refuses', () => {
    const bad = loadUpdateConfig({ AUTO_UPDATE: 'true' });
    expect(planUpdate(facts(), bad)).toMatchObject({ reason: 'unconfigured' });
  });
  it('tag mode requires a good tag signature too', () => {
    const t = loadUpdateConfig({ AUTO_UPDATE: 'true', AUTO_UPDATE_SIGNERS_FILE: '/x', AUTO_UPDATE_TAG_PATTERN: 'v*' });
    expect(planUpdate(facts({ upstreamLabel: 'v1.2.0', tagSignature: 'N' }), t)).toMatchObject({ reason: 'unsigned' });
    expect(planUpdate(facts({ upstreamLabel: 'v1.2.0', tagSignature: 'G' }), t).action).toBe('apply');
  });
  it('reserved paths force manual review, with the paths in the detail', () => {
    for (const p of ['.claude/settings.json', '.claude/hooks/x.sh', '.githooks/pre-commit', 'config/ccgram.pin.json', 'scripts/ccgram/run.sh']) {
      const r = planUpdate(facts({ changedPaths: ['src/a.ts', p] }), cfg);
      expect(r).toMatchObject({ action: 'skip', reason: 'reserved-paths' });
      expect((r as { detail: string }).detail).toContain(p);
    }
  });
  it('flags a permission-set definition change without skipping', () => {
    const r = planUpdate(facts({ changedPaths: ['config/permission-sets.json'] }), cfg);
    expect(r).toMatchObject({ action: 'apply', permissionSetFileChanged: true });
  });
});

describe('matchesReviewPath', () => {
  it('prefix entries end with a slash, exact otherwise, no partial-name matches', () => {
    expect(matchesReviewPath('scripts/ccgram/run.sh', ['scripts/ccgram/'])).toBe(true);
    expect(matchesReviewPath('scripts/ccgram-other.sh', ['scripts/ccgram/'])).toBe(false);
    expect(matchesReviewPath('.claude/settings.json', ['.claude/settings.json'])).toBe(true);
    expect(matchesReviewPath('.claude/settings.json.bak', ['.claude/settings.json'])).toBe(false);
  });
});
```

```ts
// tests/update-git.test.ts : drive gatherFacts with a fake Exec keyed by joined args
```
Assertions: (a) the exact command sequence is `status --porcelain`, `symbolic-ref`, `fetch --prune <remote> <branch>` (with `GIT_TERMINAL_PROMPT=0` in env), `rev-parse <remote>/<branch>`, `rev-list --left-right --count HEAD...<sha>`, `log` with `-c gpg.ssh.allowedSignersFile=<file>` and format `%H%x1f%G?%x1f%s`, `diff --name-only`; (b) a fake returning code 1 for fetch yields `upstreamSha: null` (not a throw); (c) the `log` output with a subject containing `\x1f`-free hostile text such as `$(rm -rf /)` is carried verbatim as data and never appears in any argument; (d) tag mode uses `tag --list <pattern> --sort=-v:refname`, takes the first line, `rev-parse <tag>^{commit}` and `verify-tag` with the same `-c` setting; (e) no argument list in any recorded call contains `merge`, `pull`, `reset`, `checkout`, `rebase` or `push`.

- [ ] **Step 2: Run to fail:** `npx vitest run tests/update-plan.test.ts tests/update-git.test.ts`.
- [ ] **Step 3: Implement** `planUpdate`, `matchesReviewPath` and `gatherFacts` per the interfaces. `gatherFacts` never mutates the working tree or the index; `git fetch` only updates remote-tracking refs and tags.
- [ ] **Step 4: Run to pass; `npx tsc --noEmit`.**
- [ ] **Step 5: Commit**
```bash
git add src/update/plan.ts src/update/git.ts tests/update-plan.test.ts tests/update-git.test.ts
git commit -m "feat(update): pure update plan and read-only repo facts"
```

---

### Task 4: State file, notification text and the Telegram notifier

**Files:**
- Create: `src/update/state.ts`, `src/update/notes.ts`, `src/platform/notify.ts`
- Test: `tests/update-state.test.ts`, `tests/update-notes.test.ts`, `tests/notify.test.ts`

**Interfaces:**
```ts
// state.ts
export type Outcome = 'updated' | 'skipped' | 'noop' | 'dry_run' | 'rolled_back' | 'rollback_failed' | 'error'
export interface UpdateResultRecord { at: string; outcome: Outcome; from: string; to: string | null; reason: string | null; step: string | null }
export interface UpdateState {
  version: 1; last_good_commit: string | null; next_run_at: string | null;
  in_progress: { from: string; to: string; started_at: string } | null;     // set before the merge; cleared at the end
  last_result: UpdateResultRecord | null; history: UpdateResultRecord[];    // newest last, capped at 20
}
export const STATE_PATH = '.update/state.json'
export function readState(fs: StateFs, root: string): UpdateState      // missing or corrupt file -> empty state (corrupt is reported via `corrupt: true` on a wrapper)
export function writeState(fs: StateFs, root: string, s: UpdateState): void   // atomic: write tmp (mode 600) then rename; dir mode 700
export function recordResult(s: UpdateState, r: UpdateResultRecord, lastGood?: string): UpdateState

// notes.ts
export function sanitizeLine(s: string, max?: number): string           // strips control chars and bidi overrides, collapses whitespace, caps length (default 100)
export function summarizeRange(commits: { sha: string; subject: string }[], maxLines?: number): string[]  // groups by conventional prefix (feat/fix/docs/other), at most maxLines (default 10) plus "+N more"
export function formatNotification(r: { outcome: Outcome; from: string; to: string | null; reason: string | null; step: string | null; commits: { sha: string; subject: string }[]; flags: string[]; dryRun: boolean; restartNeeded: boolean }): string  // plain text, <= 3500 chars

// notify.ts
export interface Notifier { send(text: string): Promise<{ ok: boolean; detail: string }> }
export function telegramNotifier(env: NodeJS.ProcessEnv, fetchFn?: typeof fetch): Notifier   // sendMessage to the first ALLOWED_USERS id, no parse_mode, 10 s timeout; detail never contains the token
export const consoleNotifier: Notifier
```

- [ ] **Step 1: Write failing tests.** State: round trip; a corrupt JSON file yields the empty state; history capped at 20; file mode 600 and dir 700 (use a temp root); `recordResult(..., lastGood)` updates `last_good_commit` only when the outcome is `updated`. Notes: `sanitizeLine('feat: x‮ evil\n[click](http://x)')` has no control or bidi characters and no newline; `formatNotification` for `updated` contains the short `from..to` range (12 chars each), the grouped summary and, when `restartNeeded`, the line "restart Claude sessions to load the new code"; for `skipped` it contains the reason and the one-line fix hint per reason (`dirty`: "commit or stash local changes", `unsigned`: "review the commits and merge by hand or update AUTO_UPDATE_SIGNERS_FILE", `reserved-paths`: "review these paths, then run git merge --ff-only yourself", `diverged`: "local commits exist; rebase or reset by hand"); a result with 500 commits stays under 3500 characters; a subject of `<b>hi</b>` is kept literal. Notifier: the fake `fetch` receives a URL containing the token and a body without `parse_mode`; the returned `detail` and any thrown error text never contain the token; a missing token or an empty `ALLOWED_USERS` returns `{ ok: false, detail: 'telegram not configured' }` without calling fetch; a network error returns `ok: false` (never throws).
- [ ] **Step 2: Run to fail:** `npx vitest run tests/update-state.test.ts tests/update-notes.test.ts tests/notify.test.ts`.
- [ ] **Step 3: Implement.** `StateFs` is `{ exists, read, write(path, text, mode), mkdir(path, mode), rename }`; provide `nodeStateFs`. Use `parseEnv` from `src/platform/envFile.ts` only in the CLI, not here (the notifier receives `env` already merged by the CLI from `process.env` and the parsed `.env`).
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit**
```bash
git add src/update/state.ts src/update/notes.ts src/platform/notify.ts tests/update-state.test.ts tests/update-notes.test.ts tests/notify.test.ts
git commit -m "feat(update): state file, sanitized notification text and Telegram notifier"
```

---

### Task 5: Verification helpers and the apply orchestrator with rollback

**Files:**
- Create: `src/update/verify.ts`, `src/update/apply.ts`, `scripts/migrate-check.ts`, `config/update-known-failures.json`
- Modify: `src/platform/doctor.ts` (add `formatJson`), `scripts/doctor.ts` (add `--json`)
- Test: `tests/update-verify.test.ts`, `tests/update-apply.test.ts`, `tests/doctor-json.test.ts`

**Interfaces:**
```ts
// verify.ts
export type KnownFailures = Record<string, number>
export function evaluateTestReport(report: { testResults: { name: string; status: string; assertionResults: { status: string }[] }[] },
                                   allowed: KnownFailures, root: string): { ok: boolean; unexpected: string[]; counts: Record<string, number> }
export function doctorRegression(before: { id: string; status: string }[], after: { id: string; status: string }[]): string[]  // ids that are 'fail' after and were not 'fail' before
export function fingerprint(text: string | null): string                  // sha256 hex, 'absent' for null

// doctor.ts
export function formatJson(results: CheckOutcome[]): string               // [{id,title,status,detail}] ; no fix text needed

// apply.ts
export interface ApplyDeps {
  exec: Exec; root: string; now: () => Date;
  fs: { read(p: string): string | null; exists(p: string): boolean; mkdtemp(prefix: string): string; rmrf(p: string): void };
  state: { load(): UpdateState; save(s: UpdateState): void };
  snapshotDb: (dest: string) => Promise<void>;           // real: snapshotDb(dbPath(), dest)
  knownFailures: KnownFailures;
  notify: Notifier;
  dbPath: string;                                        // the live db path, for the migration copy source
}
export interface ApplyOptions { dryRun: boolean }
export interface ApplyOutcome { outcome: Outcome; step: string | null; reason: string | null; from: string; to: string }
export async function applyUpdate(deps: ApplyDeps, plan: Extract<UpdatePlan, { action: 'apply' }>, opts: ApplyOptions): Promise<ApplyOutcome>
```

**Step order inside `applyUpdate`** (each step's name is recorded in `step` on failure):
1. `preflight`: re-read `git status --porcelain` and `rev-parse HEAD`; abort (no mutation) if dirty or HEAD differs from `plan.from`.
2. `baseline-doctor`: `npm run doctor -- --json` at the old code, parse to the baseline list (a parse failure aborts: cannot compare).
3. `fingerprint-before`: `fingerprint(read('.claude/settings.local.json'))`.
4. If `dryRun`: record outcome `dry_run`, send the notification, return. No further steps.
5. `snapshot`: db snapshot into `.update/pre-update-<short>.sqlite` (mode 600). Failure aborts before the merge.
6. `state-in-progress`: write `in_progress {from, to}`.
7. `merge`: `git merge --ff-only <to>`.
8. `install`: `npm ci` (timeout 10 min).
9. `migrate-copy`: copy the snapshot taken in step 5 (not the live db) to a temp dir, run `npx tsx scripts/migrate-check.ts` with `JOBAPPLIER_DB=<copy>`; nonzero code fails. Remove the temp dir in all cases.
10. `doctor`: `npm run doctor -- --json`; `doctorRegression(baseline, after)` non-empty fails with the ids.
11. `tests`: `npx vitest run --reporter=json`; `evaluateTestReport` not ok fails with up to 5 unexpected file names (vitest exit code is ignored, the report decides; an unparseable report fails).
12. `permissions`: fingerprint after must equal before.
13. Success: clear `in_progress`, `recordResult(updated, lastGood = to)`, notify with `restartNeeded: true`.

**Rollback** (any failure from step 7 on): `git reset --hard <from>` (only here; `from` is the recorded previous commit), then `npm ci`, then re-check `rev-parse HEAD === from`. If both succeed: outcome `rolled_back`, notify with the failing step. If `reset` fails or HEAD differs: outcome `rollback_failed`, keep `in_progress` set (so doctor FAILs), notify with the loud message including the pre-update snapshot path. Rollback never touches the database (migrations are additive; see risks).

- [ ] **Step 1: Write failing tests**

```ts
// tests/update-verify.test.ts (highlights)
// evaluateTestReport:
//  - report with 4 failures in <root>/tests/renderChecked.test.ts and 1 in <root>/tests/resume.test.ts, allowed {tests/renderChecked.test.ts:4, tests/resume.test.ts:1} -> ok
//  - a 5th failure in renderChecked -> not ok, unexpected includes that file
//  - a failure in tests/other.test.ts -> not ok
//  - file paths are matched relative to root (absolute names in vitest JSON are made relative)
// doctorRegression: fail->fail is not a regression; pass->fail and (missing before)->fail are
// fingerprint: stable, 'absent' for null, differs for one-character change
```

```ts
// tests/update-apply.test.ts : fake Exec records [cmd,args,env] and returns scripted results by joined key.
```
Cases (each asserts the exact ordered list of git/npm calls and the final state file):
- happy path: order is `status`, `rev-parse HEAD`, `npm run doctor -- --json`, snapshot, `merge --ff-only <to>`, `npm ci`, `npx tsx scripts/migrate-check.ts`, `npm run doctor -- --json`, `npx vitest run --reporter=json`; outcome `updated`; `last_good_commit === to`; `in_progress === null`; a notification was sent exactly once and mentions restart.
- dry run: no `merge`, no `npm ci`, no snapshot; outcome `dry_run`; state `last_good_commit` unchanged.
- dirty at preflight: outcome `skipped`/`dirty`, zero mutating calls.
- install fails: calls include `reset --hard <from>` then a second `npm ci`; outcome `rolled_back`, `step: 'install'`.
- each of migrate, doctor regression, tests, permission fingerprint change: `rolled_back` with the right `step`.
- migration check runs against a copy: the env of the migrate call has `JOBAPPLIER_DB` that is not `deps.dbPath` and is under the temp dir; the temp dir is removed afterwards.
- rollback failure: `reset` returns code 1 -> `rollback_failed`, `in_progress` still set, notification contains "ROLLBACK FAILED".
- the snapshot function throwing aborts before merge with outcome `error` and step `snapshot`; no `merge` call recorded.
- no recorded call contains `--force`, `pull`, `rebase`, `push`, `checkout`, `stash` or `clean`.
- notifier failing (ok:false) never changes the outcome and is recorded in `reason` suffix `notify failed`.

```ts
// tests/doctor-json.test.ts : formatJson round-trips ids/status and contains no `fix` key
```

- [ ] **Step 2: Run to fail:** `npx vitest run tests/update-verify.test.ts tests/update-apply.test.ts tests/doctor-json.test.ts`.
- [ ] **Step 3: Implement.** `config/update-known-failures.json`: `{ "tests/renderChecked.test.ts": 4, "tests/resume.test.ts": 1 }`. `scripts/migrate-check.ts`: `const db = openDb(); db.close(); process.exit(0)` wrapped in try/catch printing only the error message (no row data) and exiting 1; it must refuse to run if `JOBAPPLIER_DB` is unset or equals `data.sqlite` (so it can never migrate the live file by accident). `scripts/doctor.ts`: when `process.argv.includes('--json')` print `formatJson(results)` and still exit with `exitCode`.
- [ ] **Step 4: Run to pass; `npx tsc --noEmit`; run the whole suite and confirm exactly 5 known failures.**
- [ ] **Step 5: Commit**
```bash
git add src/update/verify.ts src/update/apply.ts scripts/migrate-check.ts config/update-known-failures.json src/platform/doctor.ts scripts/doctor.ts tests/update-verify.test.ts tests/update-apply.test.ts tests/doctor-json.test.ts
git commit -m "feat(update): verified apply with migration copy, regression gates and rollback"
```

---

### Task 6: Lock adapter and the `auto-update` CLI

**Files:**
- Create: `src/update/lockAdapter.ts`, `src/update/run.ts`, `scripts/auto-update.ts`
- Modify: `package.json` (script `"auto-update": "tsx scripts/auto-update.ts"`)
- Test: `tests/update-run.test.ts`

**First step:** re-read the lock section of `docs/superpowers/plans/2026-10-14-6d-scheduler-agents-naukri.md` and confirm decision D1; if it differs, change only `lockAdapter.ts`. If `src/platform/lock.ts` does not exist when this task runs, implement `lockAdapter.ts` against the `LockPort` interface and make `scripts/auto-update.ts` refuse outside tests with "scheduler lock module not available; implement plan 6D first" (never update without the lock). The adapter wraps the synchronous API in a promise and runs a `heartbeat()` interval (every `ttlMs / 4`) until `release()`.

**Interfaces:**
```ts
// lockAdapter.ts
export interface LockHandle { release(): Promise<void> }
export interface LockPort { acquire(): Promise<LockHandle | null> }   // null means held
export function runLock(lockRoot: string): LockPort   // acquireLock(lockRoot, 'run', 'auto-update', undefined, { ttlMs: 120_000 }) plus a heartbeat timer every ttlMs/4; release() stops it

// run.ts
export interface RunDeps { cfg: UpdateConfig; exec: Exec; root: string; now: () => Date; rng: Rng; lock: LockPort;
  notify: Notifier; apply: (plan: Extract<UpdatePlan, {action:'apply'}>, o: ApplyOptions) => Promise<ApplyOutcome>;
  gather: () => Promise<RepoFacts>; state: { load(): UpdateState; save(s: UpdateState): void }; quiet: QuietWindow }
export interface RunOptions { mode: 'tick' | 'now'; dryRun: boolean }
export async function runUpdate(deps: RunDeps, o: RunOptions): Promise<{ outcome: Outcome; detail: string }>
```

Behavior of `runUpdate`:
- `tick`: if `!cfg.enabled` return `noop` silently (no notification, no git). If `!isDue(now, state.next_run_at, quiet)` return `noop` silently. Otherwise proceed, and on any completed attempt (apply, skip, noop, rollback) set `next_run_at = pickRunTime(now, rng, quiet)`.
- `now` (owner-triggered): ignores `enabled` and the schedule (`ignoreEnabled`), still honors every other rule, still takes the lock; does not change `next_run_at`.
- Acquire the lock first. `null` -> outcome `skipped` reason `lock-held`, notify, reschedule an early retry (`now + 30 min` clamped outside quiet hours is not needed; just leave `next_run_at` to the next tick and record the result).
- Gather facts, `planUpdate`, then: `skip` -> notify with reason and hint, record; `noop` -> record only, no notification (spec says notify after every update or skip; a no-op is neither); `apply` -> `deps.apply(plan, {dryRun})`. In dry-run mode, a `skip` is also reported (prefixed `DRY RUN`).
- Release the lock in `finally`, also when anything throws; an unexpected exception records outcome `error` and notifies with the sanitized message.
- Never log or notify env values.

- [ ] **Step 1: Write failing tests.** Fake everything: lock returning a handle with a spy `release`, notifier spy, state in memory, `gather` returning canned facts, `apply` spy. Cases: tick with `AUTO_UPDATE` off does nothing (no lock, no gather, no notify); tick before `next_run_at` does nothing; tick inside quiet hours does nothing; due tick with a skip notifies once with the reason and releases the lock; lock held yields skip `lock-held` with zero gather calls; noop sends no notification and still sets the next run; apply result is returned and `next_run_at` is a time outside quiet hours and in the future; `now` mode runs although disabled; a throwing `gather` records `error`, notifies once and still releases the lock; dry-run flag is passed through to `apply`; the lock is released after `apply` even when apply throws.
- [ ] **Step 2: Run to fail:** `npx vitest run tests/update-run.test.ts`.
- [ ] **Step 3: Implement.** `scripts/auto-update.ts` wires real ports: merge `process.env` with `parseEnv(.env)` (only for config and notifier; values never printed), `defaultExec`, `nodeStateFs`, `Math.random`, `loadOutreachConfig(env)` for quiet hours with `tzOffsetMinutes: 330`, `telegramNotifier`, `consoleNotifier` as fallback (print the same text to stdout). Flags: `--tick`, `--now`, `--dry-run`, `--status` (prints current commit, enabled flag, last result and next run from the state file, no git fetch, no notification). Exit code 0 for noop, updated, skipped, dry_run; 1 for rolled_back, rollback_failed, error.
- [ ] **Step 4: Run to pass; `npx tsc --noEmit`.**
- [ ] **Step 5: Commit**
```bash
git add src/update/lockAdapter.ts src/update/run.ts scripts/auto-update.ts tests/update-run.test.ts package.json
git commit -m "feat(update): locked update runner and auto-update CLI with dry-run"
```

---

### Task 7: Backup config, archive entries and manifest

**Files:**
- Create: `src/backup/config.ts`, `src/backup/entries.ts`, `src/backup/manifest.ts`
- Test: `tests/backup-config.test.ts`, `tests/backup-entries.test.ts`, `tests/backup-manifest.test.ts`

**Interfaces:**
```ts
// config.ts
export interface BackupConfig {
  dir: string | null;                  // BACKUP_DIR (absolute, or relative to root)
  recipient: string | null;            // BACKUP_AGE_RECIPIENT, must match ^age1[a-z0-9]{50,}$ (a public key). A line starting AGE-SECRET-KEY- is a problem
  includeSecrets: boolean;             // BACKUP_INCLUDE_SECRETS === 'true'
  rcloneRemote: string | null;         // BACKUP_RCLONE_REMOTE, ^[A-Za-z0-9_.-]+:[A-Za-z0-9_./ -]*$
  retain: { daily: number; weekly: number; monthly: number };   // defaults 7, 4, 6; integers 0..365
  problems: string[];
  configured: boolean;                 // dir and recipient present and valid
}
export function loadBackupConfig(env: NodeJS.ProcessEnv, root: string): BackupConfig

// entries.ts
export interface ArchiveEntry { archivePath: string; source: string; kind: 'db' | 'file' | 'dir'; why: string }
export interface Excluded { path: string; why: string }
export function planEntries(root: string, ex: { exists(p: string): boolean; list(dir: string): string[] },
                            cfg: { includeSecrets: boolean }, dbSnapshotPath: string): { entries: ArchiveEntry[]; excluded: Excluded[] }

// manifest.ts
export interface Manifest {
  version: 1; created_at: string; commit: string | null; includes_secrets: boolean;
  files: { path: string; sha256: string; bytes: number }[];
  db: { path: 'data.sqlite'; tables: Record<string, number> };
}
export function buildManifest(args: Omit<Manifest, 'version'>): Manifest
export function parseManifest(text: string): Manifest             // throws on wrong version or malformed fields
export function verifyFiles(m: Manifest, hashOf: (p: string) => string | null): { ok: boolean; missing: string[]; mismatched: string[]; extra: string[] }
```

**Included by default** (`why` strings recorded and shown by `backup --plan`):
- `data.sqlite` (from the online snapshot, never the live file): everything the owner would lose.
- `user-data/` (resume, answers, fact-gate, languages): irreplaceable personal inputs.
- `config/` (all `*.json`): local tuning may be uncommitted (portals, regions, replies, deal-breakers); small.
- `.claude/settings.local.json` and `.claude/settings.local.managed.json` (when present): the chosen permission set and manifest of managed entries.
- `.env.example` is NOT included (committed).

**Excluded always** (listed with a reason): `node_modules/`, `.git/`, `.ccgram/` (bridge state, re-creatable, holds session maps), `reports/`, `debug/`, `*.pdf` (regenerated), `scripts/eval/runs/`, `.backups/`, `.update/`, WAL and journal files (`*.sqlite-wal`, `*.sqlite-shm`, `*.sqlite-journal`), `*.bak`.
**Excluded unless `includeSecrets`**: `.env`, `secrets/` (LinkedIn, Naukri and Gmail session and credential files). Reason text: "credentials are re-creatable and are the highest-value target; opt in with BACKUP_INCLUDE_SECRETS=true".

- [ ] **Step 1: Write failing tests.** Config: defaults unconfigured; a secret-key-shaped recipient (`AGE-SECRET-KEY-1...`) is a problem and not stored; `BACKUP_INCLUDE_SECRETS` is true only for the exact string; retention numbers outside range are problems; remote shape. Entries (use a fake fs listing synthetic names such as `user-data/resume.json`, `secrets/linkedin-state.json`, `.env`, `config/portals.json`, `.claude/settings.local.json`, `data.sqlite-wal`): by default `secrets/` and `.env` appear in `excluded` with the opt-in reason and not in `entries`; with `includeSecrets: true` they appear in `entries` with kind `dir`/`file`; `data.sqlite` entry's `source` is the snapshot path and its `archivePath` is `data.sqlite`; WAL files never appear; no entry has an absolute or `..` archive path; a symlink-like name cannot be expressed (the planner only accepts names returned by `list`, which is a fake). Manifest: build then parse round trip; wrong `version` throws; `verifyFiles` detects missing, mismatched and extra; `parseManifest` rejects `path` values with `..` or a leading `/`.
- [ ] **Step 2: Run to fail:** `npx vitest run tests/backup-config.test.ts tests/backup-entries.test.ts tests/backup-manifest.test.ts`.
- [ ] **Step 3: Implement.** Entries are enumerated from an explicit allow-list of roots (above), never by walking the project root and subtracting, so a new sensitive directory is excluded by default.
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit**
```bash
git add src/backup/config.ts src/backup/entries.ts src/backup/manifest.ts tests/backup-config.test.ts tests/backup-entries.test.ts tests/backup-manifest.test.ts
git commit -m "feat(backup): config, explicit archive scope with secrets excluded, manifest"
```

---

### Task 8: Retention and destinations

**Files:**
- Create: `src/backup/retention.ts`, `src/backup/destination.ts`
- Test: `tests/backup-retention.test.ts`, `tests/backup-destination.test.ts`

**Interfaces:**
```ts
// retention.ts
export const BACKUP_NAME_RE = /^jobber-backup-(\d{8}T\d{6}Z)\.tar\.gz\.age$/
export function backupName(at: Date): string                        // jobber-backup-20261014T031500Z.tar.gz.age
export function planRetention(names: string[], policy: { daily: number; weekly: number; monthly: number }, now: Date): { keep: string[]; remove: string[] }
// Rules: names not matching BACKUP_NAME_RE are never in `remove` and not in `keep`. Newest backup always kept. Keep the newest per day for `daily` days, newest per ISO week for `weekly` weeks, newest per month for `monthly` months. All zero still keeps the newest one.

// destination.ts
export interface BackupDestination {
  readonly label: string
  put(localPath: string, name: string): Promise<void>      // refuses to overwrite an existing name
  list(): Promise<string[]>
  get(name: string, localPath: string): Promise<void>
  remove(name: string): Promise<void>                      // only names matching BACKUP_NAME_RE or `<that>.sha256`
}
export class LocalDirDestination implements BackupDestination { constructor(dir: string) }   // dir created 700; files 600; names validated; never follows a symlink out of dir
export class RcloneDestination implements BackupDestination { constructor(remote: string, exec: Exec) }  // rclone copyto / lsf / deletefile; args arrays; a missing rclone binary (code 127) is a clear error
```

- [ ] **Step 1: Write failing tests.** Retention: 40 daily names with policy 7/4/6 keeps the expected counts; one backup per day for 3 days with policy 7/0/0 keeps all 3; a stray file (`notes.txt`, `jobber-backup-bad.tar.gz.age`) is untouched; a zero policy keeps the newest; two backups in one day keep only the newer for the daily bucket; deterministic across input order. Destinations: Local `put` then `list` then `get` round trip in a temp dir; `put` of an existing name rejects; `remove('../../x')` and `remove('data.sqlite')` reject; a file mode of 600 and a dir mode of 700; a symlink placed inside the dir that points outside is not read or written through (`get` of such a name rejects). Rclone with a fake `Exec`: `put` runs `rclone copyto <local> <remote>/<name>`, `list` runs `rclone lsf <remote>` and filters names by `BACKUP_NAME_RE`, a code 127 error says to install rclone, remote and names are passed as separate arguments with no shell, and a remote starting with `-` is rejected.
- [ ] **Step 2: Run to fail:** `npx vitest run tests/backup-retention.test.ts tests/backup-destination.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit**
```bash
git add src/backup/retention.ts src/backup/destination.ts tests/backup-retention.test.ts tests/backup-destination.test.ts
git commit -m "feat(backup): retention planner and local-dir and rclone destinations"
```

---

### Task 9: Create a backup (pipeline, state, CLI)

**Files:**
- Create: `src/backup/create.ts`, `src/backup/state.ts`, `scripts/backup.ts`
- Modify: `package.json` (script `"backup": "tsx scripts/backup.ts"`)
- Test: `tests/backup-create.test.ts`

**Interfaces:**
```ts
// state.ts  (.backups/state.json, mode 600 in a 700 dir)
export interface BackupState { version: 1; last_backup_at: string | null; last_backup_name: string | null; last_error: string | null;
  last_drill_at: string | null; next_run_at: string | null }

// create.ts
export interface CreateDeps {
  root: string; now: () => Date; exec: Exec;
  fs: { exists(p: string): boolean; list(d: string): string[]; mkdtemp(prefix: string): string; rmrf(p: string): void; hash(p: string): string; size(p: string): number; copyIn(src: string, dest: string): void };
  snapshotDb: (dest: string) => Promise<void>; checkSnapshot: (p: string) => SnapshotCheck;
  pack: (args: { stagingDir: string; recipient: string; outPath: string }) => Promise<void>;   // real: pipeExec('tar', ...) into pipeExec('age', ['-r', recipient, '-o', outPath])
  destinations: BackupDestination[];            // primary first
  commit: () => Promise<string | null>;         // git rev-parse HEAD, null on failure
}
export interface CreateResult { ok: boolean; name: string | null; bytes: number; uploaded: string[]; failed: { label: string; error: string }[]; removed: string[]; error: string | null }
export async function createBackup(deps: CreateDeps, cfg: BackupConfig, opts: { planOnly: boolean }): Promise<CreateResult>
```

Pipeline: refuse when not `cfg.configured` or `cfg.problems` non-empty, or when `age` is missing (`age --version` code 127: error "age is not installed (brew install age)"; never a plaintext fallback) -> snapshot the db into a private temp staging dir (0700, under `.backups/.staging-<ts>`) -> `checkSnapshot` must be `ok` (integrity) or abort -> `planEntries` -> copy entries into staging (the DB entry from the snapshot) -> `buildManifest` with sha256 of each staged file and `tables` from the check -> write `manifest.json` into staging -> `pack` to `<tmp>/<name>` -> write `<name>.sha256` of the ciphertext -> `put` to each destination (primary failure fails the run; a secondary/rclone failure is recorded in `failed` and the run is still `ok: true` but `last_error` set) -> `planRetention` on the primary's listing and `remove` the stale names (a retention failure never fails the run) -> state update -> always remove the staging dir and any plaintext temp in `finally`. `planOnly` prints the entries and exclusions with their reasons and does nothing else (no snapshot, no write).

- [ ] **Step 1: Write failing tests** with fake ports (no real age or tar): refuses when unconfigured, when `age` missing (and `pack` never called, staging never created with plaintext), when `checkSnapshot.ok` is false (nothing uploaded); happy path calls `pack` once with a staging dir that, at that moment, contains `manifest.json`, `data.sqlite`, `user-data/...` and no `.env` or `secrets/` entries; with `includeSecrets` they are present; the staging dir is removed afterwards in success and in failure (spy on `rmrf`); `put` is called with the dated name on every destination; a secondary destination failure keeps `ok: true` and fills `failed`; retention removes only names from the plan; `planOnly` makes no fs or exec calls other than reading; the `CreateResult` and the state file contain no file contents and no recipient key material beyond its presence.
- [ ] **Step 2: Run to fail:** `npx vitest run tests/backup-create.test.ts`.
- [ ] **Step 3: Implement.** `scripts/backup.ts` flags: `--tick` (runs when due per `isDue` using `.backups/state.json`, then sets `next_run_at` with `pickRunTime`; reuses `QuietWindow` from Task 2), `--now`, `--plan`, `--status`. Notification: on failure or when the last success is more than 36 hours old, send a Telegram message via the Task 4 notifier ("backup failed: <short error>"); successes are silent unless `--now`. No scheduler lock is taken (the SQLite online backup is safe with live writers).
- [ ] **Step 4: Run to pass; `npx tsc --noEmit`.**
- [ ] **Step 5: Commit**
```bash
git add src/backup/create.ts src/backup/state.ts scripts/backup.ts tests/backup-create.test.ts package.json
git commit -m "feat(backup): encrypted scheduled backup pipeline with retention and CLI"
```

---

### Task 10: Restore, verification and the restore drill

**Files:**
- Create: `src/backup/restore.ts`, `scripts/restore.ts`
- Modify: `package.json` (script `"restore": "tsx scripts/restore.ts"`)
- Test: `tests/backup-restore.test.ts`

**Interfaces:**
```ts
export interface VerifyReport { ok: boolean; manifest: Manifest | null; problems: string[]; tables: Record<string, number>; integrity: string }
export interface RestoreDeps { exec: Exec; fs: { mkdtemp, exists, list, hash, copy, move, rmrf, mode }; checkSnapshot: (p: string) => SnapshotCheck;
  unpack: (a: { archivePath: string; identityPath: string; outDir: string }) => Promise<void>;   // real: age -d -i <identity> <archive> | tar -x -C outDir with path-traversal-safe flags
  lock: LockPort; now: () => Date }
// 1. Verify only. Never writes outside a fresh temp dir.
export async function verifyArchive(deps: RestoreDeps, a: { archivePath: string; identityPath: string }): Promise<VerifyReport>
// 2. Plan what an apply would do (pure given the listing).
export interface RestorePlanItem { archivePath: string; target: string; action: 'replace' | 'create' | 'skip-secret'; moveAsideTo: string | null }
export function planRestore(manifest: Manifest, root: string, exists: (p: string) => boolean, o: { withSecrets: boolean; stamp: string }): RestorePlanItem[]
// 3. Apply. Requires: verify ok, lock acquired, confirm === 'RESTORE <archive-basename>'.
export async function applyRestore(deps: RestoreDeps, a: { archivePath: string; identityPath: string; root: string; withSecrets: boolean; confirm: string }): Promise<{ moved: string[]; restored: string[] }>
// 4. Drill: verify plus compare to the live db table list; records last_drill_at in .backups/state.json
export async function drill(deps: RestoreDeps, a: { archivePath: string; identityPath: string; liveDbPath: string }): Promise<VerifyReport & { liveTableMissingInBackup: string[] }>
```

Rules:
- `verifyArchive` unpacks into a fresh `mkdtemp` dir (mode 700) and always removes it. Checks: `manifest.json` present and parseable; every file's sha256 matches (`verifyFiles`); no extra files; `data.sqlite` passes `checkSnapshot` (integrity `ok`); table counts equal the manifest's. Any archive member with an absolute path, `..`, or a link is a problem and aborts extraction (`tar` is run with `--no-same-owner` and extraction is followed by a walk that rejects symlinks).
- The identity (private key) file path comes only from the CLI argument `--identity`, never from `.env`. Doctor warns if an identity file looks to be inside the project root or `BACKUP_DIR` (file name pattern and `AGE-SECRET-KEY-` prefix check is done by reading only the first 16 bytes).
- `applyRestore`: default CLI mode is verify-only; apply needs `--apply --confirm "RESTORE <name>"`. It takes the run lock via the adapter (refuses if held) and requires that no MCP or Claude session is using the database (documented: stop sessions first; `tmux list-windows` is shown as a hint). Each existing target is moved aside to `<target>.pre-restore-<stamp>` (never deleted), the db is restored as `data.sqlite` with mode 600 and its `-wal`/`-shm` siblings moved aside too (a stale WAL next to a restored file corrupts it). Secrets are restored only with `--with-secrets` and only when present in the archive.
- Restores config files only for paths present in the manifest; never restores outside the project root; refuses archive `commit` metadata mismatch? No: it only prints the manifest `commit` as a hint ("this backup was taken at commit X; current HEAD is Y").

- [ ] **Step 1: Write failing tests** with fake ports and a real temp dir with synthetic files: a good archive verifies (unpack fake writes manifest, files and a real small SQLite file created in the test); a flipped byte in a staged file is reported as mismatched; a missing manifest is a problem; a path with `..` in the manifest is rejected before any copy; `planRestore` marks existing targets `replace` with a `moveAsideTo` and secrets `skip-secret` without `withSecrets`; `applyRestore` with a wrong confirm string throws before any move; with a held lock throws before any move; on success the old `data.sqlite` and `-wal` exist under `.pre-restore-<stamp>` names and the new file has mode 600; a failure midway (copy throws) moves the already-moved files back (assert final state equals the initial state); `drill` reports `liveTableMissingInBackup` when the backup lacks a live table and updates `last_drill_at`.
- [ ] **Step 2: Run to fail:** `npx vitest run tests/backup-restore.test.ts`.
- [ ] **Step 3: Implement.** `scripts/restore.ts` prints, in order: the manifest summary (created, commit, includes secrets, table counts), the verify result, and, only with `--apply`, the plan with each move-aside target before executing. Never prints file contents.
- [ ] **Step 4: Run to pass; `npx tsc --noEmit`.**
- [ ] **Step 5: Commit**
```bash
git add src/backup/restore.ts scripts/restore.ts tests/backup-restore.test.ts package.json
git commit -m "feat(backup): verified restore with move-aside, lock and restore drill"
```

---

### Task 11: Doctor checks

**Files:**
- Create: `src/platform/updateBackupChecks.ts`
- Modify: `scripts/doctor.ts` (append `updateBackupChecks` to the list passed to `runChecks`)
- Test: `tests/update-backup-checks.test.ts`

Use the plan 7A framework (`Check`, `DoctorContext`, `runChecks`). Each check receives only `ctx` (root, env, run, fs) and merges `.env` via `parseEnv` like the existing checks do. No check prints a value from `.env`, a key, or a database row.

| id | pass | warn | fail |
|---|---|---|---|
| `auto-update-config` | `AUTO_UPDATE` off (report "off"), or on and `problems` empty and the remote exists in `git remote` | on with `requireSigned=false`; on and remote missing | `loadUpdateConfig(...).problems` non-empty while enabled |
| `auto-update-state` | last result is `updated`/`noop`/`skipped`/`dry_run`/none; shows current short commit and last result | last result `rolled_back` (shows step); state says `in_progress` older than 1 hour is FAIL, see below | `rollback_failed` or an `in_progress` marker older than 60 minutes |
| `new-tools-not-allowed` | every tool of the detected set is in the local allow list | tools in the chosen set definition (`config/permission-sets.json`) missing from the allow list: list up to 5 names and "run setup to opt in" | settings JSON invalid |
| `backup-config` | configured, `age` installed (`age --version`), `BACKUP_DIR` exists with mode 700 | not configured ("no backup configured: set BACKUP_DIR and BACKUP_AGE_RECIPIENT"); `BACKUP_DIR` inside the project root (same disk, and `git clean -fdx` risk); `BACKUP_INCLUDE_SECRETS=true` (info that the archive then contains credentials); `BACKUP_RCLONE_REMOTE` set but `rclone` missing | recipient shaped like a private key; configured but `age` missing; `BACKUP_DIR` mode readable by others |
| `backup-freshness` | last backup under 36 hours old | no backup recorded yet; older than 36 hours | last error recorded and last success older than 7 days |
| `backup-drill` | drill within 90 days | never drilled; older than 90 days | none |
| `db-private` | `data.sqlite` mode is 600 or 640 stricter, or absent | none | group or world readable or writable ("chmod 600 data.sqlite") |
| `update-dirs-private` | `.update/` and `.backups/` mode 700 or absent | none | wider mode |

The spec requires the doctor to report "the current commit, whether `AUTO_UPDATE` is on, and the last update result": `auto-update-state`'s detail string carries all three (`commit abc123def456, AUTO_UPDATE on, last: updated 2026-10-14T05:10:00Z abc..def`).

- [ ] **Step 1: Write failing tests** with a fake `DoctorContext` (in-memory fs map, fake `run`): one test per row of the table, plus: `AUTO_UPDATE` unset passes `auto-update-config`; backup unconfigured is `warn` not `fail`; the recipient value and any `AGE-SECRET-KEY` text never appear in any `detail` or `fix` (assert on a recipient containing a recognizable marker); a crashing check (fs throws) is reported by `runChecks` as a fail with details withheld (existing behavior).
- [ ] **Step 2: Run to fail:** `npx vitest run tests/update-backup-checks.test.ts`.
- [ ] **Step 3: Implement.** The state files are read through `ctx.fs.read`; parse failures are `warn: state file unreadable`.
- [ ] **Step 4: Run to pass; full suite shows exactly the 5 known failures; `npm run doctor` runs (its result on the live machine will show warnings for unconfigured backup and the missing git remote; that is expected).**
- [ ] **Step 5: Commit**
```bash
git add src/platform/updateBackupChecks.ts scripts/doctor.ts tests/update-backup-checks.test.ts
git commit -m "feat(platform): doctor checks for auto-update, permission opt-in and backup"
```

---

### Task 12: `.env.example`, runbook and scheduler hand-off

**Files:**
- Modify: `.env.example`
- Create: `docs/backup-and-restore.md`
- Test: `tests/env-example-update-backup.test.ts`

- [ ] **Step 1: Write the failing test.** Reads `.env.example` and asserts: it contains each key `AUTO_UPDATE`, `AUTO_UPDATE_REMOTE`, `AUTO_UPDATE_BRANCH`, `AUTO_UPDATE_TAG_PATTERN`, `AUTO_UPDATE_REQUIRE_SIGNED`, `AUTO_UPDATE_SIGNERS_FILE`, `AUTO_UPDATE_REVIEW_PATHS`, `BACKUP_DIR`, `BACKUP_AGE_RECIPIENT`, `BACKUP_INCLUDE_SECRETS`, `BACKUP_RCLONE_REMOTE`, `BACKUP_RETAIN_DAILY`, `BACKUP_RETAIN_WEEKLY`, `BACKUP_RETAIN_MONTHLY`; `AUTO_UPDATE=false` and `BACKUP_INCLUDE_SECRETS=false` are the shipped values; no value looks like a key (`AGE-SECRET-KEY`, `age1` followed by 50 characters).
- [ ] **Step 2: Run to fail:** `npx vitest run tests/env-example-update-backup.test.ts`.
- [ ] **Step 3: Add the keys** (commented, with defaults) to `.env.example`, and write `docs/backup-and-restore.md` covering: what is and is not backed up and why (decision D8), generating the age key pair on a machine the owner controls (`age-keygen -o ~/jobber-backup.key`, store the file in a password manager and offline copy, put only the printed `age1...` public key into `BACKUP_AGE_RECIPIENT`), setting `BACKUP_DIR`, optional rclone (`rclone config`, Google Drive remote with `scope = drive.file`, `BACKUP_RCLONE_REMOTE=gdrive:jobber-backups`), the exact restore and drill commands, and the "restoring over live data" warnings. Also document, for plan 6D, the two scheduler entries: `npm run auto-update -- --tick` and `npm run backup -- --tick`, each safe to call every 10 to 15 minutes (cheap when not due, own state files).
- [ ] **Step 4: Run to pass.**
- [ ] **Step 5: Commit**
```bash
git add .env.example docs/backup-and-restore.md tests/env-example-update-backup.test.ts
git commit -m "docs(platform): env keys, backup runbook and scheduler hand-off for 7D"
```

**Documentation deferred until the owner checklist passes** (project preference, do not do earlier): a CLAUDE.md section "Auto-update and backup" with the commands, the `/status` line additions (current commit, last update result, last backup age), and BotFather command updates if `/update` and `/backup` Telegram commands are added later.

---

## Owner-only checklist (needs the owner's machine, keys or accounts; not for an unattended agent)

1. Install `age`: `brew install age` (and `rclone` only if mirroring to a cloud drive).
2. Generate the backup key pair: `age-keygen -o ~/jobber-backup.key`. Store the private key file in your password manager and on an offline medium, then remove it from the machine if you like. Copy the printed `age1...` public key into `.env` as `BACKUP_AGE_RECIPIENT`. Losing this private key means every backup is unreadable; there is no recovery.
3. Choose `BACKUP_DIR` outside the project, preferably on another disk or a synced-but-encrypted location; `chmod 700` it.
4. Decide `BACKUP_INCLUDE_SECRETS` (default false; see D8).
5. For updates: add the upstream remote (`git remote add upstream <url>` or rename `old-origin`), set `AUTO_UPDATE_REMOTE`/`AUTO_UPDATE_BRANCH`, create an `allowed_signers` file with the maintainer's SSH public keys (`git config gpg.ssh.allowedSignersFile` style) and set `AUTO_UPDATE_SIGNERS_FILE`; confirm the upstream really signs commits (`git log --show-signature -3`). If it does not, decide consciously whether to set `AUTO_UPDATE_REQUIRE_SIGNED=false` (doctor will warn).
6. Run `npm run backup -- --plan`, read the include and exclude lists, then `npm run backup -- --now`.
7. **Restore drill (do before trusting the backup):** `npm run restore -- <BACKUP_DIR>/<newest>.age --identity ~/jobber-backup.key` (verify only). Confirm the table counts and the "integrity ok" line. Repeat after any change to the scope. Calendar a recurrence every 90 days.
8. Run `npm run auto-update -- --dry-run`, read the plan (commit range, changed paths, whether it would be skipped and why). Then `npm run auto-update -- --now` once while you watch, and confirm the Telegram notification arrives with the commit range.
9. Force a failure on purpose to see a rollback: on a scratch clone, create a signed commit that breaks a test, point `AUTO_UPDATE_REMOTE` at it, run `--now`, and confirm HEAD returns to the previous commit and Telegram says `rolled_back` with the step.
10. Only after all of the above: set `AUTO_UPDATE=true`, and add the two scheduler entries from `docs/backup-and-restore.md` to plan 6D's scheduler.
11. Restart Claude sessions after an applied update (the updater never restarts them; MCP servers keep the old code until restart).

## Open risks

- **Lock module unverified:** plan 6D landed as a plan only; verify its lock when implementing. If the lock is advisory only (for example, a file nobody checks inside an already-running hunt), the update could swap code under a running hunt. Mitigation to verify in 6D: the `run` lock must be held (with heartbeat) by every hunt or wake for its whole duration.
- **Database is not rolled back with the code.** Migrations in `src/db.ts` are additive (`CREATE IF NOT EXISTS`, `ADD COLUMN`), so old code runs on a migrated database, but a future destructive migration would break the rollback. The pre-update snapshot (`.update/pre-update-<sha>.sqlite`) is the manual recovery. Rule for future migrations: additive only, or the update must refuse (add a manifest flag later).
- **Running processes keep old code.** After a successful update, MCP servers and open Claude sessions still run the old version until restarted; mixed old code and new data/config is possible for a while. The notification says so.
- **`npm ci` runs dependency install scripts** (needed for `better-sqlite3`, `patchright`). A compromised dependency in a signed commit's lockfile executes on the machine. The signature requirement is the control; `AUTO_UPDATE_REQUIRE_SIGNED=false` removes it.
- **Signed does not mean safe.** A compromised signer key lets an attacker run code with the owner's real accounts. Doctor cannot detect this. Keep the signer set minimal and review notifications (commit range) promptly.
- **Test gate is only as good as the suite.** The baseline allowlist can hide a new failure inside a file already listed (counts mitigate this). The suite cannot catch live behavior against LinkedIn, Gmail or ATS pages.
- **Restoring over live data.** `--apply` replaces the database and config. It moves existing files aside and requires the lock and a typed confirmation, but it cannot stop a Claude session that holds the database open from writing into the restored file. Stop all sessions first. Restoring a stale database can cause already-sent outreach to look unsent, risking duplicate sends: after any restore, run `/checkreplies`, and check the Gmail Sent folder against `outreach_queue` before the next hunt.
- **Key loss and key leak.** Lost private key: backups are unrecoverable. Leaked private key: all backups ever made are readable, including secrets if opted in; rotate the recipient and re-key by making new backups, and delete old archives everywhere (including the rclone remote).
- **Plaintext staging.** The database snapshot and staged files exist unencrypted in `.backups/.staging-*` (mode 700) for the duration of a run and are removed in `finally`; a crash can leave them behind. Doctor does not yet scan for leftovers; the runbook says to delete `.backups/.staging-*` after a crash.
- **Same-disk backups are not disaster recovery.** A default local `BACKUP_DIR` on the same disk only protects against corruption and bad updates. The rclone mirror (or an external disk) is the disaster-recovery path and is unverified live (rclone not installed here).
- **SSH-signature verification depends on git >= 2.34** and a correctly formatted `allowed_signers` file; a misconfigured file makes every commit read as unsigned, which fails safe (skip and notify).
- **Readonly WAL snapshot:** opening the live database readonly while writers are active needs write access to the `-shm` file; the helper falls back to a normal connection (never `openDb`, so no migration runs). Verify once live during checklist step 6.

## Self-review

- **Spec coverage:** Auto-update: env default false (T2), daily random time outside quiet hours (T2, T6), fast-forward only (T3, T5), skip on dirty, diverged, lock held, unsigned with notify (T3, T6), install, migrations on a copy, doctor, tests, rollback (T5), permission set untouched and new tools flagged (T5 fingerprint, T11 `new-tools-not-allowed`), ccgram untouched (T3 reserved paths, Global Constraints), Telegram notification with range and changelog (T4, T6), dry-run (T5, T6), state file with last good commit (T4), doctor reports commit, flag and last result (T11). Backup: online backup (T1, T9), scope and secrets exclusion with reasoning (T7, D8), encryption with owner-held key (T9, D7), retention (T8), restore with verification and drill (T10), destination abstraction with rclone path (T8), doctor warnings (T11), owner checklist and risks (above). Config and data hygiene: owner-only DB permissions checked (T11 `db-private`), backups never a raw copy (T1).
- **Placeholder scan:** none; the only assumption is the lock module (D1), isolated in one file.
- **Type consistency:** `Exec` (T1) is used by T3, T5, T8, T9, T10; `Notifier` (T4) by T5, T6, T9; `QuietWindow`/`Rng`/`pickRunTime`/`isDue` (T2) by T6 and T9; `LockPort` (T6) by T10; `BackupDestination` (T8) by T9; `Manifest` (T7) by T9, T10; `SnapshotCheck` (T1) by T9, T10; `Outcome` (T4) by T5, T6.
- **Review Focus coverage:** 1 to T3 and T5, 2 to T3, 3 to T6, 4 and 5 to T5, 6 to T1 and T5, 7 to T7 and T9, 8 to T10, 9 to T4, T9, T11, 10 to T2.
