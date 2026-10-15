# Plan 8C: dashboard simple login (local access token by default, optional Google sign-in on the Gmail OAuth client)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per project preference, dispatch subagents with `model: sonnet`, one task at a time, review gate after each task.

**Goal:** the owner gets a dashboard login that works in under a minute with nothing but the machine itself: setup (or `npm run dashboard -- token`) generates a random access token, prints a one-time URL, and the browser trades it for the existing session cookie. Google sign-in becomes an optional upgrade that reuses the Gmail OAuth client the owner already created (no second Google Cloud client). The full OpenID Connect path from plan 7C stays, selected by `WEB_AUTH_MODE=oidc`, and nobody who is on OIDC today is broken.

**Architecture:** one new setting, `WEB_AUTH_MODE` = `token` | `google_desktop` | `oidc`. All three end in the same place: `createSession` in `src/dash/sessions.ts` (same cookie flags, CSRF, idle and absolute expiry, three-session cap, throttle, audit log). Only the proof of identity differs. `token`: a 32-byte base64url token, stored only as a SHA-256 hash in the auth sqlite, verified with `timingSafeEqual`, delivered by URL fragment or a paste form and submitted by `POST /auth/token` (never a query string). `google_desktop`: the existing `createOidc` client (`src/dash/oidc.ts`, unchanged) fed with the client id and secret from the Desktop-type keys file (`GMAIL_OAUTH_PATH`) and a loopback redirect; identity rules (TOFU `sub` pin plus email) are the same `evaluateLogin` as today. `oidc`: untouched. The auth store gains one additive table; no existing table changes.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), vitest, `node:http`, `node:crypto`, `better-sqlite3`, `jose` (already a dependency, used only by the OIDC path), plain ES modules for the frontend. No new dependency.

**Builds on:** `docs/superpowers/plans/2026-10-14-7c-dashboard-v1.md` (merged; this plan modifies its auth, server, runner, setup step and doctor check) and `docs/superpowers/plans/2026-10-15-8b-platform-operators-and-layout-memory.md`. **This plan merges after plan 8B.** 8B edits `src/platform/checks.ts`, `src/platform/doctor.ts` and the docs; Tasks 9 to 11 here touch the same files, so cut the 8C branch from main after 8B is merged and rebase before Task 9. Nothing in Tasks 1 to 8 needs 8B.

**Spec:** `docs/superpowers/specs/2026-10-14-platform-sessions-dashboard-setup-requirements.md` (section "Dashboard", single allowed account, loopback default, read-only) stays binding. Format follows `2026-10-15-8a-wiring-and-legacy-removal.md`.

## What this plan replaces from 7C

| 7C piece | In plan 8C |
|---|---|
| OIDC sign-in is mandatory and the only login (`docs/dashboard-exposure.md` section 2, wizard step asks for a client id and secret, doctor `dashboard-login` requires `WEB_OIDC_*`) | Default is the local access token. OIDC is one of three modes. The wizard asks nothing for the default; the doctor judges the active mode only. |
| `validateRunnerConfig` always requires `WEB_OIDC_CLIENT_ID`, `WEB_OIDC_CLIENT_SECRET`, `WEB_OIDC_REDIRECT_URI` and an allowed account | Those rules apply only when the effective mode is `oidc` (or `google_desktop` for the account rule). Token mode needs none of them. |
| `scripts/web.ts` always builds `createOidc` and calls discovery at start | Built only for `google_desktop` and `oidc`. Token mode makes no outbound network call at all. |
| `reauth` returns `/auth/login?reauth=1` | In token mode it points at the login view (`/#/login?reauth=1`) and `POST /auth/token` refreshes the session's `auth_at`. |
| Everything else (sessions, CSRF, Host and Origin checks, security headers, read-only data, chat confirm, `cleanText`, panels) | Kept as is. |

## Global Constraints

- **Branch:** `plans-8cd` worktree plan; the build branch is cut from main after 8B is merged. Commit per task with explicit paths, never `git add -A`, never `--no-verify`, never push.
- Never read, print, write or commit `user-data/`, `secrets/`, `.env*` (except `.env.example`, which is committed), `.dashboard/`, `data.sqlite`. Tests use temp directories (`fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-'))`), `openAuthStore` on a temp path and the hermetic fixture `tests/fixtures/dash/gcp-oauth.desktop.json` (invented values, see Task 1). **No test, and no step in this plan, reads `secrets/gcp-oauth.keys.json`.** Only the owner's live checks touch the real file, and only through the running app.
- No network. Tests inject `fetch`, clock and randomness; no test contacts Google. `npm install` is not needed and not allowed.
- The access token never appears in: a URL query string, a log line, an audit row, an error message, `/api/status`, `/api/config`, `/api/audit`, `/api/session`, a thrown exception, `process.argv`, a child environment or `.env`. The CLI prints it exactly once, to a TTY, on `token` and `rotate`.
- Compare every secret-derived value with `timingSafeEqual` over equal-length digests (the pattern already used in `src/dash/sessions.ts` and `src/web/server.ts`).
- Fail closed: an unknown `WEB_AUTH_MODE` value, a token mode with no stored token, a `google_desktop` mode with an unreadable or wrong-shape keys file, or a token login on a non-loopback bind without TLS from a trusted proxy refuses to log anyone in (the server may start and say so, or refuse to start where this plan says so).
- Read-only dashboard guarantee unchanged: no new route touches the data database. The only new writes are to the auth sqlite (`access_token`, `sessions`, `login_attempts`, `audit_log`).
- Do not weaken or remove the OIDC code path, its tests (`tests/dash-oidc.test.ts`, the OIDC cases of `tests/web-server.test.ts`) or the pinned-account semantics. A change that makes an OIDC test fail is wrong.
- `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` stay forbidden in `src/web/**` (`tests/web-frontend-lint.test.ts` greps).
- Do not edit `CLAUDE.md` or `README.md` before Task 11 (project preference: batch doc edits). Agent, config and `.env.example` changes ARE behaviour and go in the task that changes behaviour.
- **Test baseline before and after EVERY task:** `npx tsc -p . --noEmit` clean; `npx vitest run` shows exactly the 5 known failures (4 in `tests/renderChecked.test.ts`, 1 in `tests/resume.test.ts`) and nothing else.
- Match surrounding style: file header comment `// src/...`, `.js` import suffixes, tests in `tests/*.test.ts`, one file with `npx vitest run <file>`.

## Review Focus

