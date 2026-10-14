# Jobber Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude-Code-driven agent that discovers SWE jobs, matches them to the user's resume, tailors + renders the resume, finds a verified company email, and sends a humanized cold email — runnable headless (cron) and via a Telegram channel.

**Architecture:** Claude Code CLI is the orchestrator (model = OpenRouter DeepSeek V4-Flash). Deterministic work lives in four small **Node MCP servers** (`job-fetch`, `resume`, `contacts`, `email`); reasoning (match, draft) lives in **Claude Code skills** + `CLAUDE.md`. State is local **SQLite**. Build + test locally on the Mac, then deploy to a VPS and add the Telegram channel + cron.

**Tech Stack:** Node 20 + TypeScript, `@modelcontextprotocol/sdk`, `better-sqlite3`, Playwright (reuse existing), Handlebars (existing `index.js`), Claude Code CLI, OpenRouter.

## Global Constraints

- Model access via env only (no proxy): `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek/deepseek-v4-flash`, `ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek/deepseek-v4-flash:free`.
- **Send email only to verified addresses** (MX + SMTP-RCPT, or Hunter verify). Never send to unverified guesses.
- Hunter.io is **last in the contact cascade**, behind `HUNTER_ENABLED` flag + `HUNTER_MONTHLY_CAP=50`; disabled for the first smoke test.
- Secrets in `.env` (gitignored); never commit keys. `.env.example` documents every key.
- Resume rendering uses the existing `index.js` (Handlebars→Playwright→PDF) — do **not** reintroduce LaTeX.
- Job IDs are source-prefixed (`adzuna:`, `remotive:`, `remoteok:`, `dork:`) for dedup.
- Reuse the already-written A1/A2 source + normalization logic from `personal/resume` (n8n Code nodes) as the reference implementation.

---

## File Structure

```
jobber/
├─ .env.example / .env(gitignored)
├─ .mcp.json                     # registers the 4 MCP servers for Claude Code
├─ CLAUDE.md                     # agent orchestration instructions (the "brain" prompt)
├─ package.json
├─ input/resume.json             # base resume (copied from personal/resume)
├─ renderer/                     # copied index.js + components/ + template + fonts
├─ .claude/skills/
│   ├─ the-humanizer/            # copied from user scope
│   ├─ match-jobs/               # skill: score jobs vs resume
│   └─ draft-outreach/           # skill: write cold email (drafter→reviewer)
├─ src/
│   ├─ db.ts                     # SQLite open + schema + helpers
│   ├─ sources/                  # adzuna.ts, remotive.ts, remoteok.ts, serper.ts
│   ├─ mcp/
│   │   ├─ job-fetch.ts          # MCP server
│   │   ├─ resume.ts             # MCP server (wraps renderer/index.js)
│   │   ├─ contacts.ts           # MCP server (email cascade)
│   │   └─ email.ts              # MCP server (Gmail send)
│   └─ lib/ (emailVerify.ts, scrape.ts, patterns.ts)
├─ tests/                        # vitest
└─ docs/superpowers/{specs,plans}/
```

---

### Task 0: Project scaffold + assets

**Files:**
- Create: `package.json`, `.gitignore`, `.env.example`, `tsconfig.json`, `vitest.config.ts`
- Copy: `personal/resume/index.js` + `components/` + `input/resume.template.html` + `font/` + `icons/` → `jobber/renderer/`; `personal/resume/input/resume.json` → `jobber/input/resume.json`
- Copy: `~/.claude/plugins/.../the-humanizer` (locate first) → `jobber/.claude/skills/the-humanizer/`

