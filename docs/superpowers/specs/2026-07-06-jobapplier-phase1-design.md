# Jobber — Phase 1 Design (Autonomous Cold-Outreach Agent)

- **Date:** 2026-07-06
- **Status:** Design approved — pre-implementation
- **Location:** repository root
- **Supersedes:** the n8n build (`personal/resume`), which is **parked** (we reuse its `index.js` renderer, resume JSON, dork queries, and SQL knowledge).

---

## 1. Goal

An autonomous, chat-steerable agent running on a small VPS that:
**discovers** relevant software-engineering jobs → **matches** them against the user's resume/preferences → **tailors** the resume → **finds a company contact email** → sends a **humanized cold-outreach email** with the tailored resume attached.

Runs unattended on **cron** and is steerable via a **Telegram channel**.

## 2. Motivation

- User wants an *agentic, conversational* system (Claude Code as the brain), not just fixed automation.
- Oracle Always-Free VM is unavailable (persistent capacity error) → move to a small **paid VPS**.
- Avoid Anthropic API cost → run Claude Code on **OpenRouter (DeepSeek V4 Flash)**.

## 3. Scope

**In (Phase 1):** discovery, LLM matching, resume tailoring + render, multi-strategy email discovery, humanized cold-email send, SQLite state, Telegram reporting + chat control, cron autonomy.

**Out (later phases):**
- **Phase 2 — LinkedIn apply:** `jobber` headless auto-apply on a **burner** account + external (non-LinkedIn) browser apply + connect-with-notes.
- **Phase 3 — conversations + presence:** email + LinkedIn thread automation, LinkedIn posting/updates.

## 4. Runtime & Architecture

```
VPS (Ubuntu, ~€4/mo)  ── Node + Python + Playwright/Chromium
 ├── Claude Code CLI  ── model → OpenRouter (deepseek/deepseek-v4-flash)
 │     ├── channel: telegram plugin (official)  ← chat + reports
 │     └── .mcp.json → MCP servers (job-fetch, contacts, resume, email)
 │     └── .claude/skills/ → the-humanizer (copied), match, draft skills
 ├── cron → `claude -p "run the hunt" --permission-mode ... --mcp-config .mcp.json`
 └── SQLite (state) · base resume.json · index.js (renderer)
```

**Model (OpenRouter, env "Path 1" — no proxy):**
```bash
ANTHROPIC_BASE_URL="https://openrouter.ai/api"
ANTHROPIC_AUTH_TOKEN="sk-or-..."
ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek/deepseek-v4-flash"        # agent loop
ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek/deepseek-v4-flash:free"    # cheap subtasks
# pure-free testing: set both to :free (accept rate limits)
```

**Channels:** official Telegram plugin — `/plugin install telegram@claude-plugins-official`, `/telegram:configure <token>`, `claude --channels plugin:telegram@claude-plugins-official`.

**Foundation:** fork **`MadsLorentzen/ai-job-search`** (MIT, Claude-Code-native, drafter→reviewer). Keep its skill framework; **replace** its LaTeX renderer with the user's `index.js` (Handlebars→Playwright→PDF) and its Danish scrapers with our sources.

**the-humanizer:** copy from user scope into `jobber/.claude/skills/the-humanizer/` so it commits to the repo and runs on the VPS.

## 5. Components

### 5.1 `job-fetch` (MCP)
- `search_jobs(role, location, remote)` → Adzuna + Remotive + RemoteOK (normalized).
- `search_hiring_posts(role, geo)` → Serper LinkedIn-post dorks.
- `list_new_jobs()` → dedup vs SQLite; returns only unseen; marks seen.
- *(Reuses the A1/A2 source + normalization logic already written in `personal/resume`.)*

### 5.2 Match (Claude Code skill)
- Scores each job vs. base resume + preferences; keeps those above a threshold.
- Uses ai-job-search's drafter→reviewer pattern for quality.

### 5.3 `contacts` (MCP) — multi-strategy email finder
`find_company_emails(company, domain?, person_name?)` runs a **cascade**, collects **all** results, verifies, ranks:
1. Email already on the job listing / apply data.
2. Resolve company → domain (search if needed).
3. **Playwright scrape** careers / contact / about / footer → regex-extract all emails.
4. **Serper search** fallback (`site:domain (careers|hr|recruiting) email`, `"@domain" hiring`).
5. **Hunter.io** domain-search — returns known emails + the domain's pattern. *(gated: config flag + hard monthly cap ≤50; last resort; disabled during first smoke test.)*
6. **Predictable-pattern generation** (using the domain pattern + a person name): `first.last@`, `flast@`, `first@`, `last@`.

**Verification (mandatory before send):** MX check + SMTP-RCPT probe (and/or Hunter verify). **Send only to verified addresses.** If a company yields only unverified guesses → send to the safest verified role inbox (`careers@`) or flag to Telegram; never blast unverified guesses (protects sender reputation).

**Ranking:** role-specific (`careers@ / hr@ / jobs@ / recruiting@ / talent@`) → generic (`info@ / contact@ / hello@`) → verified-personal (guessed).