1. **Token handling (Tasks 3, 4, 6):** hash only at rest, constant-time compare including when no token is stored, never in a query string, never in a log or audit row, one-time print, rotation revokes every session.
2. **Remote-bind refusal (Tasks 2, 4):** token login is accepted only over loopback with no forwarding headers, or over a request the trusted proxy marked https. Read the table test, not the prose.
3. **Same session machinery (Tasks 4, 7):** the three modes create sessions through `createSession` only; no second cookie, no second CSRF scheme, no bypass of `checkLogin`/`recordLogin`.
4. **Desktop-client redirect uncertainty (Tasks 1, 7):** the plan never claims Google accepts the redirect path; it ships a selectable shape, a URL-printing live check and a documented fallback.
5. **Migration (Task 8):** an `.env` with `WEB_OIDC_*` set and no `WEB_AUTH_MODE` keeps behaving exactly as before, including its audit trail and pinned account.
6. **Wizard secrecy (Task 9):** the token travels from the CLI child straight to the terminal; the wizard process never holds it.
7. **Doctor honesty (Task 10):** the check judges the active mode, says what is unverified, and never prints a secret or a hash.

## Decisions (accepted here, with cost if wrong)

| # | Decision | Cost if wrong |
|---|---|---|
| D1 | Default `WEB_AUTH_MODE=token`. When the variable is unset: if `WEB_OIDC_CLIENT_ID` and `WEB_OIDC_CLIENT_SECRET` are both non-empty the effective mode is `oidc` (no break for existing owners, doctor warns "implicit, set WEB_AUTH_MODE=oidc"); otherwise `token`. | An owner who half-configured OIDC and never finished lands in `oidc` and sees OIDC config errors, not a token prompt. They set `WEB_AUTH_MODE=token`. Low. |
| D2 | Store only `SHA-256(token)` in the auth sqlite (`access_token` table), not the token in `.env` (`DASHBOARD_TOKEN`). The token has 256 bits of entropy, so a fast hash is enough (no scrypt needed). Print once, `rotate` replaces it. | The owner who loses the token must rotate (one command) instead of reading it from `.env`. Chosen on purpose: `.env` is parsed by every launcher and copied into allowlisted child environments, backups and tmux panes; a hash in a 0600 file under a 0700 directory is not. Low. |
| D3 | Delivery is the URL fragment `http://127.0.0.1:<port>/#token=<token>` (the fragment is never sent to the server, not logged by it, not sent in `Referer`) or paste into the `/login` form. The page JS removes the fragment with `history.replaceState` before the POST and sends the token in a JSON body to `POST /auth/token`. | The token sits in the terminal scrollback and the browser history until the fragment is stripped (the replaceState call removes it from the visible URL; history entry may keep it in some browsers). Mitigation: it is single-purpose, rotatable, and printing needs a TTY. Low to medium. |
| D4 | Token login on a non-loopback bind is refused unless the request itself is https via a trusted proxy (`WEB_TRUST_PROXY=true`, `x-forwarded-proto: https`) AND `WEB_ALLOWED_HOSTS` is non-empty. Startup: `WEB_AUTH_MODE=token` with a non-loopback `WEB_BIND` and `WEB_TRUST_PROXY` not true is a config error (server does not start). Over an SSH tunnel the bind stays loopback, so the tunnel works unchanged. | A bearer token over plain http on a LAN is replayable by anyone on the path. The refusal costs LAN users a proxy or a tunnel. Intended. |
| D5 | Google mode reuses the Gmail Desktop client. Redirect is the loopback shape `http://127.0.0.1:<WEB_PORT>/auth/callback` by default; `WEB_GOOGLE_REDIRECT_SHAPE=root` switches to `http://127.0.0.1:<WEB_PORT>/` (path `/`). Whether Google accepts a non-root path for a Desktop client is UNVERIFIED (Task 1, owner check L2). | If neither shape is accepted, `google_desktop` cannot be used; fallback is a dedicated Web client in `oidc` mode (today's setup), documented in Task 11. Medium, contained. |
| D6 | In `google_desktop` mode the same pinned-account semantics apply: `DASHBOARD_ALLOWED_EMAIL` (or `npm run dashboard -- allow`) plus trust-on-first-use `sub` pin, `email_verified` required, via the existing `evaluateLogin`. | None new. |
| D7 | Token mode has no per-person identity: the token holder IS the one allowed owner. `allowed_account` is not required and not consulted. Sessions are not tied to an email. | Someone who obtains the token has full dashboard access, same as someone who gets the owner's Google session in OIDC mode. Rotation and the 3-session cap bound it. Low. |
| D8 | A mode switch (`token` to `oidc`, or a rotate) revokes all existing sessions (`UPDATE sessions SET revoked_at`), same as `setAllowedEmail` does today. | One extra sign-in after switching. Low. |
| D9 | `google_desktop` reads the keys file at start only for `client_id` and `client_secret` (the `installed` object). The secret is added to the redaction literal list. A Desktop client "secret" is not confidential in Google's model, but this project still treats it as one. | None. |
| D10 | No new daily counter or rate limit: token attempts use the existing `login_attempts` throttle (10 per IP per 10 min lock 15 min, 20 global per hour lock 60 min). | A patient attacker is limited to about 20 guesses an hour against a 256-bit space. Negligible. |

## Unverified (stated plainly)

- That Google accepts a redirect URI with path `/auth/callback` (or any path) for a Desktop-type OAuth client. Google documents loopback redirects for installed apps (`http://127.0.0.1:<port>` and `http://localhost:<port>`, any port); this plan could not confirm path handling offline. Task 1 checks everything checkable without network; owner check L2 is the real test.
- That the Gmail client's consent screen (testing mode, owner as test user) allows the extra scopes `openid email` without re-review. They are non-sensitive scopes; unverified live.
- That the Desktop client works with a confidential-style token request (secret in the body) from the dashboard process. Google's documentation says Desktop clients receive a client secret for the token exchange; unverified live.
- That PKCE S256 is accepted for the Desktop client at the Google token endpoint (it is for Web clients today).
- Browser behaviour of `history.replaceState` removing a fragment from session history in every browser (owner check L1 covers Safari and Chrome only).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/dash/desktopClient.ts` (new) | Parse and validate a Desktop keys file object; build candidate redirect URIs and the authorization URL shape for the live check | 1 |
| `tests/fixtures/dash/gcp-oauth.desktop.json` (new) | Invented Desktop-type keys file (`installed`), plus `...web.json` wrong-type fixture | 1 |
| `tests/dash-desktop-client.test.ts` (new) | Shape and redirect tests | 1 |
| `src/web/env.ts` (modify) | `WEB_AUTH_MODE`, effective-mode resolution, per-mode validation, remote-bind rule, Google keys path and redirect shape | 2 |
| `src/dash/accessToken.ts` (new) | Generate, hash, store, verify, rotate | 3 |
| `src/dash/authStore.ts` (modify) | `access_token` table (additive), audit kinds | 3 |
| `src/web/server.ts`, `src/web/router.ts` (modify) | Mode-aware deps, `GET /api/auth/mode`, `POST /auth/token`, request-security rule, reauth, root callback shim | 4, 7 |
| `src/web/static/views/login.js`, `index.html`, `app.js`, `style.css` (modify) | Paste form, fragment handling, mode-aware sign-in | 5 |
| `scripts/dashboard.ts` (modify) | `token`, `rotate`, `google-url`, mode in `status` | 6 |
| `scripts/web.ts` (modify) | Build OIDC client only when the mode needs it; Google keys loading | 6, 7 |
| `tests/web-server.test.ts`, `tests/web-env.test.ts`, `tests/dash-account.test.ts` (extend) | Mode matrix and OIDC regression | 4, 7, 8 |
| `src/setup/steps/dashboard.ts`, `.env.example` (modify) | One-minute token setup, optional Google upgrade | 9 |
| `src/platform/checks.ts`, `src/platform/checksSetup.ts` (modify) | Doctor `dashboard-login` per mode | 10 |
| `docs/dashboard-exposure.md`, `README.md`, `CLAUDE.md`, `tests/dash-docs.test.ts` (modify) | Docs truth pass | 11 |

---

### Task 1: Desktop-client feasibility, offline (no real secrets)

**Why:** the whole `google_desktop` mode rests on one unverified claim (a Desktop client accepts our redirect). This task checks, with a hermetic fixture and no network, everything that can be checked, and produces the exact URLs the owner will use in live check L2.

**Files:**
- Create: `src/dash/desktopClient.ts`, `tests/dash-desktop-client.test.ts`, `tests/fixtures/dash/gcp-oauth.desktop.json`, `tests/fixtures/dash/gcp-oauth.web.json`

**Fixture shape** (invented values only; this is the documented Google download shape for a Desktop app):
```json
{ "installed": { "client_id": "000000000000-fixture.apps.googleusercontent.com",
  "project_id": "fixture-project", "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token",
  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",
  "client_secret": "FIXTURE-NOT-A-SECRET", "redirect_uris": ["http://localhost"] } }
```
The `web` fixture is the same with the top-level key `web` and `redirect_uris` `["https://example.invalid/auth/callback"]`.

**Interfaces:**
```ts
// src/dash/desktopClient.ts
export interface DesktopClient { clientId: string; clientSecret: string; authUri: string; tokenUri: string }
export type DesktopParse =
  | { ok: true; client: DesktopClient }
  | { ok: false; reason: 'not_object' | 'not_desktop' | 'missing_field' | 'bad_endpoint' };
/** Pure. Accepts the parsed JSON. Never returns or echoes the secret in `reason`. */
export function parseDesktopKeys(raw: unknown): DesktopParse;
export type RedirectShape = 'callback' | 'root';
/** http://127.0.0.1:<port>/auth/callback or http://127.0.0.1:<port>/ ; loopback IP literal only. */
export function redirectFor(shape: RedirectShape, port: number): string;
/** The authorization URL the live check prints (response_type=code, scope=openid email, S256 PKCE, random state). No secret in it. */
export function authUrlFor(client: DesktopClient, redirectUri: string, state: string, challenge: string): string;
```
Rules in `parseDesktopKeys`: top-level object has exactly the `installed` key (a `web` key is `not_desktop`, which is how a mistaken Web client is detected); `client_id` ends with `.apps.googleusercontent.com`; `client_secret` is a non-empty string; `auth_uri` is `https://accounts.google.com/...` and `token_uri` is `https://oauth2.googleapis.com/...` (https, those hosts only; anything else is `bad_endpoint`, so a tampered file cannot send the secret elsewhere).

- [ ] **Step 1: Failing tests.** Fixture parses `ok`; web fixture is `not_desktop`; missing `client_secret` is `missing_field`; `token_uri` on another host is `bad_endpoint`; `http` endpoints rejected; `redirectFor('callback', 8787)` is `http://127.0.0.1:8787/auth/callback`, `'root'` is `http://127.0.0.1:8787/`; `authUrlFor` contains `scope=openid+email` (or `%20`), `code_challenge_method=S256`, the redirect, and does NOT contain `client_secret`; no `reason` string contains the fixture secret.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/dash-desktop-client.test.ts`.
- [ ] **Step 3: Implement.** Also add a test that `createOidc` (`src/dash/oidc.ts`) accepts the fixture's endpoints as config: build `OidcConfig` with the fixture client, redirect from `redirectFor`, a fake `fetch` serving a discovery document whose `issuer` is `https://accounts.google.com`, and assert `buildAuthRequest` returns a URL carrying the redirect and S256 challenge. This proves the existing client is reusable unchanged (no new protocol code in mode B).
- [ ] **Step 4: Record the verdict in the test file header** as a comment block: "Checked offline: shape, endpoints, client reuse. NOT checked: Google accepting the redirect path (owner check L2)."
- [ ] **Step 5: Verify:** `npx vitest run tests/dash-desktop-client.test.ts tests/dash-oidc.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 6: Commit:** `feat(dash): parse Desktop OAuth keys offline and prove OIDC client reuse`

---

### Task 2: Mode and remote-bind validation (`src/web/env.ts`)

**Files:**
- Modify: `src/web/env.ts`, `tests/web-env.test.ts`

**Interfaces:**
```ts
export type AuthMode = 'token' | 'google_desktop' | 'oidc';
// WebConfig gains:
//   authMode: AuthMode;                 // effective
//   authModeImplicit: boolean;          // true when WEB_AUTH_MODE was unset and OIDC keys selected 'oidc' (D1)
//   googleKeysPath: string;             // WEB_GOOGLE_KEYS_PATH || GMAIL_OAUTH_PATH || './secrets/gcp-oauth.keys.json'
//   googleRedirectShape: 'callback' | 'root';  // WEB_GOOGLE_REDIRECT_SHAPE, default 'callback'
// ErrorScope gains: 'token' | 'google'
export function resolveAuthMode(env: RunnerEnv): { mode: AuthMode; implicit: boolean } | { error: string };
```
Rules:
- `WEB_AUTH_MODE` set to anything outside the three values: error scope `web` ("WEB_AUTH_MODE must be token, google_desktop or oidc").
- `oidc` scope errors (client id, secret, redirect URI, issuer, `WEB_OIDC_REAUTH_PROMPT`) are produced only when the effective mode is `oidc`. `WEB_REAUTH_MAX_AGE_SEC` is validated in every mode (it governs chat reauth) but under scope `web`.
- Account rule (`DASHBOARD_ALLOWED_EMAIL` or stored account) applies in `google_desktop` and `oidc` only.
- `google_desktop`: `WEB_GOOGLE_REDIRECT_SHAPE` must be `callback` or `root` (scope `google`); the redirect URI is derived (never user-supplied) from `redirectFor(shape, port)` and requires a loopback bind, so `google_desktop` with a non-loopback `WEB_BIND` is an error (a Desktop client only supports loopback redirects).
- **Remote-bind rule (D4), mode `token`:** `!isLoopbackBind(bind)` requires `trustProxy === true` and `allowedHosts.length > 0`; otherwise error scope `token`: "token sign-in on a non-loopback bind needs WEB_TRUST_PROXY=true behind a TLS proxy and WEB_ALLOWED_HOSTS". Existing rule (non-loopback needs `WEB_ALLOW_REMOTE_BIND=true`) stays and is reported first.

| mode | bind | WEB_ALLOW_REMOTE_BIND | WEB_TRUST_PROXY | WEB_ALLOWED_HOSTS | result |
|---|---|---|---|---|---|
| token | loopback | any | any | any | ok |
| token | non-loopback | false | any | any | error web (existing) |
| token | non-loopback | true | false | any | error token |
| token | non-loopback | true | true | empty | error token |
| token | non-loopback | true | true | set | ok |
| google_desktop | non-loopback | true | true | set | error google (loopback only) |
| oidc | non-loopback | true | true | set | ok (unchanged) |

- [ ] **Step 1: Failing tests** for the table (one `it` per row), `resolveAuthMode` (unset with no OIDC keys is `token`; unset with id and secret is `oidc` implicit; explicit value wins; garbage is an error), per-mode scoping (a token-mode env with all `WEB_OIDC_*` empty is `ok`; an `oidc`-mode env with them empty keeps today's errors, copy the existing assertions), account rule per mode.
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/web-env.test.ts`.
- [ ] **Step 3: Implement.** Existing exported names and the existing error messages are unchanged so the doctor and tests keep working.
- [ ] **Step 4: Verify:** `npx vitest run tests/web-env.test.ts tests/web-server.test.ts tests/dash-account.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(web): WEB_AUTH_MODE with per-mode validation and token remote-bind rule`

---

### Task 3: Access token store (`src/dash/accessToken.ts`)

**Files:**
- Create: `src/dash/accessToken.ts`, `tests/dash-access-token.test.ts`
- Modify: `src/dash/authStore.ts` (table `access_token (id INTEGER PRIMARY KEY CHECK (id = 1), token_hash TEXT NOT NULL, created_at TEXT NOT NULL, rotated_at TEXT)` via `CREATE TABLE IF NOT EXISTS`; `AuditKind` gains `'token_created' | 'token_rotated' | 'token_login_ok' | 'token_login_denied' | 'mode_changed'`), `tests/dash-auth-store.test.ts`

**Interfaces:**
```ts
export const TOKEN_BYTES = 32;                 // 43 base64url chars
export function generateToken(random?: (n: number) => Buffer): string;
export function hashToken(token: string): string;   // SHA-256 hex
/** Replace (or create) the stored hash and revoke every session, in one transaction. Returns whether it was a rotation. */
export function setToken(db: AuthDb, token: string, now: Date): { rotated: boolean };
export function tokenStatus(db: AuthDb): { set: boolean; createdAt: string | null; rotatedAt: string | null };
/** Constant time. With no stored token it still hashes and compares against a random dummy digest and returns false. */
export function verifyToken(db: AuthDb, presented: unknown): boolean;
```
`verifyToken` rejects non-strings, length over 128 or not matching `^[A-Za-z0-9_-]+$` before hashing (still constant-work: it compares a dummy digest on that path too). It never throws with the token in the message.

- [ ] **Step 1: Failing tests:** generate gives 43 chars of base64url and two calls differ; `hashToken` is 64 hex and does not contain the token; `setToken` then `verifyToken` true, wrong token false, empty/non-string/oversized false; no stored token returns false without throwing; `setToken` twice returns `rotated: true` the second time and the OLD token no longer verifies; rotation sets `revoked_at` on live sessions (create two with `createSession`); `tokenStatus` never exposes the hash; **timing-safe proof:** spy on `crypto.timingSafeEqual` (vi.spyOn on the module namespace via an injected `compare` dep, or assert via the exported `_compare` seam) and assert it is called on the match path, the mismatch path AND the no-token path; no `===` comparison of secret strings (a lint-style test greps `src/dash/accessToken.ts` for `token_hash ===`, `hash ===`, `== presented`).
- [ ] **Step 2: Run, confirm failure:** `npx vitest run tests/dash-access-token.test.ts`.
- [ ] **Step 3: Implement.** Schema change is additive; `tests/dash-auth-store.test.ts` gains: opening an auth db created by the OLD schema (create the old tables by hand in the test, then `openAuthStore`) leaves the allowed account, sessions and audit rows readable.
- [ ] **Step 4: Verify:** `npx vitest run tests/dash-access-token.test.ts tests/dash-auth-store.test.ts tests/dash-sessions.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(dash): hashed access token store with constant-time verify and rotation`

---

### Task 4: Token login routes and the request-security rule (`src/web/server.ts`)

**Files:**
- Modify: `src/web/server.ts`, `src/web/router.ts` (only if a helper is needed), `tests/web-server.test.ts` (extend; existing OIDC cases unchanged)
- Test: `tests/web-token-login.test.ts` (new)

**Interfaces:** `WebDeps` gains `authMode: AuthMode` (default `'oidc'` when omitted, so every existing test and caller is unchanged) and `oidc`/`oidcCfg` become optional (required when `authMode` is `oidc` or `google_desktop`; `createWebServer` throws at construction otherwise). New routes:

| Route | Open | Behaviour |
|---|---|---|
| `GET /api/auth/mode` | yes | `{ mode: 'token' \| 'google_desktop' \| 'oidc' }` only. The login view uses it. |
| `POST /auth/token` | yes (checks itself) | Body `{ token: string, reauth?: boolean }` JSON, at most 1 KiB (`readJson`). Only in `token` mode (404 otherwise). |

`POST /auth/token` order of checks (each failure is the SAME generic `401 {"error":"denied"}` except throttle and transport):
1. mode is `token`, else 404.
2. **Request-security rule (D4):** accept only if `c.secure` (trusted proxy said https) OR (`req.socket.remoteAddress` is a loopback address AND no `x-forwarded-*` or `forwarded` header is present AND `Host` is `127.0.0.1:<port>` or `localhost:<port>`). Otherwise `403 {"error":"insecure_transport"}` and an audit row `token_login_denied` with note `insecure_transport` (no token involved).
3. `Origin` must equal `${secure ? 'https' : 'http'}://${Host}` (the open-route handler does this itself because the generic CSRF/Origin block only covers non-open routes); `Content-Type` must be `application/json`; else 403.
4. `checkLogin(deps.auth, ip, now)`; not allowed gives `429` with `Retry-After` and the existing `lockout` audit throttling (`LOCKOUT_AUDIT_GAP_MS`).
5. `verifyToken`. Failure: `recordLogin(..., false)`, audit `token_login_denied` (note `bad_token`, no value, no length), `401 denied`. Success: `recordLogin(..., true)`.
6. `reauth: true` requires a valid session cookie; it calls `refreshAuth(db, session.idHash, now)`, audits `reauth_ok`, answers `{ok:true}` and sets no new cookie. Without a session: `401 denied`.
7. Otherwise rotate: revoke any session cookie presented (as the OIDC callback does), `createSession`, `Set-Cookie` via `serializeSession` (same flags, `Secure` only when `c.secure`), audit `token_login_ok`, answer `{ok:true}` (no redirect; the page navigates to `/`).

Also: `reauth` helper in `chat` routes returns `url: '/#/login?reauth=1'` in token mode. `GET /auth/login` and `/auth/callback` return 404 in token mode. A `token` key in ANY query string is ignored and never logged (the server only logs route templates already).

- [ ] **Step 1: Failing tests (`tests/web-token-login.test.ts`)**, in-process server with `openAuthStore(tmp)`, `setToken`, a fake clock: correct token gets a session cookie with `HttpOnly; SameSite=Lax; Path=/` and the cookie authorizes `GET /api/session`; wrong token 401 generic and identical body to "no token stored"; 10 wrong tokens from one ip lock that ip (429 with `Retry-After`, correct token also 429 while locked), another ip unaffected; global lock at 20; wrong Origin 403; non-JSON content type 403; body over 1 KiB 413/400 without echo; token in query string (`GET /?token=<valid>`, `GET /api/session?token=<valid>`) does not log in; `x-forwarded-for` present with `trustProxy` false on a loopback socket gives `insecure_transport`; `trustProxy` true with `x-forwarded-proto: https` gives a `__Host-` `Secure` cookie; `reauth` refreshes `auth_at` without a new cookie; in `oidc` mode `POST /auth/token` is 404 and `GET /api/auth/mode` says `oidc`.
- [ ] **Step 2: No-leak tests:** after a successful and a failed login, capture `console.error`/`console.log` (spy) and assert no call contains the token; read all `audit_log` rows and assert none contains the token or its hash; fetch `/api/status`, `/api/config`, `/api/audit`, `/api/session` with the session and assert the JSON text contains neither the token nor `hashToken(token)`.
- [ ] **Step 3: Implement.** Reuse `safeEqual`, `checkLogin`, `recordLogin`, `audit`, `createSession`, `serializeSession`. No new cookie name.
- [ ] **Step 4: Verify:** `npx vitest run tests/web-token-login.test.ts tests/web-server.test.ts tests/web-api.test.ts tests/web-chat.test.ts tests/dash-sessions.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 5: Commit:** `feat(web): token login route with throttle, audit, CSRF-safe origin check and transport rule`

---

### Task 5: Login view (frontend)

**Files:**
- Modify: `src/web/static/views/login.js`, `src/web/static/app.js`, `src/web/static/index.html`, `src/web/static/style.css`, `tests/web-frontend-lint.test.ts` (extend)
- `src/web/static/api.js`: add `getAuthMode()` and `postToken(token, reauth)` using the existing fetch wrapper (CSRF header is not available before login; the server does not require it on this open route).

Behaviour (DOM APIs `createElement`, `textContent`, `setAttribute` of known-safe attributes only):
- On load of `#/login` (or `#/denied`), call `GET /api/auth/mode`.
- `token` mode: render a form with one `<input type="password" autocomplete="off" spellcheck="false">` and a Sign in button. If `location.hash` starts with `#token=`: read the value, immediately `history.replaceState(null, '', location.pathname)` (removes the fragment before any network call), then POST it and, on `{ok:true}`, `location.hash = '#/'`. On failure show the fixed message "That token was not accepted." (never echo the value, never differ between causes except the 429 wording "Too many attempts, wait N seconds" from `Retry-After`).
- `oidc` and `google_desktop`: the existing "Sign in with Google" link to `/auth/login` (the same link serves both).
- Reauth (`#/login?reauth=1`): same view, posts with `reauth: true`, then returns to the previous hash.
- Never store the token in `localStorage`, `sessionStorage`, a cookie or a JS global after the POST; clear the input value on submit.

- [ ] **Step 1: Failing lint tests:** the login view has no forbidden DOM sink (existing grep covers it); a new grep asserts `login.js` calls `replaceState` before `fetch`/`postToken` in source order; asserts no `localStorage`/`sessionStorage` in `login.js`; asserts the token form input uses `type="password"`/`'password'`.
- [ ] **Step 2: Implement** and add `style.css` rules reusing existing tokens/classes.
- [ ] **Step 3: Verify:** `npx vitest run tests/web-frontend-lint.test.ts tests/web-server.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 4: Commit:** `feat(web): token paste and fragment sign-in view`

---

### Task 6: Owner CLI (`npm run dashboard -- token | rotate | status | google-url`) and runner wiring

**Files:**
- Modify: `scripts/dashboard.ts`, `scripts/web.ts`, `tests/` (existing dashboard CLI tests, or new `tests/dash-cli-token.test.ts`)

**CLI contract:**
```
dashboard token [--port N]     create the token if none exists; refuse if one exists ("use rotate")
dashboard rotate [--port N]    replace it, revoke all sessions
dashboard status               adds: auth mode (effective), token set yes/no and dates, never the hash
dashboard google-url           prints the authorization URL for the configured redirect shape (Task 7)
```
`token` and `rotate` print exactly:
```
Dashboard access token (shown once, not stored anywhere readable):
http://127.0.0.1:<port>/#token=<token>
```
Rules: refuse to print unless `process.stdout.isTTY` (exit 1 with "run this in a terminal; the token is shown once") unless `--print` is passed explicitly; the port comes from `--port` or `WEB_PORT` (default 8787); the host is always `127.0.0.1` (never `WEB_BIND`); writes audit `token_created` / `token_rotated` with no value; `rotate` asks `confirm` first (same `confirm` helper as `allow`). `parseArgs` stays pure and unit-tested.

`scripts/web.ts`: resolve the effective mode through `validateRunnerConfig`; token mode skips `createOidc` and the discovery call and starts even with no allowed account; if no token is stored it starts anyway and prints `web: no access token yet: run npm run dashboard -- token` (login attempts are denied, nothing is open); prints the plain `http://127.0.0.1:<port>` (no token) at start as today.

- [ ] **Step 1: Failing tests:** `parseArgs` for each command and bad arities; `token` on an empty store creates a hash and prints one URL line containing a 43-char token (inject `stdout` writer and `isTTY`); second `token` refuses; `rotate` invalidates the old token and revokes sessions; non-TTY without `--print` refuses and prints no token; `status` output contains neither token nor hash (grep both); the audit rows written contain no token.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Verify:** `npx vitest run tests/dash-cli-token.test.ts tests/web-env.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 4: Commit:** `feat(dashboard): token, rotate and mode status commands; token mode starts without OIDC`

---

### Task 7: Google sign-in on the Gmail Desktop client (`google_desktop`)

**Files:**
- Modify: `scripts/web.ts`, `src/web/server.ts`, `scripts/dashboard.ts` (`google-url`), `tests/web-server.test.ts`
- Test: `tests/web-google-desktop.test.ts` (new)

Behaviour:
- `scripts/web.ts` in `google_desktop`: read `cfg.googleKeysPath` (a path under the project root or absolute), `JSON.parse`, `parseDesktopKeys`; any failure prints a fixed message with the failure `reason` code only and exits 1 (never the file content). On success build `createOidc({ issuer: 'https://accounts.google.com', clientId, clientSecret, redirectUri: redirectFor(shape, port), reauthPrompt: 'select_account', maxAgeSec })` and add `clientSecret` to the redaction literals. The server code path is the existing `authLogin`/`authCallback`; nothing about state, nonce, PKCE, `evaluateLogin`, pinning or the session rotation changes.
- **Root shim:** when `googleRedirectShape === 'root'`, `GET /` with `code` and `state` query parameters is routed to `authCallback`; any other `GET /` serves the static shell as today. The shim exists only in `google_desktop` mode and only for that exact path.
- `dashboard google-url`: builds the authorization URL with `authUrlFor` (fresh state and a throwaway PKCE challenge, scope `openid email`) for the configured shape, prints it with the line "Open this in a browser. Google showing the account chooser means the redirect shape is accepted; `redirect_uri_mismatch` means it is not. Nothing is signed in by this URL." Reads the keys file the same way; no network.
- Documented fallback order in the error text and docs: (1) `WEB_GOOGLE_REDIRECT_SHAPE=root`; (2) `WEB_AUTH_MODE=oidc` with a dedicated Web client (today's setup); (3) stay on `token`.

- [ ] **Step 1: Failing tests** with the Task 1 fixture written to a temp file and a fake `fetch` (discovery, JWKS from a locally generated test key via `jose` `generateKeyPair`, token endpoint): full code flow signs in an allowed email and pins `sub` on first login; a second `sub` with the same email is denied (`sub_mismatch`); unverified email denied; wrong-type (`web`) keys file makes `web.ts` helper return the `not_desktop` reason without echoing contents; `root` shape routes `GET /?code=x&state=y` to the callback and a plain `GET /` to the static shell; `callback` shape does not route `/`; `google_desktop` with `trustProxy` or non-loopback bind is rejected by Task 2 config; `google-url` output contains the redirect and not the client secret.
- [ ] **Step 2: Implement** (factor the keys-loading into a small function in `src/dash/desktopClient.ts` taking an injected `readFile` so `scripts/web.ts` stays thin).
- [ ] **Step 3: Verify:** `npx vitest run tests/web-google-desktop.test.ts tests/dash-desktop-client.test.ts tests/web-server.test.ts tests/dash-oidc.test.ts tests/dash-account.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 4: Commit:** `feat(web): google_desktop sign-in on the Gmail OAuth Desktop client with pinned account`

---

### Task 8: OIDC regression and migration (no break for existing installs)

**Files:**
- Test: `tests/web-auth-migration.test.ts` (new)
- Modify (only if a test finds a gap): `src/web/env.ts`, `scripts/web.ts`

Cases (all in process, temp dirs, fake fetch):
1. Env with `WEB_OIDC_CLIENT_ID`, `WEB_OIDC_CLIENT_SECRET`, `WEB_OIDC_REDIRECT_URI`, `DASHBOARD_ALLOWED_EMAIL` and NO `WEB_AUTH_MODE` resolves to `oidc` with `authModeImplicit: true`; config valid; the same OIDC code flow as today's `tests/web-server.test.ts` passes against it.
2. An auth sqlite created by the pre-8C schema with an allowed account, a pinned `sub`, two live sessions and audit rows opens unchanged: same account, same sessions valid, `login_ok` rows intact, new table empty.
3. Explicit `WEB_AUTH_MODE=oidc` equals case 1 minus the implicit flag.
4. Switching an existing OIDC install to `WEB_AUTH_MODE=token` and running `token` revokes the OIDC sessions (D8), keeps `allowed_account` untouched (so switching back needs no `allow`), and does not delete audit history.
5. `GET /auth/login` in `token` mode is 404 and in `oidc` mode redirects to the provider (unchanged).
6. The doctor (Task 10) does not fail an implicit-oidc install; it warns once.

- [ ] **Step 1: Write the tests, run, fix gaps.** `npx vitest run tests/web-auth-migration.test.ts tests/web-server.test.ts tests/dash-oidc.test.ts tests/dash-account.test.ts tests/dash-auth-store.test.ts`.
- [ ] **Step 2: Verify:** `npx tsc -p . --noEmit`.
- [ ] **Step 3: Commit:** `test(dash): OIDC installs keep working after the auth mode change`

---

### Task 9: Setup wizard step and `.env.example`

**Files:**
- Modify: `src/setup/steps/dashboard.ts`, `.env.example`, `tests/` (the existing setup dashboard step tests; find with `ls tests | grep -i setup`)

New `.env.example` block (comments say what each does; defaults ship as the safe choice):
```
# Dashboard sign-in mode: token (default), google_desktop or oidc.
# Leave unset on an existing OIDC install and it keeps working (see docs/dashboard-exposure.md).
WEB_AUTH_MODE=token
# google_desktop only: keys file of the Gmail Desktop OAuth client (defaults to GMAIL_OAUTH_PATH).
WEB_GOOGLE_KEYS_PATH=
# google_desktop only: callback (/auth/callback) or root (/). Try root if Google refuses callback.
WEB_GOOGLE_REDIRECT_SHAPE=callback
```
The existing `WEB_OIDC_*` lines stay, with a comment "used only when WEB_AUTH_MODE=oidc". There is NO `DASHBOARD_TOKEN` key (D2).

Wizard flow (step id `dashboard` unchanged, resumable):
1. Local settings (`WEB_PORT`, `WEB_TMUX_SESSION`, `WEB_TMUX_WINDOW`) as today.
2. Existing OIDC owner (`WEB_OIDC_CLIENT_ID` and secret already in `.env`, no `WEB_AUTH_MODE`): say "Your OIDC sign-in is kept"; write `WEB_AUTH_MODE=oidc` and finish. No questions.
3. Otherwise ONE confirm: "Create a dashboard access token now?" (default yes). Yes: write `WEB_AUTH_MODE=token` (only if missing), then `ctx.spawnInteractive('npx', ['tsx', 'scripts/dashboard.ts', 'token'])`. The child prints the URL once to the terminal; the wizard never reads it, never stores it in state, never passes it through `io.say`. Then say "Open that URL once; the token is not stored. Lost it? npm run dashboard -- rotate".
4. Optional, default no: "Use Google sign-in instead? (needs the Gmail OAuth client, see docs)". Yes: set `WEB_AUTH_MODE=google_desktop`, ask only for `DASHBOARD_ALLOWED_EMAIL`, run `dashboard allow <email>` as today, then say the first sign-in pins the account and name owner check L2 as unverified.

- [ ] **Step 1: Failing tests** with the existing fake `SetupContext`: token path writes `WEB_AUTH_MODE=token`, calls `spawnInteractive` with exactly `['tsx','scripts/dashboard.ts','token']`, asks one confirm and zero `ask`/`askSecret` calls (the under-a-minute property), and no `say` line or state value matches `/#token=|[A-Za-z0-9_-]{43}/`; OIDC owner path asks nothing and writes `oidc`; google path asks for email only and never asks for a client id or secret; rerun is idempotent (existing token: the CLI refuses, the wizard reports "token already set, use rotate" and marks done).
- [ ] **Step 2: Implement.** Remove the "Owner-only checklist in 7C" Google Cloud instruction from the default path (it stays referenced only from the `oidc` branch in docs).
- [ ] **Step 3: Verify:** `npx vitest run <the setup dashboard step test files> tests/dash-docs.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 4: Commit:** `feat(setup): one-confirm token sign-in; Google and OIDC as options`

---

### Task 10: Doctor checks per mode

**Files:**
- Modify: `src/platform/checks.ts` (`web` and `dashboard-login` checks), `src/platform/checksSetup.ts` (the `dashboard-login` placeholder text), `tests/platform-checks-*.test.ts` (the existing file that covers `dashboard-login`; find with `grep -l dashboard-login tests/*.ts`)
- `ctx` gains `authToken?: (authPath: string) => { set: boolean; createdAt: string | null } | null` beside `authAccount`; the production implementation opens the auth store read-only and returns only those two fields (never the hash).

`dashboard-login` check, per effective mode (result is `pass`, `warn` or `fail` with a `fix`):

| mode | condition | result |
|---|---|---|
| any | auth file or `.dashboard` directory readable by group/others | fail (as today) |
| token | no token stored | warn: "no access token is set", fix `npm run dashboard -- token` |
| token | token set | pass: "token mode, token set (created <date>)" |
| token | non-loopback bind without `WEB_TRUST_PROXY=true` and `WEB_ALLOWED_HOSTS` | fail with the Task 2 message |
| token | loopback bind, `WEB_TRUST_PROXY=true` without `WEB_ALLOWED_HOSTS` | warn (as today) |
| google_desktop | keys file missing or `parseDesktopKeys` not ok | fail with the reason code, fix "download the Desktop client again (see docs/gmail-mcp-setup.md)" |
| google_desktop | account not pinned | warn: "Google sign-in is unverified until the first sign-in pins the account (owner check L2)" |
| google_desktop | `WEB_BIND` not loopback | fail |
| oidc | existing OIDC rules, unchanged | as today |
| oidc, implicit | `authModeImplicit` | warn once: "OIDC selected implicitly, set WEB_AUTH_MODE=oidc" |
| any | `WEB_CHAT_ENABLED=true` and set not `read_only` | warn (as today) |

The check line states the mode ("dashboard login (token)"). It never prints a token, a hash, a client id or a secret.

- [ ] **Step 1: Failing tests:** one per table row using the fake `ctx` helpers already in that test file; a test that the details string for token mode contains no 43-char base64url run and no 64-hex run.
- [ ] **Step 2: Implement.** Keep check ids `web` and `dashboard-login` (setup state and 8B's operator output refer to them).
- [ ] **Step 3: Verify:** the doctor test files, `npx vitest run tests/platform-doctor.test.ts` (real name from `ls tests | grep -i doctor`), `npx tsc -p . --noEmit`.
- [ ] **Step 4: Commit:** `feat(doctor): dashboard-login judges the active auth mode`

---

### Task 11: Docs truth pass

**Files:**
- Modify: `docs/dashboard-exposure.md`, `README.md` ("Status web page" section and the wizard `dashboard` bullet), `CLAUDE.md` (Platform and sessions: scripts list `dashboard -- token|rotate|allow|status|audit|google-url`; one paragraph on the three modes), `docs/gmail-mcp-setup.md` (one short section: the same client is reused for dashboard sign-in, with the unverified note), `tests/dash-docs.test.ts` (extend)

Content that must be in `docs/dashboard-exposure.md`:
- Section 2 "Sign-in is mandatory" rewritten: three modes, token is the default, a table of mode versus what protects, what is unverified (Google Desktop redirect), migration note for OIDC owners ("nothing to do; or set `WEB_AUTH_MODE=oidc` explicitly").
- Token rules: shown once, rotate with `npm run dashboard -- rotate`, hash only in `.dashboard/auth.sqlite`, loopback by default, why a non-loopback bind needs a TLS proxy (D4), how the SSH tunnel keeps working unchanged.
- Each exposure option (Tailscale, Cloudflare Tunnel, reverse proxy, SSH tunnel) states which modes it supports: all three behind a proxy; `google_desktop` loopback only (so Tailscale `serve` and tunnels work with `token`/`oidc`, not `google_desktop`).
- Recovery: lost token is `rotate`; OIDC/Google account change is `allow` as today.
- Checklist gains: "token not pasted into chat, tickets or screenshots", "`WEB_AUTH_MODE` matches what you intend (`npm run doctor`)".
- README: "Start it with `npm run web` ... first run `npm run dashboard -- token` (setup does this for you) and open the printed URL"; keep the loopback and chat-box bullets.

- [ ] **Step 1: Failing doc tests:** `docs/dashboard-exposure.md` mentions `WEB_AUTH_MODE`, `token`, `google_desktop`, `oidc`, `rotate`, `unverified`; `.env.example` contains `WEB_AUTH_MODE=token` and no `DASHBOARD_TOKEN`; README names `npm run dashboard -- token`; the doc still passes the existing "only warns against the any-address" test.
- [ ] **Step 2: Write the docs.** Owner-facing wording, no marketing, no em dashes.
- [ ] **Step 3: Verify:** `npx vitest run tests/dash-docs.test.ts` and `npx tsc -p . --noEmit`.
- [ ] **Step 4: Commit:** `docs(dashboard): token default, Google desktop option, OIDC migration`

---

## Final verification (after Task 11)

```bash
npx tsc -p . --noEmit
npx vitest run
git grep -n "DASHBOARD_TOKEN" -- src scripts docs .env.example README.md CLAUDE.md   # expect no hit except explanatory prose in the exposure doc
git grep -nE "token=\\$|\\?token=|console\\.(log|error)\\([^)]*token" -- src scripts       # expect nothing that logs a token
git status --short                                                                          # only intended paths
```
Expected: exactly the 5 known failures; every OIDC test still green; no file under `secrets/`, `user-data/`, `.env*`, `.dashboard/` touched.

## Hard limits for the builder

1. Do not read `secrets/`, `user-data/`, `.env*`, `.dashboard/` or `data.sqlite`; do not open `secrets/gcp-oauth.keys.json`. Fixtures only.
2. No network, no `npm install`, no new dependency, no live Google, no browser, no tmux, no real `claude`.
3. Do not remove, rename or loosen anything in `src/dash/oidc.ts`, `src/dash/account.ts` (`evaluateLogin`), `src/dash/sessions.ts` (cookie value format, caps, expiries) or the OIDC test files. Additive changes only to `authStore.ts`.
4. Do not store the token (or a reversible form of it) anywhere: not `.env`, not the auth db, not a file, not state. Only `SHA-256(token)`.
5. Do not add a query-string or header token login path. POST body or fragment only.
6. Do not accept token login over plain http from a non-loopback peer or when forwarding headers are present without a trusted https proxy (D4).
7. Do not change the chat send rules (two-step confirm, CSRF, reauth freshness), the read-only data guarantee, or the security headers.
8. Do not edit `CLAUDE.md`/`README.md` before Task 11. Do not commit anything but the listed paths. Never push, never `--no-verify`.
9. Do not flip any dry-run flag, halt flag, permission set or kill-switch file.
10. If a step needs a decision this plan does not make, stop and ask; do not guess.

## Owner decisions (recommended defaults)

| # | Question | Recommended |
|---|---|---|
| O1 | Default mode for new installs | `token` (D1) |
| O2 | Token storage | hash in the auth db, printed once, `rotate` (D2) |
| O3 | Allow token sign-in on a non-loopback bind behind a trusted TLS proxy | yes, with `WEB_ALLOWED_HOSTS` required (D4); no plain-http LAN token login |
| O4 | Keep Google sign-in as an option at all | yes, off by default, until L2 passes; drop it from the docs if L2 fails and Web client OIDC covers the need |
| O5 | Redirect shape to try first for `google_desktop` | `callback` (matches today's code and docs), then `root` |
| O6 | Implicit OIDC selection for existing installs | keep (D1); the doctor nags once to set the mode explicitly |
| O7 | Remove OIDC entirely later | no; revisit only after a month of token use |
| O8 | Session lifetimes (30 min idle, 12 h absolute, 3 sessions) for token mode | unchanged |
| O9 | Chat box in token mode | unchanged: stays off by default; token holders can use it only if `WEB_CHAT_ENABLED=true`, fresh re-entry of the token within `WEB_REAUTH_MAX_AGE_SEC` needed for sends |

## Owner-only live checks (after merge; the builder cannot do these)

- **L1 (token, 5 minutes):** `npm run dashboard -- token`, open the printed URL in Chrome and Safari, confirm the address bar loses `#token=...` and you land on the status page; reload (still signed in); wait 31 minutes idle (signed out); `npm run dashboard -- rotate` and confirm the old URL is refused; try `http://127.0.0.1:8787/?token=<token>` and confirm it does NOT sign you in; `npm run dashboard -- audit` shows `token_login_ok`/`token_login_denied` and no token text; `npm run doctor` shows `dashboard login (token)` pass.
- **L2 (Google Desktop redirect, the unverified one):** set `WEB_AUTH_MODE=google_desktop`, run `npm run dashboard -- google-url`, open the URL. Account chooser or consent screen shown: shape accepted, continue to sign in, confirm the first sign-in pins the account (`npm run dashboard -- status`). `redirect_uri_mismatch`: set `WEB_GOOGLE_REDIRECT_SHAPE=root`, repeat. Still refused: this approach does not work with your client; stay on `token` or create a Web client and use `oidc`. Record the result in the 8C report.
- **L3 (consent screen):** in the Google Cloud console confirm the Gmail client's consent screen is in testing mode with you as test user; confirm sign-in does not trigger a verification warning for `openid email`.
- **L4 (remote, only if you expose it):** behind your TLS proxy with `WEB_TRUST_PROXY=true` and `WEB_ALLOWED_HOSTS` set, confirm token sign-in works over https and a plain `http://` request through the same proxy is refused; confirm `npm run doctor` fails when `WEB_TRUST_PROXY` is removed.
- **L5 (migration):** on a copy of an existing OIDC `.env` (do not edit the live one first), run `npm run doctor` and `npm run web`; confirm Google sign-in still works and the account stays pinned.

## Self-review checklist (planner)

- Spec coverage: A (token default, hash at rest, fragment/POST, constant time, throttle, audit, loopback, remote rule) Tasks 2 to 6; B (Desktop reuse, offline check first, live check, fallback) Tasks 1, 7; C kept and regression-tested Tasks 2, 8; env keys and `.env.example` Tasks 2, 9; wizard Task 9; doctor Task 10; tests (timing, throttle, no leak) Tasks 3, 4, 6, 10; docs Task 11; migration Task 8.
- No placeholder steps; every task names files, tests, a verify command and a commit message.
- Names used consistently: `WEB_AUTH_MODE`, `AuthMode`, `authModeImplicit`, `parseDesktopKeys`, `redirectFor`, `authUrlFor`, `setToken`, `verifyToken`, `tokenStatus`, `POST /auth/token`, `GET /api/auth/mode`.
