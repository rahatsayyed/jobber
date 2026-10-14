# Jobber

An autonomous job-hunting agent that discovers relevant job postings, matches them against your resume, tailors the resume for each match, finds verified company contacts, and sends humanized cold-outreach emails — all within strict safety limits.

**Phase 1 (Complete):** cold-email discovery + outreach  
**Phase 2 (Substantially complete):** LinkedIn Easy Apply (burner) + external ATS apply + LinkedIn connection requests — implemented, unit-tested, and live-tested; see `docs/phase2-known-issues.md` for open items before treating it as fully production-proven  
**Phase 3 (Planned):** email + LinkedIn reply automation + capped posting

---

## Quick Start

### Prerequisites

- **Node 20+** (or use `nvm use` if available)
- **Playwright/Chromium** (for rendering PDFs and scraping)
- **Claude Code CLI** (or `npm install -g @anthropic-ai/claude`)
- **Git**
- One of: **Grok/xAI credits** (via CCR, recommended for now) **or** **OpenRouter funded account** (parked, needs ~$5 one-time credit)

### 1. Clone and install

```bash
git clone https://github.com/rahatsayyed/Jobber.git
cd Jobber
npm install
npx playwright install --with-deps chromium
```

### 2. Configure environment

Copy `.env.example` to `.env` (gitignored) and fill in your API keys:

```bash
cp .env.example .env
# Edit .env with:
# - ADZUNA_APP_ID, ADZUNA_APP_KEY (free)
# - SERPER_API_KEY (2,500 free, then $1/1k)
# - HUNTER_API_KEY (optional, capped 50/mo, off by default)
# - TELEGRAM_BOT_TOKEN (if using Telegram channel)
```

See `docs/model-auth-setup.md` for the full model/provider setup (Grok via CCR or OpenRouter).

### 3. (First time only) Set up model access

Choose one of two providers:

**Option A: Grok/xAI via Claude Code Router (currently working)**

```bash
# 1. Install CCR locally (not globally — macOS permissions issue)
npm install @musistudio/claude-code-router@2

# 2. Create ~/.claude-code-router/config.json (see docs/model-auth-setup.md for full example)
mkdir -p ~/.claude-code-router
cat > ~/.claude-code-router/config.json <<'EOF'
{
  "LOG": false,
  "HOST": "127.0.0.1",
  "PORT": 3456,
  "Providers": [
    {
      "name": "xai",
      "api_base_url": "https://api.x.ai/v1/chat/completions",
      "api_key": "xai-YOUR-KEY-HERE",
      "models": ["grok-4.3"]
    }
  ],
  "Router": {
    "default": "xai,grok-4.3",
    "background": "xai,grok-4.3",
    "think": "xai,grok-4.3",
    "longContext": "xai,grok-4.3",
    "webSearch": "xai,grok-4.3"
  }
}
EOF

# 3. Create .env.ccr (gitignored override)
cat > .env.ccr <<'EOF'
ANTHROPIC_BASE_URL=http://127.0.0.1:3456
ANTHROPIC_AUTH_TOKEN=dummy
ANTHROPIC_DEFAULT_SONNET_MODEL=grok-4.3
ANTHROPIC_DEFAULT_HAIKU_MODEL=grok-4.3
ANTHROPIC_DEFAULT_OPUS_MODEL=grok-4.3
EOF
```

**Option B: OpenRouter/DeepSeek (parked — needs funding, but direct, no proxy needed)**

```bash
# Put in .env or .env.openrouter:
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=sk-or-...
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek/deepseek-v4-flash
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek/deepseek-v4-flash:free
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek/deepseek-v4-pro
```

### 4. (First time only) Set up Gmail

```bash
# See docs/gmail-mcp-setup.md for detailed steps
# The MCP is already in .mcp.json; just run the OAuth flow once:
npx -y @gongrzhe/server-gmail-autoauth-mcp auth
```

### 5. Verify setup

```bash
# Start CCR if using Grok (stays running in background)
./node_modules/.bin/ccr start

# Load env and test Claude Code can reach the model
set -a && source .env && source .env.ccr && set +a
claude -p "say hello" --mcp-config ./.mcp.json
# Should see a response from Grok

# Check MCP tools are available
claude -p "list your available MCP tools" --mcp-config ./.mcp.json --strict-mcp-config
# Should list: job-fetch, resume, contacts, gmail
```

