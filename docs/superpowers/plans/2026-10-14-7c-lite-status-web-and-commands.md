# Plan 7C-lite: status snapshot, custom status commands, local web page with chat box

> For agentic workers: use superpowers:subagent-driven-development, model `sonnet` for every subagent, one task at a time, review gate after each task. Spec authority: `docs/superpowers/specs/2026-10-14-platform-sessions-dashboard-setup-requirements.md` (dashboard and sessions sections). This plan is the small first slice of its 7C dashboard; the full dashboard (history charts, per-company views) stays plan 7C.

**Goal:** the owner can (1) type `/limits`, `/working`, `/health` in Telegram (through ccgram) and get read-only status, (2) open `http://127.0.0.1:8787` and see the same status live, and (3) send a message to the running Claude session from that page, like Telegram does.

**Branch:** `platform-7c-lite` (already created from `main`). Commit per task with explicit paths, never `git add -A`, never `--no-verify`, never push.

**Binding rules (same as plans 6A/7A):**
- Never read, print or commit anything under `user-data/`, `secrets/`, `.env*`, `data.sqlite`. Tests use `JOBAPPLIER_DB=:memory:` and `user-data.example` (vitest config already sets both). Do not rename `JOBAPPLIER_*` env vars.
- Tests use injected fakes for tmux (the `Run` type in `src/platform/tmux.ts`); never start a real tmux server, never touch the real Telegram, never open the real database file.
- The web page binds `127.0.0.1` only. No external exposure, no tunnels, no CORS headers.
- No live LinkedIn, Naukri, Gmail action anywhere in this plan.
- Test baseline: `npx tsc -p . --noEmit` clean; `npx vitest run` has exactly 5 known failures (4 in `tests/renderChecked.test.ts`, 1 in `tests/resume.test.ts`, Playwright browser missing). Anything else failing is yours.
- Match surrounding code style (file header comment `// src/...`, ESM `.js` import suffixes, vitest).

## Decisions (treat as accepted)

| Decision | Choice | Cost if wrong |
|---|---|---|
| Web stack | `node:http` only, no framework, one inline page | Low: swap later |
| Auth | Required `WEB_TOKEN` (min 24 chars), login form sets HttpOnly SameSite=Strict cookie; refuse to start without it | Medium if weak token |
| Chat target | tmux session `WEB_TMUX_SESSION` (default `ccgram`), window `WEB_TMUX_WINDOW` (default `JobApplier`) | Low: env |
| Chat input | plain text only, max 2000 chars, no control characters, never starts with `!`; a leading `/` is allowed only for the status commands in `STATUS_COMMANDS` | High if loosened: the pane is a live Claude session |
| Status commands | new names `/limits`, `/working`, `/health`; existing `/status` is kept as is | Low |
| Status data | read-only snapshot from SQLite opened `readonly`, plus tmux window list | Low |

---

## Task 1: Status snapshot module

**Files:** create `src/status/snapshot.ts`, `tests/status-snapshot.test.ts`.

Pure, read-only. Signature:

```ts
// src/status/snapshot.ts
import type BetterSqlite3 from 'better-sqlite3';
import type { OutreachConfig } from '../outreach/config.js';
import type { CeilingStatus, LimitKey } from '../outreach/limits.js';

export interface Snapshot {
  generatedAt: string;
  ceilings: Record<LimitKey, CeilingStatus>;
  dailyCounters: { key: string; count: number }[];   // today's rows from daily_counters
  halts: { platform: string; reason: string; setAt: string }[]; // cleared_at IS NULL only
  queue: { status: string; count: number }[];        // outreach_queue grouped by status
  funnel: { discovered: number; matched: number; contacted: number; replied: number; interview: number; offer: number };
  lastSend: { kind: string; at: string } | null;    // latest sent touch or email, null if none
}

export function buildSnapshot(db: BetterSqlite3.Database, cfg: OutreachConfig, now: Date): Snapshot;
```

