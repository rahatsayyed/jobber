# Plan 7C: read-only dashboard v1 with single-account OpenID Connect login

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per project preference, dispatch subagents with `model: sonnet`, one task at a time, review gate after each task.

**Goal:** the owner opens one local web app, signs in with one pre-chosen Google (or other OIDC) account, and sees jobs (discovered, matched, applied, pending, failed), per-person conversation threads, sent emails and follow-ups, outcomes and the funnel with benchmarks, running tmux sessions with their last output line, halt flags, rolling ceilings, the run log and a masked config view. Exactly one account may log in; every other account is denied. Everything is read-only except one confirmed chat send to the Claude tmux window. Exposure beyond localhost is the owner's job, with a short doc of options.

**Architecture:** this plan extends the 7C-lite slice (`2026-10-14-7c-lite-status-web-and-commands.md`) and must start after its Tasks 1 to 6 are merged (it modifies `src/web/server.ts`, `src/web/page.ts`, `scripts/web.ts`). The 7C-lite `node:http` server keeps its Host check, Origin check, security headers, `redactSecrets`, status snapshot and `sendText`. What changes: the single `WEB_TOKEN` login is replaced by an OpenID Connect authorization code flow with PKCE (`state`, `nonce`, S256) against a configurable issuer (default Google), a single allowed account (`DASHBOARD_ALLOWED_EMAIL`, with the provider's `sub` pinned on first login and both checked on every later login), server-side sessions and CSRF tokens, throttling and lockout, and an audit log. There is no password, TOTP or recovery code anywhere. Auth state lives in its own small SQLite file (`.dashboard/auth.sqlite`, mode 600), never in the data database, which the dashboard opens only with a `readonly` handle. Changing the allowed account is possible only through a local CLI command on the machine. The inline nonce page becomes static ES modules served from an in-memory allowlist (no build step, no inline script, `script-src 'self'`). The API is a small set of GET endpoints with keyset pagination and hard caps. All stored text is treated as untrusted: cleaned and secret-redacted on the server, rendered with `textContent` only.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), vitest, `node:http`, `node:crypto` (PKCE, state, nonce, HMAC, `timingSafeEqual`), `better-sqlite3` (already a dependency), plain HTML and ES modules for the frontend. One runtime dependency made direct: `jose` (v6, MIT, zero dependencies, pure JavaScript, no native build; already present in `node_modules` transitively, so it is added to `package.json` `dependencies` pinned to the installed version). `jose` is used only for JWT signature and claim verification with a key set the plan's own code supplies (`createLocalJWKSet` plus `jwtVerify`); discovery, the authorization request, the token exchange, JWKS caching and the account rules are about 200 lines of our own code on `fetch` and `node:crypto`, so no OIDC client framework (`openid-client`, `passport`) is pulled in.

**Spec:** `docs/superpowers/specs/2026-10-14-platform-sessions-dashboard-setup-requirements.md` (section "Dashboard (read-only v1)" is binding). Builds on `docs/superpowers/plans/2026-10-14-7c-lite-status-web-and-commands.md`; format follows `2026-10-14-7a-tmux-ccgram-foundation.md`.

## What this plan replaces from 7C-lite

| 7C-lite part | In plan 7C |
|---|---|
| `WEB_TOKEN` (min 24 chars) and `POST /login` token form (Task 5.2, 6.1, 6.3 doctor check) | Replaced by OIDC sign-in (`GET /auth/login`, `GET /auth/callback`). `WEB_TOKEN` is no longer read; the doctor `web` check is rewritten. |
| In-memory cookie set (max 10) and in-memory lockout | Replaced by stored sessions (hashed ids, idle and absolute expiry) and stored, persistent throttling, in `.dashboard/auth.sqlite`. |
| One inline-script page with a nonce (`src/web/page.ts`) | Replaced by static modules under `src/web/static/`; CSP drops the nonce for `script-src 'self'`. |
| `POST /api/send` (single step) | Replaced by a two-step prepare and confirm (CSRF token, bound to session and text hash). Same text rules as `sendText` and `STATUS_COMMANDS`. |
| `GET /api/status`, `GET /api/pane`, `redactSecrets`, Host and Origin checks, response headers, `buildSnapshot`, `renderLimits/Working/Health`, `/limits /working /health`, `sendText`, Task 7 branding | Kept as is (headers extended). Not touched except where a task below says so. |
| Binding `127.0.0.1` only | Kept as the default. A non-loopback bind now needs an explicit env switch (Task 9) and a doctor warning. |

## Global Constraints

- **Branch:** work on a new branch cut from the merged 7C-lite branch. Commit per task with explicit paths, never `git add -A`, never `--no-verify`, never push.
- Never read, print or commit anything under `user-data/`, `secrets/`, `.env*`, `data.sqlite`. Tests use `JOBAPPLIER_DB=:memory:` (vitest config sets it), `user-data.example`, and temp directories for the auth database. Never log an OIDC client secret, authorization code, access or ID token, `state`, `nonce`, PKCE verifier, session id, CSRF token or cookie value anywhere (logs, audit rows, error messages). The audit log may hold the email and `sub` of a denied account only as a SHA-256 prefix (first 12 hex characters), never in the clear.
- **Read-only data:** the dashboard opens the data database only through `openReadOnlyDb()` (Task 5): `readonly: true`, `fileMustExist: true`, then `PRAGMA query_only = 1`. No dashboard module imports `migrateOutreachTables`, `openDb`, or any `db.prepare(...)` that writes to the data database. A test greps for `INSERT|UPDATE|DELETE|DROP|ALTER` in `src/dash/**` outside the auth module.
- **No write endpoints** except `POST /api/logout` (auth state only) and the confirmed chat send (`POST /api/send/prepare`, `POST /api/send/confirm`). `GET /auth/login` and `GET /auth/callback` change auth state only (they create a pending login and a session). Any other non-GET route returns 405. There is no web route that changes the allowed account.
- **Escaping:** stored text (names, headlines, subjects, message bodies, job titles and descriptions, reply text) is untrusted third-party content. The server runs `cleanText` on every string field it returns; the frontend uses `textContent`, `setAttribute` of known-safe attributes, and `createElement` only. `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `new Function` and string `setTimeout` are forbidden in `src/web/**` (a test greps). Links built from stored URLs are shown as plain text, never as `href`.
- **Secrets never served:** nothing under `secrets/`, `.env`, `.ccgram/`, `.dashboard/`, session storage files or Gmail credentials is readable by any endpoint. The server serves only an in-memory map of known static files; request paths are never joined onto a directory.
- **Network:** bind `127.0.0.1` by default; no CORS headers, ever; Host header allowlist; no outbound network calls from the dashboard process.
- **Crypto and network:** use `node:crypto` for random values, SHA-256 and HMAC, and compare every secret-derived value with `timingSafeEqual` over equal-length digests. The only outbound network calls from the dashboard process are to the configured OIDC issuer (discovery, JWKS, token endpoint) over https, with a 5 s timeout, a 256 KiB response cap, no redirects followed, and the endpoints taken only from the issuer's own discovery document after an issuer-equality check. The CLI and the doctor never make these calls.
- **Subprocesses:** `execFile` with argument arrays only (via the `Run` type in `src/platform/tmux.ts`); tmux names validated by `assertName`. Tests never start a real tmux server, never touch real Telegram.
- No live LinkedIn, Naukri or Gmail action anywhere in this plan.
- **Test baseline:** `npx tsc -p . --noEmit` clean; `npx vitest run` has exactly 5 known failures (4 in `tests/renderChecked.test.ts`, 1 in `tests/resume.test.ts`, Playwright browser missing). Anything else failing is yours.
- Match surrounding code style: file header comment `// src/...`, ESM `.js` import suffixes, tests in `tests/*.test.ts`, run with `npx vitest run <file>`.

## Review Focus

1. **Auth bypass and info leaks:** every route except the static shell, `GET /api/health`, `GET /auth/login` and `GET /auth/callback` requires a valid session; every denial (wrong account, unverified email, bad token, mismatched state) returns the same generic page and the same status; the reason goes only to the audit log (Tasks 2, 3, 9).
2. **Open redirect:** the post-login destination is never taken from a query parameter; it is a fixed `/` plus an optional fragment the client keeps itself. `redirect_uri` is built from config, never from the request's Host (Tasks 2, 9).
3. **State and nonce replay, and CSRF on the callback:** `state` is single-use, bound to the browser by a short-lived `HttpOnly` cookie, expires in 10 minutes; `nonce` and the PKCE verifier are stored server-side with it and consumed in the same transaction; a replayed callback fails (Tasks 1, 2).
4. **Issuer mix-up and token confusion:** the ID token `iss` must equal the configured issuer and the discovery document's `issuer`; `aud` must equal the client id (and `azp` when several audiences); `alg` is restricted to RS256 and ES256 (never `none` or HS*); the JWKS comes only from the discovery document of the configured issuer (Task 2).
5. **Email-change and account-takeover risk:** the email is a mutable attribute; `sub` is the identity. Trust on first use pins `sub`, and every later login must match both `sub` and the email. If the owner's email changes at the provider, login fails closed and the fix is the local CLI. The first login is the weak point: whoever completes it first with the allowed email pins the `sub`, so the CLI shows the pin state and the doctor warns when no sub is pinned yet (Tasks 2, 3).
6. **Clock skew:** `exp`, `iat` and `nbf` are verified with a fixed tolerance (60 s) and an injected clock; a token issued too far in the future is rejected; test both edges (Task 2).
7. **Timing and replay of the confirmed send:** the confirm token is single use, bound to the session and the exact text hash, and a fresh sign-in is required within N minutes (Task 10).
8. **Stored XSS:** untrusted text from jobs, people and mail. `cleanText` server side, `textContent` client side, strict CSP, a grep test for forbidden DOM sinks (Tasks 8, 11).
9. **Read-only guarantee:** no code path from the dashboard writes to the data database; the SQLite handle is `readonly` plus `query_only` (Task 5).
10. **The chat send:** it is the only side effect on the outside world. CSRF, Origin, confirmation bound to the exact text, rate limit, audit row, same character rules as `sendText` (Task 10).
11. **Query abuse:** pagination and `LIKE` search caps, response size cap, no unbounded `SELECT *` on text columns (Tasks 5 to 7).
12. **Secrets in the config view and pane output:** masked by name and by shape; the OIDC client secret is masked (Task 8).
13. **Host, Origin and cookie attributes** behind a tunnel or reverse proxy: `Secure` only when the request really is https; forwarded headers trusted only when the owner opts in; redirect URI scheme rules (Tasks 4, 9, 12).

## Decisions to confirm (assumed accepted)

| Decision | Choice | Cost if wrong |
|---|---|---|
| Login protocol | OpenID Connect authorization code flow with PKCE (S256), `state`, `nonce`, response type `code`, scope `openid email`. Confidential web client: the client secret is sent in the token request body over https. Default issuer `https://accounts.google.com`; any OIDC issuer with a discovery document works through `WEB_OIDC_ISSUER`. | Medium: another provider's quirks (for example no `email_verified`) are rejected fail-closed until handled |
| OIDC library | `jose` for signature and claim verification only, our own thin client for everything else. Checked on this machine: `jose` 6.2.3 is installed (transitively), MIT, no dependencies, no native build, works on Node 20 and later. Rejected: `openid-client` (larger surface, certification-focused features we do not need), `passport` (framework), a fully hand-written RS256 verifier (avoidable crypto code, though `node:crypto` can verify RS256 with a JWK). | Low: the verifier sits behind `verifyIdToken` in `src/dash/oidc.ts`; replacing `jose` is a one-file change |
| ID token checks | Signature against the issuer's JWKS (cached, refetched once on an unknown `kid` at most every 60 s, bounded 24 h cache), `alg` in RS256 or ES256, `iss`, `aud`, `exp`, `iat` and `nbf` with 60 s tolerance, `nonce` equality, `email_verified === true`, `email` present, `sub` present. The access token is never used. | Low |
| Allowed account | `DASHBOARD_ALLOWED_EMAIL` (compared case-insensitively after trimming, exact match, no domain wildcard) plus the provider `sub` pinned in the auth store on the first successful login. Later logins need both. No web route changes either. A different account gets a generic denial and an audit row. | Medium: if the email at the provider is renamed, the owner is locked out until the CLI is run (by design) |
| Changing the account | Only `npm run dashboard -- allow <email>` on the machine: writes the new email to the auth store, clears the pinned `sub`, revokes all sessions, audits `allow_changed`. The env var `DASHBOARD_ALLOWED_EMAIL` is the bootstrap value; when the store holds a different email, the store wins and doctor warns about the mismatch. | Low |
| Auth store | separate `.dashboard/auth.sqlite` (dir 700, file 600, gitignored), written by the dashboard process and the CLI. The data database is never written. | Low |
| Sessions | server-side, random 32 byte id, only its SHA-256 stored, idle timeout 30 min, absolute 12 h, rotated at login, max 3 per account (oldest dropped), `auth_at` recorded (when the ID token was issued). Cookie `__Host-jobber_session` when https, `jobber_session` when plain http; `HttpOnly; SameSite=Lax; Path=/` (Lax, not Strict, because the session cookie must survive the top-level redirect back from the provider; CSRF is covered by the token and Origin check on every POST), `Secure` when https. The pending-login cookie (`__Host-jobber_oidc` or `jobber_oidc`) is `HttpOnly; SameSite=Lax; Max-Age=600; Path=/` (the `__Host-` prefix requires `Path=/`). | Low |
| "https" detection | the request's own socket is plain http (the server never terminates TLS). https is assumed only when `WEB_TRUST_PROXY=true` and the proxy sends `X-Forwarded-Proto: https`. | Medium: a wrong setting drops the `Secure` flag or breaks login behind a proxy; doctor warns |
| Redirect URI | `WEB_OIDC_REDIRECT_URI`, validated at start: `https://...` or `http://127.0.0.1:<port>/auth/callback` or `http://localhost:<port>/auth/callback`; the path must be `/auth/callback`; anything else refuses to start. Google accepts http only for loopback. | Low |
| Fresh sign-in for the chat send | The chat send needs a sign-in no older than `WEB_REAUTH_MAX_AGE_SEC` (default 300). The re-auth request sets `prompt` from `WEB_OIDC_REAUTH_PROMPT` and `max_age=0`. Checked against Google's OpenID Connect docs: Google lists `prompt` values `none`, `consent`, `select_account` only (no `login`) and does not document `max_age`, so for the Google default the re-auth uses `select_account` (forces the account chooser, not a password entry) and the freshness proof is our own: new `nonce`, new `state`, ID token `iat` after the re-auth was started, same `sub`. For an issuer that supports `prompt=login` set `WEB_OIDC_REAUTH_PROMPT=login`; the token's `auth_time` (when present) must then also be newer than the request. | Medium: with Google the re-auth is weaker than a password re-entry (a hijacked, still signed-in browser profile can pass the chooser); the chat box stays off by default and the permission set is the real ceiling |
| Throttling | 10 failed or denied callbacks per IP per 10 min then 15 min lockout; 20 failures per hour across all IPs then 1 hour global lockout (the provider does the password work, so this limits callback abuse and log spam, not password guessing). A success does not clear the global count. Behind a proxy all clients share the proxy address, so the global limit is the real guard. | Low |
| Frontend | static ES modules, no build step, no framework, hash routing, polling only on the live-pane and status views (10 s, paused when the tab is hidden). | Low |
| Run log source | plan 6D has no plan file yet. This plan defines a stub reader of an optional `run_log` table (`id, started_at, finished_at, kind, status, summary`) and returns `{ available: false }` when the table is absent. When 6D lands its table, only `src/dash/runlog.ts` changes. | Low |
| Chat box | kept (spec: "optional, behind login plus confirmation"), off unless `WEB_CHAT_ENABLED=true`. Same input rules as 7C-lite. | High if loosened: the pane is a live Claude session |
| Exposure | docs only, no code for tunnels or TLS. Localhost default; non-loopback bind needs `WEB_ALLOW_REMOTE_BIND=true`. | Low |

## File Structure

| File | Responsibility |
|---|---|
| `src/dash/authStore.ts` | Open and migrate `.dashboard/auth.sqlite`; allowed account and pinned sub, sessions, pending logins, attempts, audit log, chat-send confirmations |
| `src/dash/oidc.ts` | OIDC client: discovery, JWKS cache, authorization URL with PKCE, token exchange, `verifyIdToken` |
| `src/dash/account.ts` | Allowed-account rules: `evaluateLogin` (sub pin, email match), `allowAccount` |
| `scripts/dashboard.ts` | Local owner CLI: `allow <email>`, `status`, `audit [n]` |
| `tests/helpers/fakeOidc.ts` | Fake OIDC provider for tests: locally generated keys and JWKS, in-process `fetch` stub, token minting with controllable claims |
| `src/dash/throttle.ts` | Login failure counting, lockout decisions (injected clock) |
| `src/dash/sessions.ts` | Create, validate, rotate and revoke sessions; CSRF token derivation |
| `src/dash/cookies.ts` | Cookie parse and serialize helpers |
| `src/dash/readDb.ts` | `openReadOnlyDb`, pagination helpers, `likePattern`, caps |
| `src/dash/clean.ts` | `cleanText`, `cleanRow` (untrusted text sanitation, redaction, truncation) |
| `src/dash/queries/jobs.ts` | Jobs list and detail, status buckets |
| `src/dash/queries/people.ts` | People list, per-person thread and message history |
| `src/dash/queries/mail.ts` | Sent emails, follow-ups, replies |
| `src/dash/queries/outcomes.ts` | Outcomes list, funnel with benchmarks |
| `src/dash/runlog.ts` | Run log reader with stub fallback |
| `src/dash/sessionsPanel.ts` | tmux windows with last non-empty output line |
| `src/dash/configView.ts` | Masked config view |
| `src/web/server.ts` (modify) | Router, auth middleware, security headers, API wiring |
| `src/web/router.ts` | Tiny route table and request helpers (JSON body cap, query parsing) |
| `src/web/chat.ts` | Prepare and confirm chat send |
| `src/web/static/index.html`, `app.js`, `api.js`, `dom.js`, `views/*.js`, `style.css` | Frontend modules (no build) |
| `src/web/page.ts` (modify) | Reduced to loading the static files into an in-memory map |
| `scripts/web.ts` (modify) | Runner: auth store, read-only db, new env keys |
| `docs/dashboard-exposure.md` | Exposure options (Tailscale, Cloudflare Tunnel, reverse proxy with TLS) |
| `.env.example`, `.gitignore`, `package.json`, `src/platform/checks.ts` (modify) | Env keys, `.dashboard/` ignore, `dashboard` script and `jose` dependency, doctor checks |

---

## Task 1: Auth store

**Files:** create `src/dash/authStore.ts`, `tests/dash-auth-store.test.ts`; modify `.gitignore` (append `.dashboard/` if missing).

```ts
// src/dash/authStore.ts
import type BetterSqlite3 from 'better-sqlite3';

export type AuthDb = BetterSqlite3.Database;

export function openAuthStore(path: string): AuthDb;        // creates dir (700) and file (600), runs migrations, WAL on
export interface AllowedAccount { email: string; sub: string | null; setAt: string; pinnedAt: string | null }
export function getAllowedAccount(db: AuthDb): AllowedAccount | null;
export function setAllowedEmail(db: AuthDb, email: string, now: Date): void;   // upsert; ALWAYS clears sub and pinnedAt; revokes every session in the same transaction
export function pinSub(db: AuthDb, sub: string, now: Date): boolean;            // true only if sub is currently null (atomic compare-and-set); false otherwise
export interface PendingLogin { stateHash: string; nonce: string; verifier: string; reauth: boolean; sessionHash: string | null; createdAt: string; expiresAt: string }
export function savePendingLogin(db: AuthDb, p: PendingLogin): void;
export function takePendingLogin(db: AuthDb, stateHash: string, now: Date): PendingLogin | null;  // deletes the row in the same transaction; null when unknown or expired (single use)
export type AuditKind = 'login_ok' | 'login_denied' | 'login_error' | 'sub_pinned' | 'allow_changed' | 'lockout' | 'logout' | 'session_expired' | 'reauth_ok' | 'chat_prepare' | 'chat_send' | 'chat_reject';
export function audit(db: AuthDb, kind: AuditKind, detail: { ip?: string; note?: string; textHash?: string; idHint?: string }, now: Date): void;
export function listAudit(db: AuthDb, limit: number, beforeId?: number): { id: number; at: string; kind: string; ip: string | null; note: string | null }[]; // limit clamped 1..200
```

Tables (all `CREATE TABLE IF NOT EXISTS`): `allowed_account` (single row, `id INTEGER PRIMARY KEY CHECK (id = 1)`, `email`, `sub`, `set_at`, `pinned_at`), `pending_login (state_hash TEXT PRIMARY KEY, nonce, verifier, reauth INTEGER, session_hash, created_at, expires_at)`, `sessions (id_hash TEXT PRIMARY KEY, created_at, last_seen_at, auth_at, expires_at, ip, revoked_at)`, `login_attempts (id, at, ip, ok INTEGER)`, `audit_log (id, at, kind, ip, note, text_hash, id_hint)`, `chat_pending (token_hash TEXT PRIMARY KEY, session_hash TEXT, text_hash TEXT, expires_at, used_at)`.

Steps:
- [ ] Tests first (temp dir via `mkdtempSync(join(tmpdir(), 'dash-'))`): store file created with mode 600 and directory 700; `getAllowedAccount` null before `setAllowedEmail`; `setAllowedEmail` a second time with a different email clears a pinned sub and revokes sessions; `pinSub` succeeds once and then returns false (also under a second call with a different sub); `takePendingLogin` returns the row once, then null; an expired pending login returns null and is deleted; `audit` rows never contain a field named like a secret, `note` is truncated to 200 chars, `idHint` longer than 12 characters is cut; `listAudit` clamps `limit`.
- [ ] Implement. Prepared statements only, no string interpolation of values.
- [ ] Run `npx vitest run tests/dash-auth-store.test.ts` then `npx tsc -p . --noEmit`.
- [ ] Commit: `feat(dash): auth store with allowed account, pending logins, sessions and audit tables`.

## Task 2: OIDC client and fake provider

**Files:** create `src/dash/oidc.ts`, `tests/helpers/fakeOidc.ts`, `tests/dash-oidc.test.ts`; modify `package.json` (add `jose` to `dependencies` at the version already installed, run `npm install jose@<installed version>`, the one allowed install in this plan; no change to `engines`).

```ts
// src/dash/oidc.ts
export interface OidcConfig { issuer: string; clientId: string; clientSecret: string; redirectUri: string; reauthPrompt: 'login' | 'select_account'; maxAgeSec: number }
export interface OidcDeps { fetch: typeof fetch; now: () => Date; random: (n: number) => Buffer }
export interface AuthRequest { url: string; stateHash: string; nonce: string; verifier: string; state: string }
export function createOidc(cfg: OidcConfig, deps: OidcDeps): {
  discover(): Promise<void>;                                   // fetches {issuer}/.well-known/openid-configuration once, caches 24 h; requires doc.issuer === cfg.issuer exactly, https endpoints (http only for a loopback issuer in tests), S256 in code_challenge_methods_supported when present
  buildAuthRequest(opts: { reauth: boolean }): Promise<AuthRequest>;   // state and nonce 32 random bytes base64url, verifier 43 to 128 chars, challenge = base64url(sha256(verifier)), S256; scope 'openid email'; prompt = reauthPrompt and max_age=0 only when reauth
  exchangeCode(code: string, verifier: string): Promise<{ idToken: string }>;   // POST token endpoint, application/x-www-form-urlencoded, 5 s timeout, 256 KiB cap, no redirects; requires token_type Bearer and an id_token string
  verifyIdToken(idToken: string, expect: { nonce: string; notBefore?: Date }): Promise<{ sub: string; email: string; emailVerified: boolean; iat: number; authTime?: number }>;
};
```

Behaviour of `verifyIdToken`: `jwtVerify(token, localJwks, { issuer, audience: clientId, algorithms: ['RS256', 'ES256'], clockTolerance: 60, currentDate: now })`; then `nonce` equals the expected value (timing safe), `email_verified` is exactly `true`, `email` and `sub` are non-empty strings, `azp` equals the client id when `aud` is an array, `iat` is not more than 60 s in the future, and when `notBefore` is given (re-auth) `iat` must be at or after it minus the 60 s tolerance and `auth_time`, when present, must also be at or after it. JWKS handling: cached keys; on an unknown `kid` refetch once (at most every 60 s, otherwise fail), so rotation is handled; the JWKS URL comes only from the discovery document. Every failure throws `OidcError` with a short code (`discovery`, `exchange`, `signature`, `claims`, `nonce`, `unverified_email`); the message never contains a token.

Steps:
- [ ] Build `tests/helpers/fakeOidc.ts`: generate an RSA keypair in the test with `jose.generateKeyPair('RS256')`, export the public JWK with a `kid`, serve discovery, JWKS and token endpoints through an in-process `fetch` stub (no sockets, no network), mint ID tokens with controllable claims (`iss`, `aud`, `exp`, `iat`, `nonce`, `sub`, `email`, `email_verified`, `azp`, `auth_time`), support rotating to a second key and signing with an unknown `kid` or a different key.
- [ ] Tests first: a good token verifies; wrong `iss`, wrong `aud`, expired, wrong `nonce`, `email_verified: false` or missing, signature from another key, `alg: none`, an HS256 token signed with the public key bytes, a discovery document whose `issuer` differs, and a token endpoint response without `id_token` all fail with the right code; clock skew: `exp` 59 s in the past passes, 61 s fails, `iat` 59 s in the future passes, 61 s fails; key rotation: a token signed with a new `kid` verifies after exactly one JWKS refetch, and a second unknown `kid` within 60 s does not refetch again; `buildAuthRequest` URL carries `response_type=code`, `code_challenge_method=S256`, `state`, `nonce`, the exact `redirect_uri`, `prompt` and `max_age=0` only for re-auth, and the challenge equals `base64url(sha256(verifier))`; two requests never share a state; the client secret never appears in the authorization URL.
- [ ] Implement. Never log request bodies or tokens.
- [ ] Run `npx vitest run tests/dash-oidc.test.ts` then `npx tsc -p . --noEmit`.
- [ ] Commit: `feat(dash): OIDC client with PKCE, discovery, JWKS rotation and strict ID token checks`.

## Task 3: Allowed-account rules and owner CLI

**Files:** create `src/dash/account.ts`, `scripts/dashboard.ts`, `tests/dash-account.test.ts`; modify `package.json` (scripts `"dashboard": "tsx scripts/dashboard.ts"`), `.env.example` (append `DASHBOARD_ALLOWED_EMAIL=`, `WEB_OIDC_ISSUER=https://accounts.google.com`, `WEB_OIDC_CLIENT_ID=`, `WEB_OIDC_CLIENT_SECRET=`, `WEB_OIDC_REDIRECT_URI=http://127.0.0.1:8787/auth/callback`, `WEB_OIDC_REAUTH_PROMPT=select_account`, `WEB_REAUTH_MAX_AGE_SEC=300`, `WEB_AUTH_DB=.dashboard/auth.sqlite`; no inline comments).

```ts
// src/dash/account.ts
export type LoginDecision =
  | { ok: true; pinned: boolean }                      // pinned: this login pinned the sub
  | { ok: false; reason: 'no_account' | 'email_mismatch' | 'sub_mismatch' | 'unverified' };
export function normaliseEmail(s: string): string | null;       // trim, lower case, exactly one '@', no spaces, <= 254 chars; null otherwise
export function evaluateLogin(db: AuthDb, identity: { sub: string; email: string; emailVerified: boolean }, now: Date): LoginDecision;
// 1. no allowed account row: no_account. 2. emailVerified false: unverified. 3. email differs: email_mismatch.
// 4. stored sub null: pinSub (atomic) and ok with pinned true; if the pin lost a race, re-read and compare.
// 5. stored sub present: must equal identity.sub, else sub_mismatch. Both email and sub are always required.
export function allowAccount(db: AuthDb, email: string, now: Date): { ok: true } | { ok: false; reason: 'invalid_email' };
```

CLI (`scripts/dashboard.ts`, runs only on the machine; there is no web equivalent): `allow <email>` validates with `normaliseEmail`, asks `Replace the allowed account and clear the pinned identity? (y/N)` when an account already exists, calls `allowAccount`, prints the new email and "the next successful sign-in pins the account"; `status` prints the allowed email, whether a `sub` is pinned (yes or no, never the value), pinned date and active session count; `audit [n]` prints the last `n` (default 50, max 200) audit rows (time, kind, ip, note, only the first 8 characters of any hash). Bootstrap: when the store has no account and `DASHBOARD_ALLOWED_EMAIL` is set, `npm run web` writes it at start through `allowAccount`; the CLI is the only way to change it afterwards.

Steps:
- [ ] Tests first: first login with the right email pins the sub; second login with the same sub and email passes; same email but a different `sub` is `sub_mismatch` (the case of a recycled or re-created address); same `sub` but a changed email is `email_mismatch`; a different account is denied with no state change; unverified email denied before pinning; email comparison is case-insensitive but exact (no `+tag` folding, no subdomain match); two concurrent first logins with different subs pin exactly one (simulate by calling `pinSub` twice); `allowAccount` clears the pin and revokes sessions; invalid emails (`a@b@c`, empty, with spaces) rejected; CLI arguments are validated and an unknown subcommand exits 1 (unit-test the pure arg parser).
- [ ] Implement `scripts/dashboard.ts` with a plain `readline` confirm; exit codes 0 ok, 1 refused or invalid.
- [ ] Run `npx vitest run tests/dash-account.test.ts` then `npx tsc -p . --noEmit`.
- [ ] Commit: `feat(dash): single allowed account with pinned sub and local owner CLI`.

## Task 4: Throttle, sessions, CSRF, cookies

**Files:** create `src/dash/throttle.ts`, `src/dash/sessions.ts`, `src/dash/cookies.ts`, `tests/dash-sessions.test.ts`.

```ts
// src/dash/throttle.ts
export interface ThrottleDecision { allowed: boolean; retryAfterSec: number; scope: 'ip' | 'global' | null }
export function checkLogin(db: AuthDb, ip: string, now: Date): ThrottleDecision;   // reads login_attempts
export function recordLogin(db: AuthDb, ip: string, ok: boolean, now: Date): void; // prunes rows older than 24 h
// 10 failures per ip per 10 min -> 15 min lockout; 20 failures per hour total -> 1 h lockout. Applied to GET /auth/login and the callback.
// src/dash/sessions.ts
export interface SessionInfo { idHash: string; createdAt: string; authAt: string; expiresAt: string; csrf: string }
export function createSession(db: AuthDb, ip: string, authAt: Date, now: Date): { cookieValue: string; session: SessionInfo }; // revokes oldest beyond 3
export function validateSession(db: AuthDb, cookieValue: string | undefined, now: Date): SessionInfo | null;   // idle 30 min (sliding), absolute 12 h, revoked rows rejected; touches last_seen_at at most once per minute
export function refreshAuth(db: AuthDb, idHash: string, authAt: Date): void;      // after a successful re-auth for the same sub
export function isFresh(s: SessionInfo, now: Date, maxAgeSec: number): boolean;   // authAt within maxAgeSec
export function revokeSession(db: AuthDb, cookieValue: string): void;
export function csrfFor(sessionIdHash: string, serverKey: Buffer): string;       // HMAC-SHA256 hex of the id hash; the key is random per process start
export function csrfOk(expected: string, provided: string | undefined): boolean;  // timingSafeEqual over equal-length digests
// src/dash/cookies.ts
export function parseCookies(header: string | undefined): Record<string, string>;
export function sessionCookieName(secure: boolean): string;                      // '__Host-jobber_session' or 'jobber_session'
export function oidcCookieName(secure: boolean): string;                         // '__Host-jobber_oidc' or 'jobber_oidc'
export function serializeSession(value: string, secure: boolean, maxAgeSec: number): string; // 'HttpOnly; SameSite=Lax; Path=/' plus 'Secure' when secure
export function serializeOidc(value: string, secure: boolean): string;           // 'HttpOnly; SameSite=Lax; Path=/; Max-Age=600' plus 'Secure' when secure
export function clearCookie(name: string, secure: boolean): string;
```

Steps:
- [ ] Tests first with an injected `now`: 10 failures from one IP lock that IP for 15 minutes (`retryAfterSec` > 0) while another IP is still allowed; 20 failures across IPs lock everyone for an hour; the lock expires; a success does not reset the global count; session valid, then rejected after 31 minutes idle, after 12 h absolute, after `revokeSession`; the 4th session revokes the oldest; the DB stores only the SHA-256 of the cookie value (query the table and assert the raw value is absent); `isFresh` true at 299 s and false at 301 s for a 300 s window, and `refreshAuth` makes it fresh again; `csrfOk` true for the right token, false for missing, wrong length and wrong value; cookie attributes for both `secure` modes (the session cookie is `SameSite=Lax`).
- [ ] Implement; cookie value is 32 random bytes hex.
- [ ] Run `npx vitest run tests/dash-sessions.test.ts` then `npx tsc -p . --noEmit`.
- [ ] Commit: `feat(dash): login throttling, server-side sessions, csrf and cookie helpers`.

## Task 5: Read-only data layer and text cleaning

**Files:** create `src/dash/readDb.ts`, `src/dash/clean.ts`, `tests/dash-readdb.test.ts`, `tests/dash-clean.test.ts`.

```ts
// src/dash/readDb.ts
export function openReadOnlyDb(path?: string): BetterSqlite3.Database; // path defaults to dbPath(); readonly, fileMustExist, PRAGMA query_only=1, busy_timeout 2000
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;
export const MAX_Q = 64;
export function clampLimit(raw: unknown): number;               // NaN, <1 -> DEFAULT_LIMIT; > MAX_LIMIT -> MAX_LIMIT
export function parseCursor(raw: unknown): number | null;       // positive safe integer or null (keyset: id < cursor)
export function likePattern(q: string): string;                 // trims, cuts to MAX_Q, escapes %, _ and \ ; returns '%' + q + '%' (use with ESCAPE '\\')
export function tableExists(db: BetterSqlite3.Database, name: string): boolean;
export interface Page<T> { items: T[]; nextCursor: number | null }
// src/dash/clean.ts
export function cleanText(s: unknown, maxLen: number): string;
// strips C0/C1 control chars except \n and \t, Unicode bidi overrides and isolates (U+202A-202E, U+2066-2069), zero-width and format
// characters (reuse the set used by src/atsText.ts if exported; do not copy-paste a second list), collapses runs of 3+ newlines,
// runs redactSecrets from src/web/server.ts (move it to src/safety/redact.ts in this task and re-export, so both import one function),
// truncates to maxLen with a trailing '...'.
export function cleanRow<T extends Record<string, unknown>>(row: T, limits: Record<string, number>, defaultMax?: number): T; // strings cleaned, other types untouched
```

Steps:
- [ ] Tests first: a file-backed temp database (created with `better-sqlite3` in the test) opened through `openReadOnlyDb` rejects `INSERT` and `CREATE TABLE` with an error; a missing file throws; `clampLimit` cases (`'abc'`, `-5`, `0`, `1000`, `'30'`); `likePattern('50%_off\\')` escapes all three; `cleanText` removes a bidi override and a zero-width space, keeps `\n`, redacts an `sk-`-shaped secret and a line containing `WEB_TOKEN`, truncates to the limit, returns `''` for null and non-strings; `cleanRow` applies per-field limits.
- [ ] Move `redactSecrets` and its `SECRET_SHAPES` use from `src/web/server.ts` into `src/safety/redact.ts` (export `redactSecrets`), keep `src/web/server.ts` importing it; the 7C-lite web tests must still pass.
- [ ] Run `npx vitest run tests/dash-readdb.test.ts tests/dash-clean.test.ts tests/web-server.test.ts` then `npx tsc -p . --noEmit`.
- [ ] Commit: `feat(dash): read-only database handle, pagination helpers and untrusted-text cleaning`.

## Task 6: Jobs and people queries

**Files:** create `src/dash/queries/jobs.ts`, `src/dash/queries/people.ts`, `tests/dash-queries-jobs-people.test.ts`.

Read first: the `jobs`, `applications`, `outreach_queue`, `connections` definitions in `src/db.ts` and the `people`, `contact_state`, `touches` definitions in `src/outreach/schema.ts`. Find the real `status` values for `jobs.status`, `applications.status` (grep `src/db.ts` and `src/apply/` for `'submitted'`, `'manual_review'`, `'needs_answer'`, `'failed'`) and `outreach_queue.status` / `email_status` / `connect_status` / `apply_status`, and put the discovered set in the module as typed constants; do not invent values.

```ts
// src/dash/queries/jobs.ts
export type JobBucket = 'discovered' | 'matched' | 'applied' | 'pending' | 'failed';
export interface JobRow { id: string; title: string; company: string; source: string; score: number | null; confidence: string | null;
  excluded_reason: string | null; posted_at: string | null; deadline: string | null; created_at: string; bucket: JobBucket[] ; flags: string[] }
export function listJobs(db, opts: { bucket?: JobBucket; q?: string; cursor?: number | null; limit?: number; threshold?: number }): Page<JobRow>;
export function jobCounts(db, threshold: number): Record<JobBucket, number>;
export interface JobDetail extends JobRow { url: string | null; apply_url: string | null; strengths: string[]; gaps: string[]; requirements: string[];
  queue: { id: number; status: string; email_status: string | null; connect_status: string | null; apply_status: string | null; ats_coverage: number | null }[];
  applications: { platform: string | null; method: string | null; status: string | null; reason: string | null; applied_at: string | null }[];
  outcomes: { outcome: string; note: string | null; created_at: string }[] }
export function jobDetail(db, id: string): JobDetail | null;     // description is NOT included; jd_snapshot is never returned
// src/dash/queries/people.ts
export interface PersonRow { id: number; platform: string; name: string | null; headline: string | null; company: string | null; category: string;
  stage: string | null; followups_sent: number | null; last_touch_at: string | null; next_due_at: string | null; paused_reason: string | null }
export function listPeople(db, opts: { q?: string; stage?: string; cursor?: number | null; limit?: number }): Page<PersonRow>;
export interface Touch { id: number; job_id: string | null; kind: string; status: string; body: string | null; created_at: string; sent_at: string | null }
export function personThread(db, personId: number, opts: { cursor?: number | null; limit?: number }): { person: PersonRow; touches: Page<Touch> } | null;
```

Rules: buckets are derived, not stored. `matched` = `score >= threshold` and `excluded_reason IS NULL` (same definition as `funnelStats`; reuse its CONTACTED logic rather than redefining by importing or exporting from `src/funnel.ts`), `applied` = a `submitted` row in `applications`, `pending` = queued rows in `outreach_queue` or application rows awaiting action, `failed` = failed rows in `applications` or `outreach_queue`. A job can carry several buckets. List columns exclude `description`, `jd_snapshot`, `body`; `jobDetail` JSON columns (`strengths`, `gaps`, `requirements`) are parsed in a try/catch and fall back to `[]`. Every string goes through `cleanRow`. Keyset pagination on a stable ordering (`created_at DESC, id` for jobs uses a rowid alias; document the choice). Every query tolerates a missing table (`tableExists`) and returns an empty page.

Steps:
- [ ] Tests first against `openDb(':memory:')` plus `migrateOutreachTables`, seeding synthetic rows: bucket counts, a job in two buckets, `q` search with `%` in the input matches literally, `limit=1000` returns at most 100, cursor paging returns disjoint pages and ends with `nextCursor: null`, an HTML-looking company name and a bidi-override title come back cleaned, `jobDetail` for an unknown id is `null`, description and `jd_snapshot` absent from every result, missing-table fallback.
- [ ] Implement with prepared statements; `ORDER BY ... LIMIT ?` always applied with `limit + 1` to compute `nextCursor`.
- [ ] Run `npx vitest run tests/dash-queries-jobs-people.test.ts` then `npx tsc -p . --noEmit`.
- [ ] Commit: `feat(dash): paginated job and person conversation queries`.

## Task 7: Mail, outcomes, funnel and run log queries

**Files:** create `src/dash/queries/mail.ts`, `src/dash/queries/outcomes.ts`, `src/dash/runlog.ts`, `tests/dash-queries-mail-outcomes.test.ts`.

```ts
// src/dash/queries/mail.ts
export interface SentEmail { id: number; job_id: string; title: string | null; company: string | null; to: string | null; subject: string | null;
  sent_at: string | null; thread_id: string | null; status: string | null; has_reply: boolean }
export function listSentEmails(db, opts: { q?: string; cursor?: number | null; limit?: number }): Page<SentEmail>;   // outreach_queue where email_sent_at IS NOT NULL
export interface EmailDetail extends SentEmail { body: string | null; followups: FollowupRow[]; replies: ReplyRow[] }
export function emailDetail(db, queueId: number): EmailDetail | null;      // body capped at 20000 chars
export interface FollowupRow { id: number; job_id: string; n: number; status: string; subject: string | null; body: string | null; created_at: string; sent_at: string | null }
export function listFollowups(db, opts: { status?: string; cursor?: number | null; limit?: number }): Page<FollowupRow>;
export interface ReplyRow { message_id: string; job_id: string | null; classification: string | null; action: string | null; proposed_outcome: string | null; from_addr: string | null; subject: string | null; reply_date: string | null }
export function listReplies(db, opts: { cursor?: number | null; limit?: number }): Page<ReplyRow>;  // processed_messages; message_id is TEXT so paginate by rowid
// src/dash/queries/outcomes.ts
export function listOutcomes(db, opts: { outcome?: string; cursor?: number | null; limit?: number }): Page<{ id: number; job_id: string; title: string | null; company: string | null; outcome: string; note: string | null; created_at: string }>;
export function funnelView(db, threshold: number): Funnel;   // thin wrapper of funnelStats from src/funnel.ts, adds nothing else
// src/dash/runlog.ts
export type RunLog = { available: false; note: string } | { available: true; items: { id: number; started_at: string; finished_at: string | null; kind: string; status: string; summary: string | null }[] };
export function readRunLog(db, limit?: number): RunLog;       // `run_log` table absent -> { available:false, note:'run log table not present (plan 6D)' }
```

Rules: `funnelView` returns the exact `Funnel` (including `benchmarks`) so the page can show `reply 15% (typical 3%, 2-13%)` the way `/status` does; reply text fields (`from_addr`, `subject`) are untrusted and cleaned; `to` is shown as stored. No reply body is stored in the data database, so none is returned.

Steps:
- [ ] Tests first (in-memory db, synthetic rows): sent email list order and paging, a follow-up shown under its email detail, a reply matched by `job_id`, `has_reply` true only with a processed message of a non-noise class (read `src/replyTriage.ts` for class names), outcomes filter, funnel equals `funnelStats` for the same db (assert deep equality), run log stub when the table is missing and real rows when a test creates the table, limit cap on every list.
- [ ] Run `npx vitest run tests/dash-queries-mail-outcomes.test.ts` then `npx tsc -p . --noEmit`.
- [ ] Commit: `feat(dash): sent mail, follow-up, reply, outcome, funnel and run log queries`.

## Task 8: Sessions panel, config view, status bundle

**Files:** create `src/dash/sessionsPanel.ts`, `src/dash/configView.ts`, `tests/dash-panels.test.ts`.

```ts
// src/dash/sessionsPanel.ts
export interface SessionLine { window: string; index: number; command: string; active: boolean; lastLine: string }
export async function sessionsPanel(run: Run, sessions: string[], capLines?: number): Promise<{ session: string; up: boolean; windows: SessionLine[] }[]>;
// uses listWindows and capture from src/platform/tmux.ts (capture lines 20); lastLine = last non-empty line, cleanText(.., 200); sessions is the configured list
// (WEB_TMUX_SESSION, default 'ccgram', plus 'ccgram-daemon'); window names failing assertName are skipped, never passed to tmux.
// src/dash/configView.ts
export interface ConfigItem { name: string; value: string; masked: boolean }
export interface ConfigView { env: ConfigItem[]; files: { path: string; summary: Record<string, unknown> }[]; halts: Snapshot['halts']; ceilings: Snapshot['ceilings'] }
export function maskValue(name: string, value: string | undefined): ConfigItem;
export function buildConfigView(deps: { root: string; env: NodeJS.ProcessEnv; read: (p: string) => string | null; snapshot: Snapshot }): ConfigView;
```

Config view rules: the list of env names comes from parsing `.env.example` (committed, names only), never from reading `.env`. A name is shown with its value only when it is in an explicit allowlist (`MATCH_THRESHOLD`, `SEND_LIMIT_PER_RUN`, every `MAX_*`, `*_PER_DAY`, `*_PER_WEEK`, `WEB_PORT`, `WEB_TMUX_SESSION`, `WEB_TMUX_WINDOW`, `WEB_CHAT_ENABLED`, `AUTO_UPDATE`, `NAUKRI_HEADLESS`, `*_HYBRID_FALLBACK`); every other name shows `set` or `unset` only. Any name matching `/TOKEN|SECRET|PASS|KEY|COOKIE|CREDENTIAL|AUTH/i` is `masked: true` with value `set` or `unset` even if it were in the allowlist. Config files come from a fixed list (`config/portals.json`, `config/target-regions.json`, `config/deal-breakers.json`, `config/replies.json`, `config/permission-sets.json`, `config/ccgram.pin.json`); the view returns a summary (top-level keys, array lengths, booleans, numbers), not full contents, and never reads `user-data/`, `secrets/`, `.env` or `.dashboard/`. Both modules run results through `cleanText`.

Steps:
- [ ] Tests first with a fake `Run` and fake `read`: last line extraction (trailing blanks, ANSI-looking control characters cleaned), a planted `sk-` secret in pane output redacted, a hostile window name (`a;b`) never reaches tmux, a missing session reports `up: false`; `maskValue` for `GMAIL_APP_PASSWORD` and `TELEGRAM_BOT_TOKEN` is masked with no value, allowlisted `MATCH_THRESHOLD` shows its value, an unknown name shows only `set`; the config view never calls `read` with a path containing `user-data`, `secrets`, `.env` or `.dashboard`.
- [ ] Run `npx vitest run tests/dash-panels.test.ts` then `npx tsc -p . --noEmit`.
- [ ] Commit: `feat(dash): tmux sessions panel and masked config view`.

## Task 9: HTTP server v2: router, auth, headers, API wiring

**Files:** create `src/web/router.ts`; modify `src/web/server.ts`, `src/web/page.ts`, `tests/web-server.test.ts` (extend; update the cases that used `WEB_TOKEN`); create `tests/web-api.test.ts`.

```ts
// src/web/router.ts
export interface Ctx { req: IncomingMessage; res: ServerResponse; url: URL; ip: string; secure: boolean; session: SessionInfo | null }
export type Handler = (ctx: Ctx) => Promise<void> | void;
export function json(res: ServerResponse, status: number, body: unknown): void;     // always Cache-Control: no-store; body capped at 1 MB (500 + error otherwise)
export function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown>; // 413 on over, 415 unless application/json
// src/web/server.ts (replaces WebDeps)
export interface WebDeps {
  port: number;
  bind: string;                       // default '127.0.0.1'; non-loopback only when allowRemoteBind
  allowRemoteBind: boolean;
  allowedHosts: string[];             // extra Host values (tunnel hostnames); loopback with port always allowed
  trustProxy: boolean;                // WEB_TRUST_PROXY
  auth: AuthDb;
  oidc: ReturnType<typeof createOidc>;   // Task 2; tests pass one built on the fake provider
  oidcCfg: { redirectUri: string; reauthMaxAgeSec: number };
  data: BetterSqlite3.Database;       // read-only
  cfg: OutreachConfig;
  run: Run;
  sessionsToShow: string[];
  chat: { enabled: boolean; session: string; window: string; send: (text: string) => Promise<void> };
  now?: () => Date;
  csrfKey?: Buffer;                   // tests pass a fixed key
}
export function createWebServer(deps: WebDeps): Server;   // throws if bind is non-loopback and !allowRemoteBind
```

Routes (all `GET` unless noted; every route except the static shell, `GET /api/health` and `POST /api/login` requires a valid session, else 401 `{error:'unauthenticated'}`):
Routes (all `GET` unless noted; every route except the static shell, `GET /api/health`, `GET /auth/login` and `GET /auth/callback` requires a valid session, else 401 `{error:'unauthenticated'}`):
| Route | Result |
|---|---|
| `GET /`, `/app.js`, `/api.js`, `/dom.js`, `/style.css`, `/views/<name>.js` | static files from the in-memory map; anything else 404 |
| `GET /api/health` | `{ ok: true }` (no data, for tunnels and doctor) |
| `GET /auth/login[?reauth=1]` | Throttle check, then `buildAuthRequest`, store the pending login, set the `jobber_oidc` cookie (holds the raw `state`), 302 to the issuer's authorization endpoint. `reauth=1` needs a valid session. No other parameter is read; there is no `next` or `return_to`. |
| `GET /auth/callback?code&state` | See "Callback behaviour" below. Always ends in a 302 to `/` (success) or a 302 to `/#/denied` (any failure), never a different location. |
| `POST /api/logout` | revokes, clears cookie, audit |
| `GET /api/session` | `{ csrf, expiresAt, authAt, chatEnabled, reauthRequired }` |
| `GET /api/status` | the 7C-lite snapshot (cleaned) |
| `GET /api/jobs?bucket&q&cursor&limit`, `GET /api/jobs/counts`, `GET /api/jobs/:id` | Task 6 |
| `GET /api/people?q&stage&cursor&limit`, `GET /api/people/:id/thread?cursor&limit` | Task 6 |
| `GET /api/emails?q&cursor&limit`, `GET /api/emails/:id`, `GET /api/followups?status&cursor&limit`, `GET /api/replies?cursor&limit` | Task 7 |
| `GET /api/outcomes?outcome&cursor&limit`, `GET /api/funnel` | Task 7 |
| `GET /api/sessions`, `GET /api/pane?window=<name>` | Task 8; `window` must be a window of a configured session, last 40 lines, redacted |
| `GET /api/runs`, `GET /api/config` | Task 7, Task 8 |
| `GET /api/audit?limit&before` | login and send audit rows (ip, kind, time) |

Callback behaviour: the order is fixed and every failure is the same generic redirect with a `login_denied` or `login_error` audit row (reason code only, plus a 12 character hash of the email or sub when known). (1) Reject with 429 and `Retry-After` when `checkLogin` says locked. (2) Require a `state` query value whose SHA-256 equals both the `jobber_oidc` cookie's hash and a stored, unexpired pending login (`takePendingLogin`, which consumes it); a provider `error` parameter, a missing `code`, or a replayed `state` fails. (3) `exchangeCode` with the stored verifier, then `verifyIdToken` with the stored nonce (and `notBefore` for a re-auth). (4) `evaluateLogin` (Task 3). (5) Record the attempt, clear the `jobber_oidc` cookie. Success: audit `login_ok` (and `sub_pinned` on the first login), create the session with `authAt` from the token `iat`, rotate any existing session, set the cookie. A re-auth callback must carry the same `sub` as the session it was started from, then calls `refreshAuth` and audits `reauth_ok`; it does not create a new session. All failures return the same redirect whether the account was wrong, the token was bad or the provider was down (the audit row tells them apart).

Global rules, each with a test:
1. Host header must be `127.0.0.1:<port>`, `localhost:<port>`, or in `allowedHosts` (421 otherwise). Bind refuses non-loopback unless `allowRemoteBind`.
2. Response headers on every response: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`; plus `Strict-Transport-Security: max-age=31536000` only when `secure`.
3. No `Access-Control-*` header on any response; an `OPTIONS` request gets 405.
4. Every non-GET except login needs `X-CSRF-Token` equal to the session's token (403) and an `Origin` equal to the page origin (403). Any other method or unknown route: 405 or 404.
5. Per-session request rate limit: 120 requests per minute (429).
6. Query strings: unknown parameters ignored; `limit` and `cursor` and `q` normalised by Task 5 helpers; path ids must match `^\d{1,12}$` (or `^[A-Za-z0-9:_.-]{1,128}$` for job ids), else 400.
7. Errors never include stack traces or SQL text: a handler exception returns 500 `{error:'internal'}` and logs only the route and error name to stderr.
8. `secure` is true only when `trustProxy` and `X-Forwarded-Proto: https`; client `ip` is the socket address, or the first `X-Forwarded-For` entry only when `trustProxy`.
9. `src/web/page.ts` becomes `loadStatic(dir): Map<string, { type: string; body: Buffer }>` reading `src/web/static/**` once at start (fixed extension allowlist `.html .js .css`); nothing is read per request.

Steps:
- [ ] Tests first (ephemeral port `listen(0, '127.0.0.1')`, injected `now`, temp auth store, in-memory data db with synthetic rows, fake `run`, the fake OIDC provider from Task 2 wired in with a stub `fetch`, no network): wrong Host 421; every API route 401 without a cookie; a full login (login redirect, minted code, callback) sets the session cookie with `HttpOnly` and `SameSite=Lax`, and no `Secure` on plain http; the first login pins the sub; a replayed callback (same `state`) is denied; a callback with a state the browser did not start (no or wrong `jobber_oidc` cookie) is denied; a token for a different account, an unverified email, a wrong nonce and an expired token all produce the identical redirect and an audit row with the right reason; a second login with the same email but a different `sub` is denied; lockout 429 after 10 denied callbacks; `/auth/login` with an extra `next=https://evil.example` still redirects only to the issuer; the callback never redirects anywhere but `/` or `/#/denied`; `Secure` and `__Host-` cookie appear only with `trustProxy` plus the forwarded proto header; logout then the old cookie 401; POST without CSRF 403; POST with a foreign Origin 403; headers present on a 401, a 404 and a 200; no `access-control-*` header; `GET /api/jobs?limit=100000` returns at most 100; a stored job title containing `<img src=x onerror=1>` is returned as inert JSON string (and the static files contain no `innerHTML`); `/api/pane` redacts a planted secret; `/api/config` has no value for a planted `WEB_OIDC_CLIENT_SECRET` or `GMAIL_APP_PASSWORD`; path traversal attempts (`/../.env`, `/%2e%2e/secrets/x`) 404; creating the server with `bind: '0.0.0.0'` throws unless `allowRemoteBind`.
- [ ] Implement the router and the wiring. Keep `redactSecrets`, Host/Origin helpers and headers code from 7C-lite where they exist; remove the token login and in-memory session set.
- [ ] Run `npx vitest run tests/web-server.test.ts tests/web-api.test.ts` then `npx tsc -p . --noEmit`.
- [ ] Commit: `feat(web): session-authenticated read-only API with csrf, throttling and strict headers`.

## Task 10: Confirmed chat send

**Files:** create `src/web/chat.ts`, `tests/web-chat.test.ts`; modify `src/web/server.ts` (register two routes, remove 7C-lite's `POST /api/send`).

```ts
// src/web/chat.ts
export const STATUS_COMMANDS: readonly string[];        // import from the 7C-lite module, do not redefine
export function validateChatText(text: unknown): { ok: true; text: string } | { ok: false; reason: string };
// same rules as sendText: string, trimmed non-empty, <= 2000 chars, no control characters (incl. newline, tab), not starting with '!',
// a leading '/' only for STATUS_COMMANDS words; plus: reject a text containing the literal WEB_AUTH_DB or the strings 'rm -rf' is NOT a goal;
// do not add keyword blocklists, the permission set and the slash rule are the guard.
export function prepareSend(auth: AuthDb, sessionIdHash: string, text: string, now: Date): { token: string; expiresInSec: 60; preview: string };
// stores sha256(token), sha256(text), session hash, 60 s expiry; preview = the exact text (cleaned for display only; the stored hash is of the raw text)
export function confirmSend(auth: AuthDb, sessionIdHash: string, token: string, text: string, now: Date): { ok: true } | { ok: false; reason: 'unknown' | 'expired' | 'used' | 'mismatch' | 'session' };
// single use; text must hash-equal the prepared text; same session only; constant-time compares
```

Endpoints: `POST /api/send/prepare` `{ text }` first requires a fresh sign-in (`isFresh(session, now, reauthMaxAgeSec)`); when stale it returns 401 `{error:'reauth_required', url:'/auth/login?reauth=1'}` and the page sends the owner through the re-auth round trip (Task 9), then retries. When fresh it returns `{ token, preview }` and audits `chat_prepare` (text hash only, never the text). `POST /api/send/confirm` `{ token, text }` re-validates the text, re-checks freshness (so the window also covers the gap between prepare and confirm), calls `confirmSend`, enforces at most one send per 2 s per session (429), then `deps.chat.send(text)` (which calls `sendText` into the configured session and window), audits `chat_send` with the text hash. Disabled (404) unless `chat.enabled`. Both require CSRF, Origin and a session like every POST. The frontend shows the exact text in a confirm step and sends only on an explicit button press.

Steps:
- [ ] Tests first: prepare then confirm calls `send` once with the exact text; confirm with a different text is `mismatch` and does not send; a token reused is `used`; a token after 61 s is `expired`; another session cannot confirm; disabled flag 404; a session whose `authAt` is older than the window gets 401 `reauth_required` at prepare and at confirm, and works after `refreshAuth`; `!ls`, `\n`, 2001 chars, `/login-as-admin` rejected at prepare with 400 (and `chat_reject` audited); `/limits` allowed; second send within 2 s is 429; audit rows contain a hash and no raw text; no GET route reaches `send`.
- [ ] Run `npx vitest run tests/web-chat.test.ts tests/web-server.test.ts` then `npx tsc -p . --noEmit`.
- [ ] Commit: `feat(web): two-step confirmed chat send with audit`.

## Task 11: Frontend modules (no build step)

**Files:** create `src/web/static/index.html`, `style.css`, `app.js`, `api.js`, `dom.js`, `views/login.js`, `views/overview.js`, `views/jobs.js`, `views/people.js`, `views/mail.js`, `views/outcomes.js`, `views/sessions.js`, `views/runs.js`, `views/config.js`, `views/chat.js`, `views/audit.js`; create `tests/web-frontend-lint.test.ts`.

Design:
- `index.html`: one `<div id="app">`, `<script type="module" src="/app.js">`, `<link rel="stylesheet" href="/style.css">`, viewport meta, no inline script or style (CSP).
- `dom.js`: `el(tag, props, ...children)` creating elements with `textContent` for strings and a fixed allowlist of attributes (`class`, `id`, `type`, `value`, `disabled`, `placeholder`, `aria-*`, `data-*`); `href` is not allowed; `clear(node)`; `table(columns, rows)`.
- `api.js`: `get(path, params)` and `post(path, body)` using `fetch` with `credentials: 'same-origin'`, adds `X-CSRF-Token` from `/api/session` on POST, turns 401 into a login redirect, and surfaces 429 `Retry-After`.
- `app.js`: hash router (`#/jobs`, `#/people/12`, ...), top nav, light and dark via CSS `prefers-color-scheme` and CSS variables, layout works at 360 px width (single column, tables become stacked cards under 640 px via CSS), 16 px base font, 44 px touch targets, visible focus, `aria-live` for status.
- Login view (`views/login.js`): one "Sign in" button inside a `<form method="get" action="/auth/login">` (no script navigation, no `href` building) and a generic denied message at `#/denied` that never says which check failed. A `reauth_required` response from the send endpoint shows a "Confirm it is you" button that is a form to `/auth/login` with a hidden `reauth=1`.
- Views: overview (counts, funnel line with benchmarks, halts, ceilings, queue), jobs (bucket tabs, search, load-more with `nextCursor`, detail panel), people (list, thread with message history rendered as plain text blocks), mail (sent, follow-ups, replies tabs), outcomes (list plus funnel bars drawn as `div` widths), sessions (windows, command, last line, live pane polling every 10 s, paused when `document.hidden`), runs (stub notice when `available:false`), config (masked items shown with a "masked" badge), audit, chat (only when `chatEnabled`; text box, Preview button, then explicit Confirm and Cancel).
- Long text (message bodies) is placed in a `<pre>` via `textContent`, never parsed.

Steps:
- [ ] Tests first (`tests/web-frontend-lint.test.ts`, reads the files, no browser): none of `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`, `new Function`, `setTimeout("`, `javascript:`, `.href =` or `setAttribute('href'` appears in `src/web/static/**`; `index.html` has no inline `<script>` body, no `style=` attribute and no `on...=` handler; every `views/*.js` import resolves to an existing file; `index.html` contains the viewport meta; `style.css` contains both `prefers-color-scheme: dark` and a `max-width` media query; no file references `localStorage` for anything but a theme or last-tab value (assert none store tokens or csrf).
- [ ] Implement the files. Keep each view under about 150 lines.
- [ ] Add a server test in `tests/web-api.test.ts`: `GET /` returns the shell with the CSP header; every file in the static map is reachable and has the right content type.
- [ ] Run `npx vitest run tests/web-frontend-lint.test.ts tests/web-api.test.ts` then `npx tsc -p . --noEmit`.
- [ ] Commit: `feat(web): static no-build dashboard frontend, light and dark, phone friendly`.

## Task 12: Runner, env keys, doctor checks

**Files:** modify `scripts/web.ts`, `.env.example` (append), `src/platform/checks.ts`, `tests/platform-doctor.test.ts` (extend).

1. `scripts/web.ts` reads: `WEB_PORT` (default 8787, integer 1024 to 65535), `WEB_BIND` (default `127.0.0.1`), `WEB_ALLOW_REMOTE_BIND` (default false), `WEB_ALLOWED_HOSTS` (comma list, each validated as a hostname or `host:port`), `WEB_TRUST_PROXY` (default false), `WEB_AUTH_DB` (default `.dashboard/auth.sqlite`), `WEB_CHAT_ENABLED` (default false), `WEB_TMUX_SESSION`, `WEB_TMUX_WINDOW`, and the OIDC keys `WEB_OIDC_ISSUER` (default `https://accounts.google.com`), `WEB_OIDC_CLIENT_ID`, `WEB_OIDC_CLIENT_SECRET`, `WEB_OIDC_REDIRECT_URI`, `WEB_OIDC_REAUTH_PROMPT` (`login` or `select_account`, default `select_account` for the Google issuer and `login` otherwise), `WEB_REAUTH_MAX_AGE_SEC` (default 300, range 60 to 3600), `DASHBOARD_ALLOWED_EMAIL`. It refuses to start (prints why, exit 1, never prints a secret value) when: no allowed account exists in the store and `DASHBOARD_ALLOWED_EMAIL` is unset or invalid ("run npm run dashboard -- allow <email>"), a required OIDC key is missing, the issuer is not an https URL, the redirect URI is not `https://` and not `http://127.0.0.1` or `http://localhost` with path `/auth/callback`, the redirect URI host is not in the Host allowlist, the port or a host value is invalid, or the bind is non-loopback without `WEB_ALLOW_REMOTE_BIND=true`. It opens the data database only with `openReadOnlyDb()`, runs discovery once at start (a failure is a warning, retried on the first login), and prints only `http://<bind>:<port>`.
2. `.env.example`: Task 3 appended the OIDC and account keys; append the remaining keys above with one-line comments on their own lines (append only).
3. `scripts/dashboard.ts audit` (Task 3) is the audit viewer; no separate script.
4. Doctor (replace the 7C-lite `web` check, keep its id `web`, add `dashboard-login`): `fail` when `.dashboard/` or `auth.sqlite` has group or world permissions; `warn` when no allowed account is stored ("run npm run dashboard -- allow <email>"); `warn` when an account is stored but no `sub` is pinned yet ("the first sign-in pins the account; do it now"); `warn` when the stored email differs from `DASHBOARD_ALLOWED_EMAIL`; `fail` when a required OIDC key is missing or the redirect URI breaks the scheme rule; `warn` when `WEB_BIND` is non-loopback, `WEB_TRUST_PROXY=true` without `WEB_ALLOWED_HOSTS`, or `WEB_CHAT_ENABLED=true` while the permission set (via `detectSet` on `.claude/settings.local.json`) is not `read_only`; `pass` otherwise. It is file-based and offline: it reads only the auth file's mode and the allowed-account row; it never prints a secret, the `sub` value or the email beyond its domain.
5. Add `.dashboard/` to `.gitignore` if Task 1 did not.

Steps:
- [ ] Tests first (doctor, using the existing `ctxWith` fake file system pattern): each warn and fail case above; no secret value appears in any `detail` or `fix` string.
- [ ] Run `npx vitest run tests/platform-doctor.test.ts` then `npx tsc -p . --noEmit && npm run doctor`.
- [ ] Commit: `feat(web): dashboard runner, env keys and doctor checks`.

## Task 13: Exposure documentation

**Files:** create `docs/dashboard-exposure.md`, `tests/dash-docs.test.ts`; modify `README.md` (one link line in the dashboard section from 7C-lite).

The doc is short (about 120 lines), written for a non-expert owner, and covers:
1. The default: binds `127.0.0.1`, only reachable from the same machine; use it as is on a laptop; from a phone on the same Mac use a tunnel from the list below, never open the port or set `WEB_BIND=0.0.0.0`.
2. Sign-in is mandatory whatever the exposure: one allowed account through OpenID Connect (Google by default). Changing the account is a command on the machine only (`npm run dashboard -- allow <email>`); if the owner's Google email changes, or the account is lost, that is the recovery path. The redirect URI registered at the provider must be `https://<your hostname>/auth/callback`, or `http://127.0.0.1:8787/auth/callback` for localhost only.
3. Options, each with exact steps, what it protects, what it does not, and the env values to set (`WEB_ALLOWED_HOSTS`, `WEB_TRUST_PROXY`):
3. Options, each with exact steps, what it protects, what it does not, and the env values to set (`WEB_ALLOWED_HOSTS`, `WEB_TRUST_PROXY`, `WEB_OIDC_REDIRECT_URI`):
   - **Tailscale** (`tailscale serve --bg 8787` for tailnet-only HTTPS; avoid `funnel` unless the owner understands it is public); only devices in the tailnet reach it. Register `https://<machine>.<tailnet>.ts.net/auth/callback` as the redirect URI, set `WEB_OIDC_REDIRECT_URI` to the same value, `WEB_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net` and `WEB_TRUST_PROXY=true`. The browser does the redirect, so Google never needs to reach the dashboard host. If the Google console refuses a `ts.net` redirect URI (it validates against public suffixes), use the SSH tunnel or a real domain via Cloudflare Tunnel instead; this must be tried live (open risk).
   - **Cloudflare Tunnel** (`cloudflared tunnel` to `http://127.0.0.1:8787`; Cloudflare Access in front is an optional extra gate; set `WEB_TRUST_PROXY=true`, `WEB_ALLOWED_HOSTS=<your hostname>` and the https redirect URI on that hostname).
   - **Reverse proxy with TLS** (Caddy example with automatic certificates, an nginx snippet; set `X-Forwarded-Proto` and `X-Forwarded-For`; HTTP to HTTPS redirect; never expose plain http; redirect URI on the https hostname).
   - **SSH tunnel** (`ssh -L 8787:127.0.0.1:8787 host`) for a VPS; keep the `http://127.0.0.1:8787/auth/callback` redirect URI, which is allowed for loopback.
4. A checklist: HTTPS only, `WEB_TRUST_PROXY` set only behind a proxy you control, redirect URI exactly equal at the provider and in `.env`, OAuth consent screen kept in testing mode with only the owner as test user, keep the chat box off unless needed (`WEB_CHAT_ENABLED`), keep the permission set `read_only`, `npm run doctor`, `npm run dashboard -- audit` to review sign-ins, back up `.dashboard/auth.sqlite` only encrypted.
5. What the dashboard shows (emails, names, conversations) and why that makes the public internet a bad default.

Steps:
- [ ] Test first: the doc exists, names all four options, mentions `WEB_ALLOWED_HOSTS` and `WEB_TRUST_PROXY`, contains no `0.0.0.0` instruction other than a warning against it (assert every line containing `0.0.0.0` also contains "never" or "do not"), and every `npm run` script it names exists in `package.json`.
- [ ] Run `npx vitest run tests/dash-docs.test.ts`.
- [ ] Commit: `docs(web): dashboard exposure options and login recovery`.

## Task 14: Final checks (controller, not a subagent)

1. `npx tsc -p . --noEmit` clean; `npx vitest run` shows only the 5 baseline failures.
2. `git grep -nE "innerHTML|outerHTML|insertAdjacentHTML|document\.write" src/web` returns nothing; `git grep -n "0.0.0.0" src scripts` returns nothing; `git grep -nE "Access-Control" src` returns nothing; `git grep -nE "INSERT|UPDATE |DELETE|DROP |ALTER " src/dash src/web | grep -v authStore` returns nothing.
3. `git grep -n "WEB_TOKEN" src scripts docs .env.example` returns nothing outside the "replaces" notes (the old key is gone). `git grep -niE "argon2|totp|otpauth|recovery code|qrcode" src scripts package.json` returns nothing. The OIDC client secret appears in no log line, audit row or response (covered by Task 9 tests).
4. Manual dry check in a throwaway shell (no real data): `JOBAPPLIER_DB=:memory:` cannot be opened read-only, so confirm `npm run web` refuses with a clear message when the database file is missing and when no account is enrolled.
5. Write `.superpowers/sdd/7c-dashboard-report.md`: tasks with SHAs, test counts, rulings with cost-if-wrong, deferred minors.

## Owner-only checklist after the build

1. Create the Google OAuth client (owner-only, in the Google Cloud console, no code involved):
   1. Open https://console.cloud.google.com, select or create a project (any name).
   2. APIs and Services, OAuth consent screen (Google Auth Platform, Branding and Audience in the new console): user type External, app name `Jobber dashboard`, your email as support and developer contact. Leave the publishing status on Testing.
   3. Audience, Test users: add only your own Google account (the one you will put in `DASHBOARD_ALLOWED_EMAIL`). No other test user. Do not publish the app.
   4. Data access (scopes): `openid` and `email` only (non-sensitive, no verification needed).
   5. Clients, Create client: application type Web application, name `Jobber dashboard`. Under Authorized redirect URIs add exactly one URI: `http://127.0.0.1:8787/auth/callback` for localhost use, or `https://<your hostname>/auth/callback` if you expose it (add the second one only when you set that up). Leave Authorized JavaScript origins empty.
   6. Copy the client id and client secret. Paste them only into the setup wizard prompt or straight into `.env`; never into chat or a screenshot.
2. Put the values in `.env` (or let the setup wizard do it): `DASHBOARD_ALLOWED_EMAIL`, `WEB_OIDC_CLIENT_ID`, `WEB_OIDC_CLIENT_SECRET`, `WEB_OIDC_REDIRECT_URI` (identical to the console entry, including port and path). `WEB_OIDC_ISSUER` stays at its Google default.
3. Run `npm install` (adds `jose` as a direct dependency) and `npm run dashboard -- allow you@example.com`, then `npm run dashboard -- status`.
4. `npm run web`, open `http://127.0.0.1:8787`, click sign in, finish the Google flow with the allowed account. Confirm `npm run dashboard -- status` now shows the account as pinned. Click through every view on desktop and on a phone (via your chosen tunnel).
5. Negative test: try to sign in with a second Google account in a private window. With testing mode Google itself blocks an account that is not a test user, which is fine; if it gets through to the callback it must be denied with the generic page. Then `npm run dashboard -- audit` and confirm any denial is listed.
6. Read `docs/dashboard-exposure.md`, choose an exposure option (or stay on localhost), and set `WEB_ALLOWED_HOSTS`, `WEB_TRUST_PROXY` and the https redirect URI (in the console and in `.env`) only if you use a proxy or tunnel.
7. Confirm in the UI that nothing shows a secret: open the config view and the live pane, and compare against your `.env` (the client secret must show only `set`).
8. Run `npm run doctor`; fix any FAIL.
9. Decide whether to enable the chat box and, if so, whether the permission set may stay above `read_only`; with Google the fresh sign-in only forces the account chooser.

## Open risks

- **Plan 7C-lite is mid-build.** This plan modifies its server, page and runner. If those files change shape before merge, Tasks 9 to 12 need a rebase against the merged versions; Tasks 1 to 8 are independent of it.
- **Plan 6D's run log table does not exist yet.** The reader is a stub guarded by `tableExists`; the column names in Task 7 are a proposal that 6D should adopt or the adapter changes.
- **Real status vocabularies.** Job buckets depend on the actual `status` strings in `jobs`, `applications` and `outreach_queue`. Task 6 requires reading them from the code; a wrong bucket mapping is a display bug, not a safety one.
- **Behind a proxy all clients share one IP.** Per-IP lockout is then weak and the global lockout can be triggered by an attacker to lock the owner out (denial of service). Recovery is the CLI on the machine; accepted trade-off.
- **Trust on first use for `sub`.** Until the first successful sign-in the `sub` is not pinned. The email check still applies, so only the owner's mailbox can pin it, but a stale or recycled address is the realistic case. Mitigated by localhost default, the doctor warning, `status` showing the pin, and the advice to sign in immediately after setup.
- **Provider and email risk.** Google can change or recycle an email address; a Workspace admin can alter one. Both `sub` and email must match, so the failure mode is lockout, not takeover; recovery is the local CLI. A provider that omits `email_verified` is refused.
- **Re-auth strength with Google.** Google documents no `prompt=login` and no `max_age` (checked 2026-10-14), so the fresh sign-in before a chat send is an account-chooser round trip with a new nonce and a recent `iat`, not a password re-entry. With `WEB_OIDC_REAUTH_PROMPT=login` on a provider that supports it the proof is stronger. This is a main reason the chat box stays off by default.
- **No local fallback login, by design.** A fallback would be the weakest door. If the provider is unreachable the dashboard is unreachable; the CLI and Telegram paths are unaffected.
- **Provider quirks not live-tested.** The flow is verified against a fake provider only; the owner checklist has a manual pass against real Google. Whether Google accepts a `ts.net` redirect URI is unverified.
- **Testing-mode consent screen.** Google can limit unverified apps in testing mode (test-user cap, periodic re-consent); sign-in only needs `openid email`, so the impact is an occasional extra consent click.
- **`jose` is the only new direct dependency.** It is already in `node_modules` transitively and has no native build; making it direct changes the lockfile. If it cannot be used, `verifyIdToken` can be reimplemented on `node:crypto` (RS256 verify of a JWK) behind the same interface.
- **Stored text is hostile.** `cleanText` and `textContent` remove the known sinks; the CSP is the backstop. A future view that adds a link from stored data would reopen the risk, hence the grep test.
- **The chat box controls a live Claude session.** It is off by default, behind login, CSRF and a confirm step, but the real ceiling on damage is the permission set, not this page.
- **No live browser test.** The frontend is verified by lint tests and server tests only; the owner checklist includes a manual pass.