### 6. Development setup (git hooks and personal data)

```bash
# Enable the pre-commit guard (blocks secrets, databases and user data files by name)
git config core.hooksPath .githooks

# Create your local user-data/ folder from the synthetic templates
npm run user-data -- init
```

---

## Running the Hunt (Phase 1)

### Option A: Interactive (Telegram channel — recommended for ongoing use)

**One-time Telegram setup:**

```bash
# Install the official Telegram plugin
claude /plugin install telegram@claude-plugins-official

# Configure with your bot token (get one from @BotFather)
claude /telegram:configure YOUR_BOT_TOKEN

# Start the listening session (stays open, receives messages from the bot)
set -a && source .env && source .env.ccr && set +a
claude --mcp-config ./.mcp.json --channels plugin:telegram@claude-plugins-official
# This session now listens to your Telegram bot; send it messages and it replies
```

**Send commands via Telegram:**

```
user: "run hunt"
→ agent discovers jobs, matches, finds contacts, drafts emails, sends (up to SEND_LIMIT_PER_RUN)

user: "status"
→ agent reports current DB counts (jobs found, matched, sent, pending)

user: "apply to job #3"
→ agent applies via Easy Apply or external ATS, reports submitted/manual_review/rate_limited
```

**Stop the session:** Ctrl+C

### Option B: Headless / one-shot (cron-friendly)

```bash
# Dry run (show what would send, don't actually send)
./run-hunt.sh "run the hunt but DO NOT send email — show me the top 2 drafted emails"

# Real run (sends up to SEND_LIMIT_PER_RUN)
./run-hunt.sh "run the hunt"

# Custom prompt
./run-hunt.sh "find jobs with role 'backend engineer' and location 'remote'"
```

`run-hunt.sh` automatically:

- Sources `.env` and `.env.ccr`
- Ensures CCR gateway is running
- Runs Claude Code with `--permission-mode bypassPermissions` (safe for cron)

### Option C: Plain CLI (minimal)

```bash
set -a && source .env && source .env.ccr && set +a
claude -p "run the hunt" \
  --mcp-config ./.mcp.json \
  --strict-mcp-config \
  --permission-mode bypassPermissions
```

---

## The Hunt Pipeline

When you ask the agent to "run the hunt", it follows this **subagent-per-stage** flow:

1. **Discover** (subagent: `discoverer`)  
   Fetches new, unseen jobs from Adzuna/Remotive/RemoteOK/Serper.  
   Returns: list of Job objects.

2. **Match** (subagent: `matcher`)  
   Scores each job against your base resume using the `match-jobs` skill.  
   Returns: score, reasons, missing keywords per job.

3. **Filter** (orchestrator, no subagent)  
   Skips jobs with `score < MATCH_THRESHOLD` (default 70, see `MATCH_THRESHOLD` in `.env`).

4. **Find Contacts** (subagent: `contact-finder`)  
   Finds verified email addresses at each company (scrape → Serper → Hunter → patterns).  
   Returns: top verified contact per job (or null if none found).

5. **Prepare Outreach** (subagent: `outreach-preparer`, one per matched job)  
   Tailors resume, renders PDF, drafts humanized email.  
   Returns: `{job_id, pdf_path, subject, body, to}`.

6. **Send** (subagent: `sender`)  
   Sends prepared emails via Gmail, respecting `SEND_LIMIT_PER_RUN` (default 1).  
   Returns: list of sent, queued (hit limit), and failed.

7. **Report** (orchestrator)  
   Posts summary to Telegram (if active) or prints to stdout:
   ```
   ✅ Discovered 10 new jobs
   ✅ Matched 3 (score ≥ 70)
   ✅ Sent 1 email (limit reached)
   ⚠️  1 job needs manual contact (no verified email found)
   ```

See `CLAUDE.md` for the full orchestration spec.

---

## Configuring the Agent

**Easy tuning (edit these in `CLAUDE.md` Preferences block):**

```
Role: "full stack developer / react"
Location: "india"
Remote OK: yes
MATCH_THRESHOLD: 70      (jobs scoring below this are skipped)
SEND_LIMIT_PER_RUN: 1    (max emails sent per run; rest queued)
```

**Advanced tuning (in `.env`):**