Steps:
1. Read `src/outreach/limits.ts` (`ceilings`, halt helpers), `src/funnel.ts` (`funnelStats`), and the `daily_counters` and `outreach_queue` table definitions in `src/db.ts` first. Reuse `ceilings()` and `funnelStats()`; do not re-implement them. Map `funnelStats` output to the `funnel` field by reading its `Funnel` interface.
2. Tolerate tables that do not exist yet (a fresh or older database): each section falls back to an empty value instead of throwing. Call `migrateOutreachTables` is NOT allowed here (read-only); catch the "no such table" error per section.
3. Write tests first, against an in-memory db created with `openDb(':memory:')`: empty db gives zeroed snapshot; a halted platform appears in `halts`; a cleared halt does not; ceilings reflect recorded `rate_events`; queue grouped counts; missing table falls back.
4. Run `npx vitest run tests/status-snapshot.test.ts` and `npx tsc -p . --noEmit`.
5. Commit: `feat(status): read-only snapshot of limits, halts, queue and funnel`.

## Task 2: Status CLI (text output for commands and scripts)

**Files:** create `src/status/render.ts`, `scripts/status.ts`, `tests/status-render.test.ts`; modify `package.json` (add script `"status": "tsx scripts/status.ts"`).

1. `src/status/render.ts` exports `renderLimits(s)`, `renderWorking(s)`, `renderHealth(s, windows)` returning plain text (no markdown tables, short lines, phone readable):
   - limits: one line per ceiling `linkedin_invite 12/100 per week`, then daily counters, then halts or `no halts`.
   - working: queue counts by status, `last send: <kind> <time IST>` or `no sends yet`, funnel line `discovered N -> matched N -> contacted N -> replied N -> interview N -> offer N`.
   - health: tmux windows for the configured session (name, command, active), halts, and the line `doctor: run npm run doctor`.
   Times shown in Asia/Kolkata. All values come from the snapshot, nothing else.
2. `scripts/status.ts <limits|working|health|json>`: opens the database with `new Database(dbPath(), { readonly: true, fileMustExist: true })` (import `dbPath` from `src/dbPath.ts`), loads `loadOutreachConfig()`, builds the snapshot, prints. Unknown subcommand prints usage and exits 2. A missing database prints `no database yet` and exits 0. For `health` it also calls `listWindows(defaultRun, session)` with the session from `WEB_TMUX_SESSION` (default `ccgram`).
3. Tests (render only, no process spawn): fixed `Snapshot` literal in, exact expected strings out, including the empty and halted cases.
4. Commit: `feat(status): text renderers and status CLI`.

## Task 3: Custom commands for ccgram / Claude

**Files:** create `.claude/commands/limits.md`, `.claude/commands/working.md`, `.claude/commands/health.md`; modify `config/permission-sets.json`, `CLAUDE.md`; create `tests/status-commands.test.ts`.

1. Each command file is front-matter with `description` and `allowed-tools: Bash(npx tsx scripts/status.ts limits:*)` (respectively `working`, `health`), and a body that says: run exactly that one command, print its output unchanged, do nothing else, take no other action. Match the format of the existing files in `.claude/commands/`.
2. Read `config/permission-sets.json` and `src/platform/permissions.ts` first. Add the three exact `Bash(npx tsx scripts/status.ts <sub>)` allow entries to the `read_only` set (and let the larger sets inherit however they already do; do not duplicate if they extend `read_only`). Do not add a wildcard.
3. Add the three commands to the CLAUDE.md Commands table and to the BotFather command list in the same file (the file requires keeping them in step). Edit only those two places.
4. Test: each command file exists, names only its own script call in `allowed-tools`, and the permission set contains exactly those three new entries and no `scripts/status.ts:*` wildcard. Existing `tests/platform-permissions*.test.ts` must still pass.
5. Commit: `feat(status): /limits /working /health commands and permission entries`.

## Task 4: tmux send helper

**Files:** modify `src/platform/tmux.ts`, `tests/platform-tmux.test.ts`.