- [ ] **Step 1:** `git init`; create `package.json` with deps `@modelcontextprotocol/sdk better-sqlite3 handlebars playwright`, dev `typescript tsx vitest @types/node`; scripts `test: vitest run`, `build: tsc`.
- [ ] **Step 2:** `.gitignore` → `node_modules`, `.env`, `automation/`, `*.pdf`, `data.sqlite`. `.env.example` listing every key (OPENROUTER, ADZUNA_APP_ID/KEY, SERPER_API_KEY, HUNTER_API_KEY, HUNTER_ENABLED, HUNTER_MONTHLY_CAP, GMAIL_USER, GMAIL_APP_PASSWORD, TELEGRAM_BOT_TOKEN).
- [ ] **Step 3:** Locate the-humanizer: `find ~/.claude -type d -name the-humanizer`; copy it into `.claude/skills/the-humanizer/`. Verify `SKILL.md` present.
- [ ] **Step 4:** Copy renderer assets; `cd renderer && npm i && node index.js` against `../input/resume.json` to confirm it still produces a PDF locally.
- [ ] **Step 5:** `npm i`; commit: `git commit -m "chore: scaffold Jobber + copy renderer + humanizer"`.

**Verify:** `renderer/resume.pdf` generated; `the-humanizer/SKILL.md` exists.

---

### Task 1: SQLite state module

**Files:** Create `src/db.ts`; Test `tests/db.test.ts`

**Produces:** `openDb()`, `markSeen(id)`, `isSeen(id)`, `saveJob(job)`, `saveContact(c)`, `saveOutreach(o)`, `getJob(id)`.

- [ ] **Step 1 (test):** write `tests/db.test.ts`: open in-memory db, `saveJob({id:'adzuna:1',...})`, assert `isSeen('adzuna:1')===true` and `isSeen('x')===false`.
- [ ] **Step 2:** run `npx vitest run tests/db.test.ts` → FAIL (module missing).
- [ ] **Step 3:** implement `src/db.ts` — `better-sqlite3`; `CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, source, title, company, url, apply_url, description, score INT, status, created_at)`, `contacts(id INTEGER PK, company, email, type, verified INT, source, confidence, created_at)`, `outreach(id INTEGER PK, job_id, contact_email, subject, body, resume_path, sent_at, status)`. Helpers use `INSERT OR IGNORE`.
- [ ] **Step 4:** run vitest → PASS.
- [ ] **Step 5:** commit `feat: sqlite state module`.

---

### Task 2: `job-fetch` MCP (sources + normalize + dedup)

**Files:** Create `src/sources/{adzuna,remotive,remoteok,serper}.ts`, `src/mcp/job-fetch.ts`; Test `tests/sources.test.ts`

**Interfaces — Produces:** MCP tools `search_jobs({role,location,remote})`, `search_hiring_posts({role,geo})`, `list_new_jobs()` → `Job[]` where `Job={id,source,title,company,url,apply_url,description}`.

- [ ] **Step 1 (test):** `tests/sources.test.ts` — feed a captured Adzuna JSON fixture to `normalizeAdzuna()`, assert it returns `{id:'adzuna:<id>', title, company, apply_url, source:'adzuna'}`. (Reuse the exact field mapping from `personal/resume` A1 "Normalize Adzuna" code.) Repeat for remotive/remoteok fixtures.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3:** implement each `src/sources/*.ts` with a `fetchX()` (HTTP) + `normalizeX()` (pure, mapping to `Job`). Port the A1 normalizers verbatim (Adzuna `results[]`, Remotive `jobs[]`, RemoteOK array w/ dev-keyword filter). Serper: POST `google.serper.dev/search` with the 3 dork queries from A2.
- [ ] **Step 4:** vitest → PASS (normalizers pure-tested; live HTTP behind a `--live` guard).
- [ ] **Step 5:** implement `src/mcp/job-fetch.ts` using `@modelcontextprotocol/sdk` `McpServer` over stdio; each tool calls the source fns; `list_new_jobs` = fetch all → `isSeen` filter → `saveJob` + `markSeen` → return new.
- [ ] **Step 6:** manual: `npx tsx src/mcp/job-fetch.ts` and call via MCP inspector or a tiny client script; confirm `list_new_jobs` returns rows and second call returns fewer (dedup).
- [ ] **Step 7:** commit `feat: job-fetch MCP with 4 sources + dedup`.