```
MATCH_THRESHOLD=70              # min job score to contact
SEND_LIMIT_PER_RUN=1            # max emails per run
HUNTER_ENABLED=false            # enable Hunter.io (last-resort contact finder)
HUNTER_MONTHLY_CAP=50           # hard cap on Hunter credits/month
```

---

## Deploying to VPS (for cron + always-on Telegram)

### 1. Provision a VPS

Recommended: **Hetzner CX22** (~€4/mo, Ubuntu 24.04)

```bash
# On the VPS:
sudo apt update && sudo apt install -y nodejs npm git chromium-browser

# Install Claude Code CLI
npm install -g @anthropic-ai/claude

# Clone the repo
git clone <repo> ~/Jobber
cd ~/Jobber
npm install
```

### 2. Copy secrets

```bash
# On your Mac:
scp .env root@vps-ip:~/Jobber/.env
scp .env.ccr root@vps-ip:~/Jobber/.env.ccr

# On the VPS, configure CCR (same as local setup):
mkdir -p ~/.claude-code-router
# ... create config.json with your xAI key
```

### 3. Test parity

```bash
# On the VPS:
./run-hunt.sh "run the hunt but DO NOT send — show me what you'd send"
# Confirm it works the same as locally
```

### 4. Set up Telegram channel (always-on)

```bash
# On the VPS, in a new tmux/screen session or systemd service:
set -a && source ~/jobber/.env && source ~/jobber/.env.ccr && set +a
cd ~/jobber
claude --mcp-config ./.mcp.json --channels plugin:telegram@claude-plugins-official
# Session stays open; Telegram messages reach it instantly
```

Or as a **systemd service** (`~/jobber.service`):

```ini
[Unit]
Description=Jobber Telegram Channel
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/jobber
EnvironmentFile=/root/jobber/.env
EnvironmentFile=/root/jobber/.env.ccr
ExecStart=/usr/local/bin/claude --mcp-config ./.mcp.json --channels plugin:telegram@claude-plugins-official
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable: `sudo systemctl enable --now jobber`

### 5. Set up cron for scheduled runs

```bash
# Add to crontab (crontab -e):
0 9 * * * cd /root/jobber && ./run-hunt.sh "run the hunt" 2>&1 >> hunt.log

# Every day at 9 AM, discover + match + send (up to limit)
# Logs go to hunt.log; summaries post to Telegram if the channel is active
```

---

## Troubleshooting

### "Invalid message role" error with xAI

You're pointing Claude Code directly at `https://api.x.ai` without the CCR proxy. **Fix:** use `.env.ccr` (see setup step 3 above).

### "402 Insufficient credits" from OpenRouter

Your OpenRouter account hasn't been funded with a one-time ~$5 credit. **Fix:** go to https://openrouter.ai/settings/credits and add credit, or switch to Grok (Option A).

### "Gmail MCP fails" / "not authorized"

OAuth flow didn't complete or token expired. **Fix:** run `npx -y @gongrzhe/server-gmail-autoauth-mcp auth` again, or fall back to app-password (see Gmail setup).

### Jobs discovered but no matches

Your resume might not have keywords the jobs are looking for. **Fix:** check recent matches via `claude -p "show me the top 3 jobs that almost matched, with their scores and missing keywords"`, then adjust `MATCH_THRESHOLD` down to see borderline fits, or add missing skills to your resume.

### CCR says "Not Running" but it's actually running

Known quirk in CCR v2's status command. **Verify:** `curl http://127.0.0.1:3456/v1/messages -X POST ...` or just try a `claude` call.

### Playwright PDF rendering fails

Chromium might not be installed or available. **Fix:** `npx playwright install --with-deps chromium`.

---

## Structure

```
jobber/
├─ CLAUDE.md                 # Agent orchestration + Phase 1 full spec
├─ .env.example              # Documented template (committed)
├─ .env (gitignored)         # Real secrets
├─ .env.ccr (gitignored)     # CCR/Grok override
├─ .mcp.json                 # MCP server registration
├─ run-hunt.sh               # Headless runner script
├─ package.json
├─ src/
│   ├─ db.ts                 # SQLite module
│   ├─ sources/              # Adzuna, Remotive, RemoteOK, Serper normalizers
│   ├─ lib/                  # Email scrape, patterns, verify, Hunter
│   └─ mcp/                  # MCP server definitions (job-fetch, resume, contacts, email)
├─ .claude/
│   ├─ agents/               # Subagent definitions (discoverer, matcher, etc.)
│   └─ skills/               # match-jobs, draft-outreach, the-humanizer
├─ renderer/                 # Copied from personal/resume (Handlebars → Playwright → PDF)
├─ user-data/resume.json         # Your base resume
├─ data.sqlite (gitignored)  # State: discovered jobs, contacts, outreach log
├─ tests/                    # vitest suite
└─ docs/
    ├─ model-auth-setup.md       # Full provider routing + CCR setup
    ├─ gmail-mcp-setup.md        # Gmail OAuth walkthrough
    └─ superpowers/
        ├─ specs/                 # Phase 1/2/3 design docs
        └─ plans/                 # Phase 1/2/3 implementation plans
```