### 5.4 `resume` (MCP)
- `get_base_resume()` → base resume JSON.
- `render_resume(resume_json)` → runs the user's `index.js` → returns PDF path.
- *(Tailoring reasoning is done by Claude Code, reusing workflow B's tailoring prompt; this MCP only renders.)*

### 5.5 Draft + humanize
- Claude Code writes the cold email (with company research from ai-job-search patterns).
- **the-humanizer** skill polishes voice before send.

### 5.6 `email` (MCP)
- `send_email(to, subject, body, attachment_path)`.
- **Phase 1:** personal Gmail (Gmail MCP or SMTP), low volume for smoke test.
- **Migration (post-smoke-test):** `@example.com` — see §9.

## 6. Data flow (cron / autonomous)

`list_new_jobs → match → find_company_emails → tailor JSON → render_resume → draft + humanize → send_email → log(SQLite) → Telegram summary`

**Chat flow:** user messages Telegram ("show today's top 5", "email #2", "make it warmer") → Claude Code acts with the same tools.

## 7. Data model (SQLite)

- `jobs(id, source, title, company, url, apply_url, description, score, status, created_at)`
- `contacts(id, company, email, type, verified, source, confidence, created_at)`
- `outreach(id, job_id, contact_email, subject, body, resume_path, sent_at, status)`
- *(follow-up / reply tracking added in Phase 3)*

## 8. External services, credentials, cost

| Service | Use | Cost |
|---|---|---|
| OpenRouter | model (V4-Flash) | ~$5 one-time activation; then pennies / `:free` |
| Adzuna | jobs | free key |
| Remotive / RemoteOK | jobs | free, no key |
| Serper | dorks + contact search | 2,500 free, then $1/1k |
| Hunter.io | email finder (last resort) | free 50/mo (capped) |
| Gmail (personal) | Phase-1 sending | free (low volume) |
| VPS | runtime | ~€4/mo |
| Telegram | channel | free |

**Phase-1 run cost ≈ €4–5/mo** (VPS + one-time OpenRouter credit; model effectively free/pennies).

## 9. Email: Phase-1 → custom-domain migration (answers "beyond Resend 3k")

- **Phase 1:** personal Gmail via Gmail MCP (send/draft), tiny volume smoke test.
- **Migration → `@example.com`:**
  - **Recommended:** Google Workspace on the domain ($6/mo) → **Gmail MCP** handles send/draft/**read/reply/threads** (cleanest for Phase 3 conversation automation; best deliverability; ~2k sends/day).
  - **Beyond-3k / cheaper sending:** Amazon SES ($0.10/1k, ~unlimited) or Brevo (9k/mo free) for *sending* + an inbox (IMAP or Cloudflare Email Routing → Gmail) for *receiving/reply*, wired via a small IMAP/SMTP email MCP.
  - **Note:** 3k *cold* emails/mo is already very high and reputation-risky; deliverability > volume. **Resend alone cannot manage replies** (send-only) — Phase 3 threads need Gmail/Workspace or IMAP.

## 10. Decisions log

- Model: **OpenRouter DeepSeek V4-Flash** (Path 1 env, no proxy). V4-Flash is strong at agentic tool-use → de-risks MCP orchestration. Not Anthropic (cost).
- Storage: **SQLite** (Supabase dropped).
- Outreach: **cold email now** (not self-review).
- Foundation: **fork ai-job-search**; keep **user's `index.js`** renderer (not LaTeX).
- Humanizer: **copied into project scope** (committable, runs on VPS).
- Email finder: **multi-strategy cascade**, verified-only sends, **Hunter last-resort + capped + off for first smoke test**.
- LinkedIn (Phase 2/3): **Hybrid** — main account semi-auto (agent drafts, user sends at human pace, browser from the **Mac's residential IP**, not the VPS); **burner** for `jobber` full-auto Easy-Apply.
- Repos: `ai-job-search` (Phase-1 base), `jobber` (Phase-2 LinkedIn apply — interactive CLI, needs OpenAI key, apply-only).

## 11. Risks & mitigations

- **DeepSeek tool-use reliability** → V4-Flash (agentic-strong); keep MCP toolset small + well-described; budget-cap test runs; fallback to `anthropic/claude-haiku-latest` if it loops.
- **Cold-email deliverability / reputation** → verified emails only; start low-volume personal Gmail; migrate to domain with SPF/DKIM; humanizer for quality.
- **LinkedIn ban (Phase 2/3)** → Hybrid strategy above; browser automation from residential IP, not the VPS datacenter IP; deferred.
- **Hunter credits (50/mo)** → gated flag + hard cap + last in cascade + off during smoke test.
- **jobber integration friction** → it's interactive/OpenAI-based/experimental; treat Phase 2 as spike + wrap, on burner only.

## 12. Phase 2 / 3 outline (not built yet)

- **Phase 2:** `jobber` on burner (LinkedIn Easy-Apply) + external-site browser apply + connect-with-notes (drafted by agent, sent from Mac). New MCP/skills: `linkedin-apply`, `external-apply`, `connect`.
- **Phase 3:** email + LinkedIn conversation automation (read → draft reply → human approve/send), LinkedIn posting. Needs an inbox (Gmail/Workspace/IMAP) + LinkedIn session on the Mac.

## 13. Open items (confirm at build time)

- Verify Path-1 direct env works with current Claude Code (else fall back to `claude-code-router`).
- Smoke-test DeepSeek V4-Flash actually drives the MCP loop reliably.
- Pick VPS provider (Hetzner recommended).
- Confirm Gmail send mechanism (Gmail MCP vs SMTP app-password).
