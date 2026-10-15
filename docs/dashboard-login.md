# Dashboard login

Audience: owner
Last verified against: cc51247
Source files: scripts/web.ts, scripts/dashboard.ts, src/web/server.ts, src/web/env.ts, src/dash/accessToken.ts, src/dash/account.ts, src/dash/authStore.ts, src/dash/desktopClient.ts, src/dash/oidc.ts, src/dash/sessions.ts, .env.example, docs/dashboard-exposure.md

This page is how you sign in to the dashboard (`npm run web`) and what to do when you cannot.
It does not cover how to reach the dashboard from a phone or another machine: that is
[dashboard-exposure.md](dashboard-exposure.md). Tick the owner-only steps yourself; nothing here
is done by the agent.

Status: the token login, the Google modes and the recovery commands are covered by unit tests
with fakes. None of it has been checked in real browsers or against live Google (see
"Unverified" at the end).

## Pick a mode

`WEB_AUTH_MODE` in `.env` chooses one mode. Leave it as `token` unless you have a reason.

| Mode | Use it when | Needs | Status |
|---|---|---|---|
| `token` (default) | Always, unless you need Google sign-in | Nothing outside this machine | Unit-tested with fakes |
| `google_desktop` | You want to sign in with your Google account on this machine | The Gmail Desktop OAuth client and one allowed email | Unverified: Google's redirect acceptance is not checked |
| `oidc` | Advanced: you expose the dashboard through a TLS proxy and want Google or another OIDC provider | A Web OAuth client (`WEB_OIDC_*`) and one allowed email | Existing mode, not re-verified live |

If `WEB_AUTH_MODE` is unset and both `WEB_OIDC_CLIENT_ID` and `WEB_OIDC_CLIENT_SECRET` are set,
the mode resolves to `oidc` implicitly and `npm run doctor` warns until you set
`WEB_AUTH_MODE=oidc`. Setting the mode to a different value on a later start revokes every
session (the mode name is audited as `mode_changed`).

## Sign in with the access token (default)

Owner-only: you run this on the machine that runs the dashboard.

```bash
npm run dashboard -- token
```

Prints one URL of the form `http://127.0.0.1:<port>/#token=<token>`, once. The token is not
stored in readable form anywhere (only a hash is kept in the auth database, `WEB_AUTH_DB`).
It exits with code 3 if a token already exists; use `rotate` then.

```bash
npm run web
```

Starts the dashboard. Open the printed token URL in your browser. The part after `#` never
leaves the browser and the page removes it from the address bar after use. Or open the plain
address and paste the token into the login form.

What the token protects: the whole dashboard, behind a signed session cookie. What it does not
protect: a `?token=` query string never signs you in (on purpose, so it cannot leak through
logs). Anyone who holds the token can sign in, so do not paste it into chat or screenshots.
Idle and absolute session limits and the failed-login throttle are in `src/dash/sessions.ts`
and `src/dash/throttle.ts`; they are the same in all three modes.

Check the state without printing a secret:

```bash
npm run dashboard -- status
```

Prints the auth mode, whether a token is set and when it was created or rotated, and the
allowed account if one exists.

```bash
npm run dashboard -- audit
```

Prints recent sign-in events (time, kind, address). Token text never appears.

### Rotate the token

```bash
npm run dashboard -- rotate
```

Asks for a yes, replaces the token, signs out every session and prints the new URL once.
Both `token` and `rotate` refuse to run without a terminal unless you pass `--print`.
Pass `--port <n>` if the printed URL should use a port other than `WEB_PORT`.

## Sign in with Google on this machine (`google_desktop`, unverified)

Unverified: whether Google accepts a loopback redirect from the Gmail Desktop client has not
been checked against live Google. Try it, and fall back to `token` if it is refused.

What must exist first: the Desktop OAuth client you made for Gmail (see
[gmail-mcp-setup.md](gmail-mcp-setup.md)). The consent screen step is owner-only; a Google
account cannot be authorized by the agent.

1. In `.env` set `WEB_AUTH_MODE=google_desktop`. The keys file is `WEB_GOOGLE_KEYS_PATH`, else
   the Gmail keys path (`GMAIL_OAUTH_PATH`).
2. Set the one allowed account, either `DASHBOARD_ALLOWED_EMAIL=you@example.com` or:

   ```bash
   npm run dashboard -- allow you@example.com
   ```

   Stores the allowed account. The first successful sign-in pins that Google identity.