---

## Status web page

Start it with `npm run web` (sign-in is Google OIDC: set the `WEB_OIDC_*` keys and `DASHBOARD_ALLOWED_EMAIL` in `.env`, or run `npm run dashboard -- allow <email>`; see `.env.example`; `npm run doctor` shows the dashboard checks). It prints `http://127.0.0.1:<port>`.

- The send box types into a live Claude session. Keep the permission set at `read_only` unless you need more.
- Text typed in the chat box also answers any pending permission or confirmation prompt in the Claude window, so only enable it for an account you trust and keep the permission set `read_only`.
- The page listens on localhost only. From another machine use an SSH tunnel (`ssh -L 8787:127.0.0.1:8787 host`); never open the port.
- Exposure options and login recovery: [docs/dashboard-exposure.md](docs/dashboard-exposure.md).

## Next Steps

**Phase 1 (now):** smoke test locally, then deploy to VPS + Telegram + cron.

**Phase 2 (substantially complete):** LinkedIn Easy Apply (burner), external ATS apply, LinkedIn connect-with-notes (main account, human-approved).  
See `docs/superpowers/specs/2026-07-07-jobapplier-phase2-design.md`, the Phase 2 plan, and `docs/phase2-known-issues.md` for open items (external-apply not yet live-tested; connect_send's final click needs re-verification on a fresh day).

**Phase 3 (planned):** reply detection/drafting, capped LinkedIn posting.  
See `docs/superpowers/specs/2026-07-07-jobapplier-phase3-design.md` and the Phase 3 plan.

---

## Commands (via Telegram or CLI)

| Command             | What it does                                                   |
| ------------------- | -------------------------------------------------------------- |
| `run hunt`          | Full pipeline: discover → match → contact → draft → send.      |
| `status`            | Show current DB counts (jobs/contacts/sent) — no side effects. |
| `apply to job #3`   | Apply to one matched job (Easy Apply or external ATS).         |
| `apply all`         | Apply to all of today's matched jobs.                          |
| `connect <company>` | Draft + (with your approval) send a LinkedIn connect request.  |
| `check replies`     | Phase 3 not yet.                                               |

---

## Safety

- **Verified emails only:** the agent NEVER sends to an unverified email address, even a "pretty good guess." Hunter.io and SMTP checks are mandatory before send.
- **Send cap:** `SEND_LIMIT_PER_RUN` is enforced in the `sender` subagent only, so no stage can overshoot it.
- **Cold email (Phase 1) + gated LinkedIn actions (Phase 2):** the Phase 1 hunt pipeline is cold-email only. LinkedIn Easy Apply, external ATS apply, and LinkedIn connection requests are Phase 2 — connection requests always require your explicit approval before sending (see `docs/phase2-known-issues.md` for current limitations).
- **Fail-safe:** if a tool errors, the agent logs it and continues with the next job instead of crashing.

---

## Support

- Full orchestration spec: `CLAUDE.md`
- Phase 1 design: `docs/superpowers/specs/2026-07-06-jobapplier-phase1-design.md`
- Model/provider setup: `docs/model-auth-setup.md`
- Gmail MCP setup: `docs/gmail-mcp-setup.md`
- Phase 2/3 outlines: `docs/superpowers/specs/2026-07-07-jobapplier-phase{2,3}-design.md`
- Phase 2 known issues / live-test findings: `docs/phase2-known-issues.md`
- LinkedIn session setup (burner + main accounts): `docs/linkedin-sessions-setup.md`

---

**Questions?** Check `CLAUDE.md` first — it has the full agent spec. Then the design/plan docs in `docs/superpowers/`.