1. Add `sendText(run, session, window, text)`:
   - `assertName(session)`, `assertName(window)`.
   - Reject (throw) when: empty after trim, longer than 2000 characters, contains any control character (`/[\u0000-\u001f\u007f]/`, which includes newline and tab), or starts with `!`.
   - Call `run('tmux', ['send-keys', '-t', `=${session}:=${window}`, '-l', '--', text])`, then `run('tmux', ['send-keys', '-t', target, 'Enter'])`. Literal mode (`-l`) and the `--` terminator are required so the text can never be read as a tmux key name or option. Throw if either call returns non-zero.
2. Tests first, with `fakeRun`: exact argv for both calls; rejects each of empty, 2001 chars, `\n`, `\x1b`, leading `!`, bad session/window names; text such as `; rm -rf ~` and `$(x)` is passed only as one literal argv element.
3. Commit: `feat(platform): tmux sendText with strict input rules`.

## Task 5: Local web server

**Files:** create `src/web/server.ts`, `src/web/page.ts`, `tests/web-server.test.ts`.

`createWebServer(deps)` returns a `node:http` server and takes injected dependencies so tests need no tmux or database file:

```ts
export interface WebDeps {
  token: string;                         // validated by caller, length >= 24
  port: number;
  getSnapshot: () => Promise<Snapshot>;
  capture: () => Promise<string>;        // pane text
  send: (text: string) => Promise<void>; // calls sendText
  now?: () => number;
}
```

Requirements, each with a test:
1. Binds only `127.0.0.1`. Rejects (421) any request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding defence).
2. `POST /login` with form field `token`: constant-time compare (`crypto.timingSafeEqual` on equal-length digests); success sets cookie `jobber_session=<random 32 byte hex>; HttpOnly; SameSite=Strict; Path=/`, kept in an in-memory set (max 10, oldest dropped); failure returns 401 and counts toward a lockout of 5 failures per 10 minutes (then 429).
3. Every route except `GET /` (login form) and `POST /login` requires a valid cookie, else 401.
4. `GET /api/status` returns the snapshot JSON. `GET /api/pane` returns `{ text }` where text is the last 40 lines passed through `redactSecrets` (below).
5. `POST /api/send` JSON `{ text }`: body cap 4096 bytes (413 over), requires `Origin` header equal to the page origin (403 otherwise), `Content-Type: application/json`, at most one send per 2 seconds (429), then validates with the same rules as `sendText` before calling `deps.send`. A text starting with `/` is allowed only if the command word is in `STATUS_COMMANDS = ['limits','working','health','status']`; any other slash command is 400. Returns `{ ok: true }`.
6. `redactSecrets(text)`: replace secret shapes with `[redacted]`. Reuse the secret-shape patterns from `src/safety/outputGate.ts` (export a small `SECRET_SHAPES` or `redactSecrets` from there if not exported yet; do not copy-paste the regexes). Also redact any line containing the literal `WEB_TOKEN`.
7. Page (`src/web/page.ts`): one HTML string, system fonts, light and dark via `prefers-color-scheme`, phone width friendly. Sections: Limits, Working, Health, Live pane (monospace, pre-wrap), a text box and Send button. One inline script with a nonce; polls `/api/status` and `/api/pane` every 5 s; renders ONLY with `textContent`, never `innerHTML`. Response headers on every response: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-<n>'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.
8. Tests use `server.listen(0, '127.0.0.1')` on an ephemeral port with `fetch`, covering: wrong Host 421; no cookie 401; wrong token 401 and lockout 429; good login then status 200; send with bad Origin 403; send over 4096 bytes 413; send `!ls` 400; send `/login-as-admin` 400; send `/limits` reaches `deps.send` once; second send within 2 s 429; pane output has a planted `sk-`-style secret redacted; the page HTML contains no `innerHTML`.
9. Commit: `feat(web): local authenticated status page with chat box`.

## Task 6: Runner script, env keys, doctor check, docs

**Files:** create `scripts/web.ts`; modify `package.json` (add `"web": "tsx scripts/web.ts"`), `.env.example` (append only), `src/platform/checks.ts` and its test (add one check), `README.md` (short section).

