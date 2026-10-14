# Backup, restore and auto-update runbook

This covers the encrypted backup, the restore drill, the auto-update job and how the
scheduler calls them. Settings live in `.env` (shipped defaults in `.env.example`).

## 1. What is backed up, and what is not

Each backup is one `age`-encrypted archive containing:

- a consistent snapshot of `data.sqlite` (an online SQLite backup, never a raw file copy),
- `user-data/` and `config/` (resume, answers, languages, fact gate, portals, regions, profiles);
  `config/` is top-level `*.json` files only,
- `.claude/settings.local.json` and `.claude/settings.local.managed.json`.

Never archived, wherever they sit: `*.pdf` at any depth (so PDFs under `user-data/` are not
backed up), `*.bak`, and SQLite WAL and journal files.

Secrets are excluded by default (decision D8): `secrets/` holds the Gmail OAuth token and the
LinkedIn and Naukri browser sessions, and `.env` is a separate path that is also excluded. A backup that can be read with the age key
alone would otherwise also hold every credential, so a leaked archive plus a leaked key would
hand over the accounts. What this means in practice: after a restore you sign in again
(Gmail auth, LinkedIn and Naukri session scripts) and re-create `.env`. Set
`BACKUP_INCLUDE_SECRETS=true` only if you accept that trade; the archive is then as sensitive as
the secrets themselves.

Run `npm run backup -- --plan` to print the exact include and exclude lists before trusting it.

## 2. One-time setup

1. Install age: `brew install age` (and `rclone` only for a cloud mirror).
2. Generate the key pair on a machine you control: `age-keygen -o ~/jobber-backup.key`.
   Store the file in a password manager and on an offline copy. Put only the printed public
   key (`age1<your-public-key>`) into `BACKUP_AGE_RECIPIENT`. Never put the private key in
   `.env` or in the project.
   **Losing the private key means every backup is unreadable. There is no recovery.**
3. Set `BACKUP_DIR` to a directory outside the project, ideally on another disk
   (a same-disk copy protects against corruption and bad updates, not disk loss).
   `chmod 700` it. It must not be inside `user-data`, `config` or `secrets`.
4. Optional mirror: run `rclone config`, create a Google Drive remote with
   `scope = drive.file`, then set `BACKUP_RCLONE_REMOTE=gdrive:jobber-backups`.
5. Retention defaults are `BACKUP_RETAIN_DAILY=7`, `BACKUP_RETAIN_WEEKLY=4`,
   `BACKUP_RETAIN_MONTHLY=6`.
6. Tighten permissions as `npm run doctor` suggests (run it yourself):
   `chmod 700 .backups .update` and `chmod 600 data.sqlite`.

## 3. Day-to-day commands

```
npm run backup -- --plan      # show what would be archived, writes nothing
npm run backup -- --now       # make a backup now
npm run backup -- --status    # last backup age and result
```

A crash can leave plaintext staging directories at `.backups/.staging-*`. Delete them by
hand after a crash; the next run also sweeps leftovers older than 24 hours.

`backup --tick` runs inline under the scheduler hook timeout `SCHEDULER_HOOK_TIMEOUT_SEC`
(default 120 s, max 3600). For a large database raise it: a timed-out run leaves its staging
directory until the 24 hour sweep and is retried 60 minutes later.

A `BACKUP_DIR` on exFAT, FAT or another filesystem without hard links works, but the archive is
then written by an exclusive copy instead of an atomic link, so a crash mid-copy can leave a
partial file under the final name; the checksum sidecar and `restore` verification catch it.

## 4. Restore, and the restore drill

Verify only (decrypts, checks the manifest and database integrity, prints table counts, changes
nothing):

```
npm run restore -- <BACKUP_DIR>/<archive>.age --identity ~/jobber-backup.key
```

Apply (replaces the database and config; needs the lock and a typed confirmation):

```
npm run restore -- <BACKUP_DIR>/<archive>.age --identity ~/jobber-backup.key --apply --confirm "RESTORE <name>"
```

`<name>` is the archive file name including `.age`.

**Restore drill:**

```
npm run restore -- <BACKUP_DIR>/<archive>.age --identity ~/jobber-backup.key --drill
```

Only `--drill` records `last_drill_at`, which doctor's backup-drill check reads; a verify-only
run without `--drill` does not satisfy doctor. The drill also reports live tables that are
missing from the backup. Run it before you rely on the backups, after any change to the scope,
and every 90 days. Confirm the table counts and the "integrity ok" line.

Warnings for `--apply`:

- It moves existing files aside and rolls back on failure, but it cannot stop a Claude session
  that holds the database open from writing into the restored file. Stop all sessions and the
  scheduler first.
- A backup contains `config/ccgram.pin.json` and `.claude/settings.local.json` (plus the
  managed settings file), so `--apply` writes the pin and the permission set from the backup
  (the old files are moved aside). Review both after a restore.
- Restoring a stale database can make already-sent outreach look unsent, which risks duplicate
  sends. After any restore run `/checkreplies` and compare the Gmail Sent folder with
  `outreach_queue` before the next hunt.