---

### Task 3: `resume` MCP (wrap the renderer)

**Files:** Create `src/mcp/resume.ts`; Test `tests/resume.test.ts`

**Interfaces — Produces:** `get_base_resume()` → resume JSON; `render_resume({resume_json})` → `{pdf_path}`.

- [ ] **Step 1 (test):** `tests/resume.test.ts` — call `renderResume(baseJson)`; assert returned path exists and file size > 10KB.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3:** implement `renderResume()` — write `resume_json` to a temp folder under `renderer/automation/<uuid>/resume.json`, `execFile('node', ['index.js', '<uuid>'], {cwd: 'renderer'})`, return the produced `resume.pdf` path. Wrap as MCP tools in `src/mcp/resume.ts`.
- [ ] **Step 4:** vitest → PASS.
- [ ] **Step 5:** commit `feat: resume MCP wrapping index.js renderer`.

---

### Task 4: `contacts` MCP (email cascade + verify)

**Files:** Create `src/lib/{scrape,patterns,emailVerify}.ts`, `src/mcp/contacts.ts`; Test `tests/contacts.test.ts`

**Interfaces — Produces:** `find_company_emails({company,domain?,person_name?})` → `Contact[]` sorted by rank, `Contact={email,type,verified,source,confidence}`.

- [ ] **Step 1 (test):** unit-test the pure pieces: `extractEmails(html)` finds `careers@x.com` in sample HTML; `rankEmails([...])` orders role-specific before generic; `genPatterns('Jane Doe','x.com','{first}.{last}')` → `['jane.doe@x.com', ...]`.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3:** implement:
  - `scrape.ts`: Playwright fetch of `/careers /contact /about` + homepage footer → `extractEmails()` (regex).
  - `patterns.ts`: `genPatterns(name, domain, pattern?)`.
  - `emailVerify.ts`: `verify(email)` → MX lookup (`dns.resolveMx`) + optional SMTP-RCPT probe; returns bool.
- [ ] **Step 4:** vitest → PASS on pure fns.
- [ ] **Step 5:** implement `src/mcp/contacts.ts` cascade: job-data → domain resolve → scrape → serper search → (Hunter if `HUNTER_ENABLED` && under cap) → patterns; then `verify()` each; `rankEmails()`; persist via `saveContact`. Return verified-only unless none, then flag.
- [ ] **Step 6:** manual live test on 2–3 real companies; confirm at least role/generic emails found + verified flags set.
- [ ] **Step 7:** commit `feat: contacts MCP multi-strategy email finder`.

---

### Task 5: `email` MCP (Gmail send)

**Files:** Create `src/mcp/email.ts`; Test `tests/email.test.ts`

**Interfaces — Produces:** `send_email({to,subject,body,attachment_path})` → `{message_id}`.

- [ ] **Step 1 (test):** with `nodemailer` + a mock transport, assert `sendEmail()` builds a message with the attachment and calls transport once.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3:** implement with `nodemailer` SMTP (`smtp.gmail.com:465`, `GMAIL_USER` + `GMAIL_APP_PASSWORD`); attach the PDF; wrap as MCP tool.
- [ ] **Step 4:** vitest → PASS (mock). Then one real send to **your own** address to confirm delivery + attachment.
- [ ] **Step 5:** commit `feat: email MCP (gmail smtp)`.

---

### Task 6: Agent brain — skills + CLAUDE.md

**Files:** Create `.claude/skills/match-jobs/SKILL.md`, `.claude/skills/draft-outreach/SKILL.md`, `CLAUDE.md`