3. Test the redirect without signing in:

   ```bash
   npm run dashboard -- google-url
   ```

   Prints a Google URL (offline, nothing stored). Open it in a browser. The account chooser
   means the redirect shape is accepted; `redirect_uri_mismatch` means it is not.
4. If it is refused, set `WEB_GOOGLE_REDIRECT_SHAPE=root` (default is `callback`) and repeat
   step 3. If it is still refused, stay on `token`, or use `oidc` with a dedicated Web client.
5. Restart `npm run web`.

Limits: loopback only. The server rejects `WEB_TRUST_PROXY=true` in this mode, so it cannot
sit behind a proxy. Keep the consent screen in testing mode with you as the only test user.

## OIDC (advanced)

Choose this when the dashboard sits behind a TLS proxy and you want a Web OAuth client. Set
`WEB_AUTH_MODE=oidc` and the `WEB_OIDC_ISSUER`, `WEB_OIDC_CLIENT_ID`, `WEB_OIDC_CLIENT_SECRET`
and `WEB_OIDC_REDIRECT_URI` keys listed in `.env.example`, plus the allowed account as above.
The redirect URI at the provider must equal `WEB_OIDC_REDIRECT_URI` exactly. The proxy,
`WEB_ALLOWED_HOSTS` and `WEB_TRUST_PROXY` settings are in
[dashboard-exposure.md](dashboard-exposure.md); read it before you change them.

## The chat box warning

`WEB_CHAT_ENABLED` is `false` by default. Turning it on lets a signed-in browser type into the
tmux window named by `WEB_TMUX_SESSION` and `WEB_TMUX_WINDOW`, with a two-step confirmed send.
Whatever you type runs under that session's permission set, so enable it only while that set is
`read_only` (`npm run permissions -- --status`). Anyone who can sign in can use it. Leave it
off unless you need it.

## Recovery

All of these run on the machine, in a terminal. There is no web page for them on purpose.

| Situation | Command | Result |
|---|---|---|
| Lost or leaked token | `npm run dashboard -- rotate` | New token printed once, all sessions signed out |
| Rotate says "no access token yet" | `npm run dashboard -- token` | First token created |
| Token says "already exists" | `npm run dashboard -- rotate` | Replaces it |
| Google address changed or lost (google_desktop, oidc) | `npm run dashboard -- allow you@example.com` | New account stored; the next sign-in pins it |
| Cannot sign in with Google at all | Set `WEB_AUTH_MODE=token`, run `rotate` or `token`, restart `npm run web` | Token login works, sessions reset by the mode change |
| Not sure what mode is active | `npm run dashboard -- status` | Mode, token and account state |

## Diagnose

| Symptom | Check | Fix |
|---|---|---|
| `npm run web` refuses to start | The message names the key; also `npm run doctor` (`dashboard login` row) | Fix that `.env` key; the checks live in `src/web/env.ts` |
| "no allowed account" at start | `npm run dashboard -- status` | `npm run dashboard -- allow you@example.com` (google_desktop and oidc only) |
| Token page says denied | `npm run dashboard -- audit` for `token_login_denied` | Use the newest URL, or `rotate`; check you did not use `?token=` |
| Signed out after a while | Idle and absolute limits in `src/dash/sessions.ts` | Sign in again; this is expected |
| Signed out of everything after a restart | Did `WEB_AUTH_MODE` change? audit shows `mode_changed` | Expected after a mode switch; sign in again |
| Too many failed attempts | Throttle in `src/dash/throttle.ts` | Wait, then sign in with the right token |
| `redirect_uri_mismatch` | `npm run dashboard -- google-url` | Set `WEB_GOOGLE_REDIRECT_SHAPE=root`, else use `token` or `oidc` |
| Doctor warns about implicit OIDC | `.env` has OIDC client keys and no mode | Set `WEB_AUTH_MODE=oidc` (or `token`) |
| Token sign-in refused from another machine | Plain http is refused off loopback | Use a TLS proxy per [dashboard-exposure.md](dashboard-exposure.md), or an SSH tunnel |
| `google_desktop` rejected behind a proxy | `WEB_TRUST_PROXY=true` is a config error in this mode | Use `token` or `oidc` behind a proxy |

## Unverified

- Google accepting the Desktop client's loopback redirect (both shapes).
- The token page's address-bar cleanup and reload behaviour in real browsers.
- The chat box re-authentication round trip in token mode.
- The setup wizard's `dashboard` step in a real terminal.
- OIDC against a real provider after the 8C changes (migration is tested with fakes only).