- A leaked private key makes every archive ever made readable. Rotate the recipient, make new
  backups and delete the old archives everywhere, including the rclone remote.

## 5. Auto-update

Off by default (`AUTO_UPDATE=false`). Before enabling:

- `AUTO_UPDATE_REMOTE` and `AUTO_UPDATE_BRANCH` point at the real upstream (default `origin`
  and `main`); `AUTO_UPDATE_TAG_PATTERN` is optional.
- Signed commits are required. Create an `allowed_signers` file with the maintainer SSH public
  keys, set `AUTO_UPDATE_SIGNERS_FILE`, and confirm upstream really signs
  (`git log --show-signature -3`). If it does not, the owner needs a signed upstream or must
  consciously set `AUTO_UPDATE_REQUIRE_SIGNED=false` (doctor warns). Git 2.34 or newer is needed.
- For SSH-signed upstream commits the owner must run `git config gpg.format ssh` in the
  checkout: the updater only passes `gpg.ssh.allowedSignersFile`, so without it every commit
  reads as unsigned and all updates are skipped.

Behaviour to know:

- Only fast-forwards are applied. Diverged history or an unsigned commit means skip and
  notify. A `--tick` that finds the lock held returns skipped without notifying; only
  `--now` and `--dry-run` notify about it.
- Untracked files in the checkout count as a dirty tree, so the update is skipped. Clean or
  ignore them.
- Changes touching reserved paths (`AUTO_UPDATE_REVIEW_PATHS`, by default `.claude/settings.json`,
  `.claude/hooks/`, `.githooks/`, `config/ccgram.pin.json`, `scripts/ccgram/`) force a manual
  review: the update is not applied.
- Any failed step (merge, install, migrate-copy, doctor, tests, permissions fingerprint) rolls the code back to the previous
  commit. The database is not rolled back: migrations are additive so old code runs on a migrated
  database, and the pre-update snapshot in `.update/` is the manual recovery.
- The updater never restarts anything. Restart Claude sessions and MCP servers after an applied
  update, otherwise they keep running the old code.

```
npm run auto-update -- --dry-run   # print the plan (range, changed paths, skip reason), change nothing
npm run auto-update -- --now       # apply now, watch the Telegram notice
npm run auto-update -- --status    # last result and last good commit
```

### Stuck update / rollback_failed

How to tell: doctor's `auto-update: state` check FAILs, and
`npm run auto-update -- --status` shows an `in progress:` line or `last result: rollback_failed`.
Updates stay skipped (`in-progress-marker`) until you clear this by hand.

What to check:

- `git status` and `git log -1`: is the checkout clean and on a sane commit?
- Compare `git log -1` with `last good commit` from `--status` (`last_good_commit` in
  `.update/state.json`).
- The pre-update database snapshot `.update/pre-update-<sha>.sqlite` is the recovery copy if the
  database looks wrong.

How to recover:

1. Reset the checkout to the last good commit by hand (`git reset --hard <last_good_commit>`
   after confirming it is the one you want).
2. `npm ci`.
3. `npm run doctor` and fix what it reports.
4. Once the checkout is verified, delete `.update/state.json` to remove the `in_progress` field.
   The next tick then evaluates updates again.

## 6. Scheduler hand-off

The 6D scheduler already ships the tick hooks (`src/scheduler/hooks.ts`); nothing needs adding
to it. After each wake that was not killed and is outside quiet hours, throttled to once per
`HOOK_MIN_INTERVAL_MIN` (default 60), it runs:

- `npm run auto-update -- --tick` when `AUTO_UPDATE=true`,
- `npm run backup -- --tick` when `BACKUP_ENABLED=true`.

Details:

- The two env flags are the only switches. A hook also runs only if `scripts/auto-update.ts`
  or `scripts/backup.ts` and the matching `package.json` script exist. The hook gives the child
  only `PATH`, `HOME`, `TZ`, `AUTO_UPDATE` and `BACKUP_ENABLED`; the scripts read `.env` themselves.
- The hook timeout is `SCHEDULER_HOOK_TIMEOUT_SEC` (default 120, clamped to 30..3600) and the
  throttle is `HOOK_MIN_INTERVAL_MIN` (default 60, range 1..1440); an out-of-range value falls
  back to the default. Because an update can take longer than the timeout, the auto-update tick
  hands a due apply to a detached child and returns.
- Only the auto-update apply and `restore --apply` take the shared lock
  `<project>/.jobber/run.lock`, the same one wakes hold, so they never overlap a running wake.
  The backup does not take the lock: it is safe with live writers because it uses the SQLite
  online backup.
- A tick that is not due is cheap and each job keeps its own state file.
- A failing tick raises a `scheduler <id> tick failed` warning and never stops the scheduler.

## 7. Known limits

- The rclone mirror is unverified live; treat an external disk as the tested path.
- Backups on the same disk are not disaster recovery.
- Signed does not mean safe: a compromised signer key can run code with your real accounts.
  Keep the signer set minimal and read the update notices.