- [ ] **Step 1:** Clone `ai-job-search` to `/tmp`, read its `job-application-assistant` + scraper skills; adapt the *match* + *draft (drafter→reviewer)* prompt patterns into our two skills. `match-jobs` scores a job vs `get_base_resume()` (0–100 + reasons). `draft-outreach` writes a cold email from job + resume + a discovered contact, then a reviewer pass, then invokes **the-humanizer**.
- [ ] **Step 2:** Write `CLAUDE.md` orchestration: "When asked to run the hunt: call `job-fetch.list_new_jobs`; for each, use `match-jobs`; for score ≥ THRESHOLD call `contacts.find_company_emails`; if a verified email exists, tailor the resume JSON, `resume.render_resume`, `draft-outreach`, `email.send_email` to the top verified contact; log; then post a Telegram summary. If no verified email, report the job to Telegram instead." Include the tailoring prompt (port workflow B's system message).
- [ ] **Step 3:** commit `feat: match + draft skills and CLAUDE.md orchestration`.

---

### Task 7: Claude Code wiring + LOCAL end-to-end smoke test

**Files:** Create `.mcp.json`

- [ ] **Step 1:** `.mcp.json` registering the 4 servers, e.g. `{"mcpServers":{"job-fetch":{"command":"npx","args":["tsx","src/mcp/job-fetch.ts"]}, ...}}`.
- [ ] **Step 2:** Export OpenRouter env (Global Constraints). Verify model: `claude -p "say hi" ` returns text (confirms OpenRouter path). If it fails, install `claude-code-router` and retry via `ccr code` (fallback path).
- [ ] **Step 3:** `claude -p "list my available MCP tools"` → confirm all 4 servers' tools load.
- [ ] **Step 4:** Dry-run: `claude -p "run the hunt but DO NOT send email — just show me what you'd send for the top 2 matches" --permission-mode acceptEdits` → inspect matches, tailored resume, drafted+humanized email, chosen verified contact.
- [ ] **Step 5:** Live smoke: allow one real send to **your own** email (set THRESHOLD high / limit 1). Confirm you receive a humanized email + tailored PDF.
- [ ] **Step 6:** commit `feat: mcp wiring + local smoke passing`.

**Stop point:** get user review of a real drafted email before enabling real recruiter sends.

---

### Task 8: VPS deploy

- [ ] **Step 1:** Provision Ubuntu VPS (Hetzner CX22). Install Node 20, git, `npx playwright install --with-deps chromium`, Claude Code CLI.
- [ ] **Step 2:** `git clone` the repo; `npm i`; copy `.env` (secrets) securely (scp / paste); set OpenRouter env in a profile file.
- [ ] **Step 3:** Re-run Task 7 Step 4 dry-run on the VPS; confirm parity with local.
- [ ] **Step 4:** commit any VPS-specific path fixes.

---

### Task 9: Telegram channel + cron

- [ ] **Step 1:** `/plugin install telegram@claude-plugins-official`; `/telegram:configure <TELEGRAM_BOT_TOKEN>`; pair; start `claude --channels plugin:telegram@claude-plugins-official` as a systemd service. Test: message the bot "show today's top 3".
- [ ] **Step 2:** cron entry: `0 9 * * * cd ~/jobber && claude -p "run the hunt" --permission-mode acceptEdits --mcp-config .mcp.json >> hunt.log 2>&1` (start with a send-limit; graduate to full once trusted).
- [ ] **Step 3:** Confirm a scheduled run posts a summary to Telegram.
- [ ] **Step 4:** commit `feat: telegram channel + cron autonomy`.

**Phase 1 done** → smoke-tested cold-outreach agent. Next: migrate to `@example.com` (spec §9), then Phase 2 (LinkedIn).

---

## Self-Review

- **Spec coverage:** discovery (T2), match (T6), tailor+render (T3/T6), email cascade+verify (T4), humanized send (T5/T6), SQLite (T1), Telegram+cron (T9), VPS+OpenRouter (T7/T8), humanizer copied (T0), ai-job-search adopted (T6), Hunter gated (T4/Global). ✓
- **Placeholders:** none — each task has concrete files, interfaces, commands. External-repo/VPS tasks are inspect-then-adapt steps by necessity (repo not yet cloned), not vague filler.
- **Type consistency:** `Job`, `Contact` shapes defined in T2/T4 and consumed by T6/T7 match.
