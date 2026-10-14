# Gmail MCP setup (GongRzhe, OAuth)

Jobber sends (and, in Phase 3, reads/replies to) email through the
[GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) — a Gmail-API MCP
using OAuth. OAuth keys + token are stored **inside the project** at `secrets/` (gitignored),
so the setup is portable to the VPS and doesn't touch `~/.gmail-mcp/`.

It's registered in `.mcp.json` as:

```json
"gmail": { "command": "npx", "args": ["-y", "@gongrzhe/server-gmail-autoauth-mcp"] }
```

and pointed at project-local paths via `.env`:

```
GMAIL_OAUTH_PATH=<project>/secrets/gcp-oauth.keys.json
GMAIL_CREDENTIALS_PATH=<project>/secrets/gmail-credentials.json
```

## One-time setup

### 1. Google Cloud project + Gmail API
1. https://console.cloud.google.com → create a project (or reuse one).
2. **APIs & Services → Library → enable "Gmail API"**.

### 2. OAuth consent screen
1. **APIs & Services → OAuth consent screen** → User type **External** → create.
2. Add your Gmail address under **Test users**.
3. **Publish app → "In production"**. *(Important: while in "Testing", refresh tokens expire
   after ~7 days and the agent silently stops sending. Production avoids that.)*

### 3. OAuth client credentials
1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Desktop app** → Create → **Download JSON**.
3. Place it in the project (create the dir if needed):
   ```bash
   mkdir -p ~/jobber/secrets
   mv ~/Downloads/client_secret_*.json ~/jobber/secrets/gcp-oauth.keys.json
   ```

### 4. Authorize (one-time browser consent)
```bash
cd ~/jobber
set -a && source .env && set +a          # loads GMAIL_OAUTH_PATH / GMAIL_CREDENTIALS_PATH
npx -y @gongrzhe/server-gmail-autoauth-mcp auth
```
A browser opens → approve the Gmail scopes. The token is written to
`secrets/gmail-credentials.json`. After this, the `gmail` MCP works **headless**.

### 5. Verify
```bash
cd ~/jobber && set -a && source .env && set +a
claude -p "list your MCP tools"     # should list gmail tools (send_email, read_email, ...)
```

## Tools it exposes
`send_email`, `draft_email`, `read_email`, `search_emails`, `modify_email`, `list_email_labels`,
`delete_email`, and batch variants — covers Phase 1 sending **and** Phase 3 reply/thread handling.

## Moving to the VPS
Copy the two secret files to the VPS project:
```bash
scp secrets/gcp-oauth.keys.json secrets/gmail-credentials.json  user@vps:~/jobber/secrets/
```
The saved token refreshes itself; no browser needed on the VPS (as long as the OAuth app is in
Production). Keep `GMAIL_OAUTH_PATH` / `GMAIL_CREDENTIALS_PATH` in the VPS `.env`.

## Later: custom domain (`@example.com`)
When you migrate to Google Workspace on the domain, prefer a **service account with
domain-wide delegation** instead of this OAuth flow: no interactive consent, no token expiry,
fully headless. GongRzhe/other Gmail MCPs can use service-account creds. (See spec §9.)

## Security
`secrets/` is gitignored — never commit `gcp-oauth.keys.json` or `gmail-credentials.json`.
They are the keys to sending mail as you.
