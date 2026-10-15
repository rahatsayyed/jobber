# Gmail MCP setup (runbook)

Jobber sends cold emails and reads replies through the
[GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server), an MCP server that
talks to the Gmail API with OAuth. It runs from the npm package `@gongrzhe/server-gmail-autoauth-mcp`.
The OAuth client file and the token live inside the project under `secrets/` (git-ignored), so the
setup is self-contained and does not touch `~/.gmail-mcp/`.

Labels in Google Cloud Console change from time to time. Follow the label currently on screen if it
differs from the one written here.

## What is configured where

`.mcp.json` registers the server and passes the two paths through its `env` block (paths are
relative to the project root, which is the working directory Claude Code starts the server from):

```json
"gmail": {
  "command": "npx",
  "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"],
  "env": {
    "GMAIL_OAUTH_PATH": "secrets/gcp-oauth.keys.json",
    "GMAIL_CREDENTIALS_PATH": "secrets/gmail-credentials.json"
  }
}
```

`.env` (see `.env.example`) carries the same two keys, with a `./secrets/...` default. The setup
wizard and the doctor `gmail-oauth` check read them from the process environment, then `.env`, then
fall back to the defaults below. Keep the `.env` values and the `.mcp.json` values pointing at the
same two files, otherwise the auth helper writes a token where the server does not look for it.

| File | What it is | Written by |
|---|---|---|
| `secrets/gcp-oauth.keys.json` | The OAuth client (client id and secret) you download from Google Cloud | you |
| `secrets/gmail-credentials.json` | The token for your mailbox, including a refresh token | the auth command |

Neither file may be committed. `secrets/` is in `.gitignore`.

## One-time setup

### 1. Google Cloud project and Gmail API

1. Open https://console.cloud.google.com and create a project (or pick an existing one).
2. In that project go to APIs & Services, Library, search for "Gmail API" and click Enable.

### 2. OAuth consent screen

1. APIs & Services, OAuth consent screen (in newer consoles this is under "Google Auth Platform").
2. User type: External. Fill in the app name, your support email and developer contact email.
3. Leave the publishing status at Testing.
4. Under Test users, add the exact Gmail address you will send from. A Google account that is not
   listed here gets `access_denied` at the consent step.
5. Scopes: you can leave the scope list empty on the consent screen. The auth helper requests its
   scopes at consent time (see "Scopes" below).

#### Testing mode and the 7 day refresh token expiry

Google expires refresh tokens issued to an External app that is in Testing status after 7 days
(applies when the app requests Gmail scopes, which are restricted or sensitive). Consequence: about a
week after you authorize, the token stops refreshing and the agent can no longer send or read mail
until you authorize again. This is Google's policy, not a bug in Jobber.

Your options, honestly:

- Stay in Testing and re-run the auth command about weekly (step 4 below). Zero extra work now,
  recurring manual step. The doctor warns when the credentials file has no refresh token, but it
  does not know how old the token is, so a silently expired token is only noticed when a send or
  read fails.
- Publish the app (OAuth consent screen, Publish app, "In production"). A refresh token then does
  not expire after 7 days. Gmail scopes are sensitive or restricted, so Google may show an
  "unverified app" warning and cap the app at 100 users until it passes verification. For a
  single-user personal tool you can click through the warning on your own account. Whether
  production status fully removes the expiry for an unverified app, and what Google requires now,
  is Google policy: check Google's current documentation before relying on it.
- Use a Google Workspace domain and an Internal user type (Workspace accounts only), which has no
  Testing expiry. Not applicable to a personal gmail.com address.

### 3. OAuth client of type Desktop app

1. APIs & Services, Credentials, Create credentials, OAuth client ID.
2. Application type: Desktop app. Name it anything. Create.
3. Click Download JSON on the confirmation (or the download icon next to the client later).
4. Save it into the project and lock it down:

```bash
mkdir -p secrets
mv ~/Downloads/client_secret_*.json secrets/gcp-oauth.keys.json
chmod 600 secrets/gcp-oauth.keys.json
```

The wizard does `chmod 600` on this file for you if it exists, and creates `secrets/` with mode 700.

### 4. Authorize (one browser consent)

Either through the setup wizard:

```bash
npm run setup -- --step gmail
```

The wizard prints the same checklist as above, waits for you to press Enter once the keys file is
saved, sets the file mode, asks "Open the Google consent screen now?" and runs the auth helper for
you with only `GMAIL_OAUTH_PATH` and `GMAIL_CREDENTIALS_PATH` set. It never reads the key or
credential contents.

Or by hand, with the same two variables the server gets in `.mcp.json`:

```bash
GMAIL_OAUTH_PATH=secrets/gcp-oauth.keys.json \
GMAIL_CREDENTIALS_PATH=secrets/gmail-credentials.json \
npx -y @gongrzhe/server-gmail-autoauth-mcp auth
```

A browser opens, you pick the test-user account and approve. The helper then writes
`secrets/gmail-credentials.json`. If Google shows "Google hasn't verified this app", that is expected
for an app in Testing: Advanced, then continue to the app. The wizard sets that file to mode 600
afterwards; for the manual command run `chmod 600 secrets/gmail-credentials.json` yourself.