1. `scripts/web.ts`: reads `WEB_TOKEN`, `WEB_PORT` (default 8787), `WEB_TMUX_SESSION` (default `ccgram`), `WEB_TMUX_WINDOW` (default `JobApplier`). Refuses to start (prints why, exit 1) when `WEB_TOKEN` is missing or shorter than 24 characters, or the port is not an integer 1024-65535. Wires deps: snapshot via the readonly db from Task 2, capture via `capture(defaultRun, ...)`, send via `sendText(defaultRun, ...)`. Prints `http://127.0.0.1:<port>` and nothing secret.
2. `.env.example`: append `WEB_TOKEN=` (comment: generate with `openssl rand -hex 24`), `WEB_PORT=8787`, `WEB_TMUX_SESSION=ccgram`, `WEB_TMUX_WINDOW=JobApplier`. Append only, do not overwrite.
3. Doctor: add one check `web` that is `pass` when `WEB_TOKEN` is unset (feature off, say so), `fail` when set but shorter than 24 characters, `pass` otherwise. It never prints the token. Follow the existing check shape in `src/platform/checks.ts` and test it the way `tests/platform-doctor.test.ts` tests the others.
4. README: how to start (`npm run web`), the one-line warning that the send box controls a live Claude session so keep the permission set at `read_only` unless needed, and that the page is localhost only (use an SSH tunnel from another machine, never open the port).
5. Commit: `feat(web): runner script, env keys, doctor check, docs`.

## Task 7: Telegram bot branding (docs only, no ccgram patching, no Telegram calls)

Owner wants the bot's start screen to say "Jobber, built by Rahat" with a link to https://github.com/rahatsayyed/jobber instead of "ccgram".

**Files:** create `docs/telegram-branding.md`; modify `docs/superpowers/specs/2026-10-14-ccgram-review.md` only by appending a short "Branding" section.

1. Find out, from web pages only (GitHub `alexei-led/ccgram` at tag v4.16.0, its docs and README; do not install, execute or read the installed copy), where the `/start` greeting text and the bot's visible name come from, and whether any env var or config file changes them. Record the finding (file, setting name, or "hard-coded") in the review doc's Branding section. Do not patch, fork or wrap ccgram.
2. Write `docs/telegram-branding.md` with exact text the owner pastes into BotFather, nothing else:
   - `/setname`: `Jobber`
   - `/setabouttext` (max 120 characters): `Jobber: autonomous job-hunting agent, built by Rahat. https://github.com/rahatsayyed/jobber`
   - `/setdescription` (max 512 characters, shown on the empty chat screen before Start): `Jobber finds roles, tailors resumes and handles outreach within strict limits. Built by Rahat. Source: https://github.com/rahatsayyed/jobber`
   - `/setcommands`: the full list from the CLAUDE.md "Setting up Telegram slash commands" block, plus `limits`, `working`, `health` with one-line descriptions.
   - A note that Telegram renders URLs as tappable links in these fields but does not support HTML or Markdown hyperlinks there, so the visible text is the URL.
   - A note that the greeting message ccgram sends after `/start` stays whatever ccgram hard-codes unless step 1 found a setting; if it is hard-coded, say so plainly and list the two options (accept it, or patch ccgram in a private fork, owner's call) without choosing.
3. Verify the character limits with a small test in `tests/telegram-branding.test.ts` that reads the doc and asserts the about text is at most 120 characters, the description at most 512, and that the GitHub URL appears.
4. Commit: `docs(platform): Telegram bot branding text and ccgram greeting findings`.

## Task 8: Final checks (controller, not a subagent)

1. `npx tsc -p . --noEmit` clean; `npx vitest run` shows only the 5 baseline failures.
2. `git grep -n innerHTML src/web` returns nothing; `git grep -n "0.0.0.0" src scripts` returns nothing.
3. Write `.superpowers/sdd/7c-lite-report.md`: tasks with SHAs, test counts, rulings with cost-if-wrong, deferred minors.

## Owner-only after the build

1. Set `WEB_TOKEN` in `.env` (`openssl rand -hex 24`), run `npm run web`, open the URL, log in.
2. Send `/health` from the page and confirm the Claude window answers; send `/limits` from Telegram through ccgram.
3. Optional: add `limits`, `working`, `health` to the BotFather command list.
4. Decide whether to rename the default window name when the on-disk directory is renamed to `jobber`.