Restart Claude Code fully afterwards (not only an MCP reconnect) so the `gmail` server starts with
the new token.

### 5. Verify

1. `npm run doctor`: the `gmail-oauth` check passes when the client keys file exists and the
   credentials file is JSON containing a `refresh_token`. It warns when the credentials file is
   missing or has no refresh token, and fails when the keys file is missing. It does not call Google,
   so it cannot detect an expired or revoked token.
2. A read-only live check: in a Claude Code session in this project, ask it to call the `gmail`
   server's `list_email_labels` tool (or `search_emails` with a narrow query). It lists labels
   without sending anything. If that returns your labels, the token works.

Do not verify by sending a real email: sends are real and count against `SEND_LIMIT_PER_RUN`.

## Scopes

The wizard text says the consent screen asks for the Gmail send scope. The exact scope list the
package requests is defined in the upstream package, not in this repo: check upstream
(https://github.com/GongRzhe/Gmail-MCP-Server) before you rely on a specific list. Jobber needs
sending (`send_email`) and reading (`search_emails`, `read_email`, used by `reply-watcher`), so
expect a scope that covers both, and read the consent screen carefully when it appears.

## Tools it exposes

Jobber's agents use `send_email` (sender stage), and `search_emails` and `read_email`
(`reply-watcher`). The package exposes more tools (drafts, labels, modify, delete, batch variants);
the full list is defined upstream, check upstream. Which of them a session may call is limited by the
permission set, not by this file.

## Revoking access

- At Google: https://myaccount.google.com/permissions, find the app name you gave the consent
  screen, Remove access. The token in `secrets/gmail-credentials.json` stops working immediately.
- Locally: delete `secrets/gmail-credentials.json`. The `gmail-oauth` check then warns, and the next
  `npm run setup -- --step gmail` (or the auth command) creates a fresh token.
- To retire the OAuth client entirely, delete the client in Google Cloud Console, Credentials, and
  delete `secrets/gcp-oauth.keys.json`.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `redirect_uri_mismatch` during consent | The client type is not Desktop app (a Web client was downloaded) | Create a new OAuth client with type Desktop app, download it, replace `secrets/gcp-oauth.keys.json`, authorize again |
| `access_denied` or "app not verified, only developer-approved testers" | The Gmail address you signed in with is not in Test users | Add it under OAuth consent screen, Test users, retry in the same browser profile signed into that account |
| Worked for about a week, then sends and reads fail with `invalid_grant` or similar | Refresh token expired (Testing mode 7 day policy) or access was revoked | Delete `secrets/gmail-credentials.json`, run `npm run setup -- --step gmail` again; consider publishing the app, see above |
| Doctor `gmail-oauth` fails: "OAuth client keys file is missing" | Keys file not at the configured path | Save the downloaded JSON as `secrets/gcp-oauth.keys.json`, or fix `GMAIL_OAUTH_PATH` |
| Doctor `gmail-oauth` warns: "no refresh token" | Auth never completed, or Google returned no refresh token | Re-run the auth step; if it repeats, revoke the app at myaccount.google.com/permissions and authorize again so Google issues a new refresh token |
| MCP status shows `gmail` "Connection closed" or failed | The `npx` package could not start: no network on first run, Node missing, or the keys file path in `.mcp.json` does not exist | Run the auth command by hand in a terminal to see the real error; check Node 20+ and network; confirm `secrets/gcp-oauth.keys.json` exists |
| Auth succeeds but the server cannot find the token | `.env` paths and `.mcp.json` paths differ, or the server was started from another directory (the `.mcp.json` paths are relative) | Make both point at the same files; start Claude Code from the project root |
| Wizard exits "Gmail auth helper exited with code N" | The helper failed or you closed the browser | Re-run the step; run the manual command to read the helper's message |
| Browser did not open (VPS, no display) | The helper needs a local browser for consent | Authorize on a machine with a browser, then copy `secrets/gcp-oauth.keys.json` and `secrets/gmail-credentials.json` to the server with mode 600 |

## Moving to a VPS

Copy both files and keep the same relative layout:

```bash
scp secrets/gcp-oauth.keys.json secrets/gmail-credentials.json user@host:~/jobber/secrets/
ssh user@host 'chmod 600 ~/jobber/secrets/*.json'
```

The token refreshes itself without a browser while the refresh token is valid; in Testing mode that
means re-authorizing about weekly on a machine with a browser and copying the new credentials file.

## Dashboard sign-in reuses this client

The dashboard can sign in through the same Desktop client (`WEB_AUTH_MODE=google_desktop`, keys
from `WEB_GOOGLE_KEYS_PATH`, else `GMAIL_OAUTH_PATH`). It is loopback only and off by default
(the default is an access token). Unverified: Google's acceptance of the loopback redirect for
this client has not been checked live; see `docs/dashboard-exposure.md`.

## Security

`gcp-oauth.keys.json` and `gmail-credentials.json` are keys to send mail as you. Never commit them,
paste them into chat, or put them in a backup you do not trust (backups exclude `secrets/` unless
`BACKUP_INCLUDE_SECRETS=true`). The `.env.example` also lists `GMAIL_USER` and `GMAIL_APP_PASSWORD`;
those belong to the older SMTP helper in `src/email.ts` and are not used by the OAuth MCP flow above.
