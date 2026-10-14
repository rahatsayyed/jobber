# Autonomous Outreach Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the hunt pipeline's contact/prepare/send stages: drop Serper, expand contact-finder to find both an email contact and LinkedIn people (recruiter + peer), split outreach-preparer into "prepare and queue" (no sends) with a new persistent `outreach_queue` table, and expand `sender` into the single queue-execution point that atomically guards email sends, reacts to `connect_send`/`apply.*`'s own internal rate limits, and prompts Telegram with an overrun option when a cap is hit. Rename `sqlite` MCP to `db` and add write-capable tools so subagents can enqueue/update outreach items directly.

**Architecture:** Mostly subagent-prompt changes (`.claude/agents/*.md`) plus three real code changes: a new `outreach_queue` table + pure functions in `src/db.ts`, an expanded/renamed `db` MCP server (`src/mcp/sqlite.ts` → `src/mcp/db.ts`) with new tools, and removal of the Serper source. No new Playwright/browser code — `connect.ts`/`apply/*.ts` already exist and already self-enforce their own daily caps; this plan wires the orchestration around them differently, it doesn't change their internals.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `better-sqlite3` via `src/db.ts`, `vitest`. No new dependencies.

## Global Constraints

- `connect.connect_send` and every `apply.<platform>` tool already internally call `checkAndIncrement` (`src/lib/rateLimit.ts`) against their own daily counters (`'connect_send'` key for connect, shared `'easy_apply'` key across all five apply tools) and already return `{status: 'rate_limited', ...}` when the cap is hit. **`sender` must never pre-check those same keys itself** — doing so would double-increment the counter (once from `sender`'s own check, once inside the tool call), silently halving the real daily budget. `sender` only needs its own atomic guard for **email**, since `gmail.send_email` has no built-in rate limiting.
- New generic tool `db.check_and_increment({key, limit})` wraps the existing `checkAndIncrement` function for exactly this email-guarding purpose (and any future daily-cap need) — it is NOT used for `connect`/`apply`.
- `outreach_queue` rows: a job with both a recruiter AND a peer LinkedIn profile produces TWO rows (one per connect target), sharing the same `job_id`/resume/email fields, differing only in `connect_*` fields.
- Connect notes: hard 300-character cap and must reference the specific job/role by name — already enforced by the existing `draft-connect-note` skill (Step B, "Length" and "generic?" checks); no skill changes required unless a task below says otherwise.
- `connect_send`'s per-note human-approval gate is REMOVED from the orchestration docs (`CLAUDE.md`) — `sender` calls it directly, no Telegram wait per note. The automated recipient-verification safety net inside `connect.ts` (`verifyRecipientName`, `verifyProfileUrl`, fail-closed) is UNCHANGED and still runs on every call.
- `AUTO_APPLY_ENABLED`'s opt-in gate is REMOVED from `CLAUDE.md` — applying becomes an unconditional part of every hunt run's queue execution. This flag is not deleted from `.env.example` in this plan (out of scope — no task references re-adding a replacement flag), it simply stops being checked in the orchestration docs.
- Extraction of structured fields from raw LinkedIn-post text (company/title/apply-method in `matcher`) and seniority-band judgment (in `contact-finder`) are LLM-judgment tasks performed by the subagent reading free text, not deterministic pure functions — the spec's suggestion that these be "unit-tested against fixtures" doesn't fit their actual nature (an LLM's read of ambiguous natural language isn't something a fixture-based assertion can meaningfully pin down the way a DOM-parsing function can). This plan implements them as subagent-prompt instructions only, with no corresponding unit test task — noted here as a deliberate, reasoned deviation from the spec's testing section, not an oversight.
- `Job`, `isSeen`, `saveJob`, `openDb` (all in `src/db.ts`) are unchanged — every new function in this plan is additive.

---

### Task 1: `outreach_queue` table + pure functions in `src/db.ts`

**Files:**
- Modify: `src/db.ts`
- Test: `tests/db.test.ts`

**Interfaces:**
- Produces: `OutreachQueueItem` interface, `enqueueOutreach(db, item: Omit<OutreachQueueItem, 'id'|'status'|'created_at'|'updated_at'>): number`, `listQueuedOutreach(db): OutreachQueueItem[]`, `updateOutreachStatus(db, id: number, field: 'email_status'|'connect_status'|'apply_status'|'status', value: string): void` — all exported from `src/db.ts`, consumed by Task 2's MCP tools.

- [ ] **Step 1: Write the failing tests**

Read `tests/db.test.ts` first to match its existing style (imports, `openDb(':memory:')` pattern), then append:

```typescript
import { enqueueOutreach, listQueuedOutreach, updateOutreachStatus, type OutreachQueueItem } from '../src/db.js';

describe('outreach_queue', () => {
  it('enqueues an item and returns its new row id', () => {
    const db = openDb(':memory:');
    const id = enqueueOutreach(db, {
      job_id: 'li-job:123',
      resume_pdf_path: '/tmp/resume.pdf',
      email_subject: 'Application for Full Stack Developer',
      email_body: 'Hi there...',
      email_to: 'hr@acme.com',
      connect_note: null,
      connect_profile_url: null,
      connect_category: null,
      apply_platform: 'greenhouse',
      apply_url: 'https://boards.greenhouse.io/acme/jobs/123',
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('lists only queued rows, ordered by created_at', () => {
    const db = openDb(':memory:');
    const id1 = enqueueOutreach(db, {
      job_id: 'job-a', resume_pdf_path: null, email_subject: null, email_body: null,
      email_to: null, connect_note: 'note a', connect_profile_url: 'https://linkedin.com/in/a',
      connect_category: 'recruiter', apply_platform: 'none', apply_url: null,
    });
    updateOutreachStatus(db, id1, 'status', 'done'); // should be excluded from listQueuedOutreach

    const id2 = enqueueOutreach(db, {
      job_id: 'job-b', resume_pdf_path: null, email_subject: null, email_body: null,
      email_to: null, connect_note: 'note b', connect_profile_url: 'https://linkedin.com/in/b',
      connect_category: 'peer', apply_platform: 'none', apply_url: null,
    });

    const queued = listQueuedOutreach(db);
    expect(queued).toHaveLength(1);
    expect(queued[0].id).toBe(id2);
    expect(queued[0].job_id).toBe('job-b');
  });

  it('updates a single field without touching others', () => {
    const db = openDb(':memory:');
    const id = enqueueOutreach(db, {
      job_id: 'job-c', resume_pdf_path: null, email_subject: 'Subj', email_body: 'Body',
      email_to: 'x@y.com', connect_note: null, connect_profile_url: null,
      connect_category: null, apply_platform: 'none', apply_url: null,
    });

    updateOutreachStatus(db, id, 'email_status', 'sent');

    const [row] = listQueuedOutreach(db);
    expect(row.email_status).toBe('sent');
    expect(row.email_subject).toBe('Subj'); // untouched
    expect(row.status).toBe('queued'); // untouched (still queued overall)
  });

  it('a row with both a recruiter and peer connect target is two separate rows sharing job_id', () => {
    const db = openDb(':memory:');
    enqueueOutreach(db, {
      job_id: 'job-d', resume_pdf_path: '/tmp/r.pdf', email_subject: 'S', email_body: 'B',
      email_to: 'z@y.com', connect_note: 'recruiter note', connect_profile_url: 'https://linkedin.com/in/recruiter',
      connect_category: 'recruiter', apply_platform: 'none', apply_url: null,
    });
    enqueueOutreach(db, {
      job_id: 'job-d', resume_pdf_path: '/tmp/r.pdf', email_subject: 'S', email_body: 'B',
      email_to: 'z@y.com', connect_note: 'peer note', connect_profile_url: 'https://linkedin.com/in/peer',
      connect_category: 'peer', apply_platform: 'none', apply_url: null,
    });

    const queued = listQueuedOutreach(db);
    expect(queued).toHaveLength(2);
    expect(queued.every((r) => r.job_id === 'job-d')).toBe(true);
    expect(queued.map((r) => r.connect_category).sort()).toEqual(['peer', 'recruiter']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/db.test.ts`
Expected: FAIL — `enqueueOutreach`/`listQueuedOutreach`/`updateOutreachStatus` are not exported yet.

- [ ] **Step 3: Implement the table and functions**

In `src/db.ts`, add the table to the `db.exec(...)` migration block inside `openDb` (alongside the existing `CREATE TABLE IF NOT EXISTS` statements — add this one to the same template string, don't create a second `db.exec` call):

```sql
    CREATE TABLE IF NOT EXISTS outreach_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      resume_pdf_path TEXT,
      email_subject TEXT,
      email_body TEXT,
      email_to TEXT,
      email_status TEXT,
      connect_note TEXT,
      connect_profile_url TEXT,
      connect_category TEXT,
      connect_status TEXT,
      apply_platform TEXT,
      apply_url TEXT,
      apply_status TEXT,
      status TEXT DEFAULT 'queued',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
```

Then, after the existing `saveConnection` function (end of the file), add:

```typescript
export interface OutreachQueueItem {
  id: number;
  job_id: string;
  resume_pdf_path: string | null;
  email_subject: string | null;
  email_body: string | null;
  email_to: string | null;
  email_status: string | null;
  connect_note: string | null;
  connect_profile_url: string | null;
  connect_category: string | null;
  connect_status: string | null;
  apply_platform: string | null;
  apply_url: string | null;
  apply_status: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

export function enqueueOutreach(
  db: BetterSqlite3.Database,
  item: {
    job_id: string;
    resume_pdf_path: string | null;
    email_subject: string | null;
    email_body: string | null;
    email_to: string | null;
    connect_note: string | null;
    connect_profile_url: string | null;
    connect_category: string | null;
    apply_platform: string | null;
    apply_url: string | null;
  }
): number {
  const result = db.prepare(`
    INSERT INTO outreach_queue (
      job_id, resume_pdf_path, email_subject, email_body, email_to,
      connect_note, connect_profile_url, connect_category,
      apply_platform, apply_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.job_id,
    item.resume_pdf_path,
    item.email_subject,
    item.email_body,
    item.email_to,
    item.connect_note,
    item.connect_profile_url,
    item.connect_category,
    item.apply_platform,
    item.apply_url
  );
  return Number(result.lastInsertRowid);
}

export function listQueuedOutreach(db: BetterSqlite3.Database): OutreachQueueItem[] {
  return db
    .prepare(`SELECT * FROM outreach_queue WHERE status = 'queued' ORDER BY created_at ASC`)
    .all() as OutreachQueueItem[];
}

const UPDATABLE_FIELDS = ['email_status', 'connect_status', 'apply_status', 'status'] as const;

export function updateOutreachStatus(
  db: BetterSqlite3.Database,
  id: number,
  field: (typeof UPDATABLE_FIELDS)[number],
  value: string
): void {
  if (!UPDATABLE_FIELDS.includes(field)) {
    throw new Error(`updateOutreachStatus: invalid field "${field}"`);
  }
  db.prepare(`UPDATE outreach_queue SET ${field} = ?, updated_at = datetime('now') WHERE id = ?`).run(value, id);
}
```

(The `UPDATABLE_FIELDS.includes(field)` check is defense-in-depth against a future caller passing an unvalidated string — `field`'s TypeScript type already restricts callers at compile time, but this keeps the SQL column-name interpolation safe even if that type were ever loosened.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/db.test.ts`
Expected: PASS (4 new tests, plus every pre-existing test in this file)

- [ ] **Step 5: Commit**

```bash
git add src/db.ts tests/db.test.ts
git commit -m "feat: add outreach_queue table and enqueue/list/update functions"
```

---

### Task 2: Rename `sqlite` MCP to `db`, add write-capable tools

**Files:**
- Rename: `src/mcp/sqlite.ts` → `src/mcp/db.ts`
- Modify: `.mcp.json`, `package.json`, `CLAUDE.md`

**Interfaces:**
- Consumes: `enqueueOutreach`, `listQueuedOutreach`, `updateOutreachStatus` from `../db.js` (Task 1), `checkAndIncrement` from `../lib/rateLimit.js` (existing).
- Produces: MCP tools `db.list_jobs`, `db.get_job_stats`, `db.list_outreach`, `db.get_outreach_stats`, `db.list_threads`, `db.raw_query` (all renamed-server, same behavior), plus new `db.enqueue_outreach`, `db.list_queued_outreach`, `db.update_outreach_status`, `db.check_and_increment` — consumed by Task 6 (`outreach-preparer`) and Task 7 (`sender`).

- [ ] **Step 1: Rename the file and the server name**

```bash
git mv src/mcp/sqlite.ts src/mcp/db.ts
```

In `src/mcp/db.ts`, change:
```typescript
const server = new McpServer({ name: 'sqlite', version: '1.0.0' });
```
to:
```typescript
const server = new McpServer({ name: 'db', version: '1.0.0' });
```

- [ ] **Step 2: Add the new tools**

At the top of `src/mcp/db.ts`, add to the existing imports:
```typescript
import { enqueueOutreach, listQueuedOutreach, updateOutreachStatus } from '../db.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
```

Before the final `async function main()` in the file, add:

```typescript
server.registerTool(
  'enqueue_outreach',
  {
    description: 'Add one prepared outreach item (resume/email/connect-note/apply-plan) to the outreach_queue for the sender stage to execute later. Pure persistence — does not send anything.',
    inputSchema: {
      job_id: z.string(),
      resume_pdf_path: z.string().optional(),
      email_subject: z.string().optional(),
      email_body: z.string().optional(),
      email_to: z.string().optional(),
      connect_note: z.string().optional(),
      connect_profile_url: z.string().optional(),
      connect_category: z.enum(['recruiter', 'peer']).optional(),
      apply_platform: z.enum(['linkedin', 'greenhouse', 'lever', 'workday', 'ashby', 'none']).optional(),
      apply_url: z.string().optional(),
    },
  },
  async (params) => {
    const id = enqueueOutreach(db, {
      job_id: params.job_id,
      resume_pdf_path: params.resume_pdf_path ?? null,
      email_subject: params.email_subject ?? null,
      email_body: params.email_body ?? null,
      email_to: params.email_to ?? null,
      connect_note: params.connect_note ?? null,
      connect_profile_url: params.connect_profile_url ?? null,
      connect_category: params.connect_category ?? null,
      apply_platform: params.apply_platform ?? null,
      apply_url: params.apply_url ?? null,
    });
    return { content: [{ type: 'text', text: JSON.stringify({ id }) }] };
  }
);

server.registerTool(
  'list_queued_outreach',
  {
    description: 'List every outreach_queue row still pending (status=queued), oldest first. Used by the sender stage to get its full backlog, including anything left over from a previous run that hit a rate cap.',
    inputSchema: {},
  },
  async () => {
    const rows = listQueuedOutreach(db);
    return { content: [{ type: 'text', text: JSON.stringify(rows) }] };
  }
);

server.registerTool(
  'update_outreach_status',
  {
    description: 'Update one status field on an outreach_queue row after attempting its action (email/connect/apply), or the overall row status once all its actions are attempted.',
    inputSchema: {
      id: z.number(),
      field: z.enum(['email_status', 'connect_status', 'apply_status', 'status']),
      value: z.string(),
    },
  },
  async ({ id, field, value }) => {
    updateOutreachStatus(db, id, field, value);
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
  }
);

server.registerTool(
  'check_and_increment',
  {
    description: 'Atomically check whether a daily counter is still under its limit and increment it if so. Returns {allowed: true} and increments, or {allowed: false} without incrementing if the limit is already reached. Use a distinct `key` per thing being capped (e.g. "send_email") — do NOT reuse "connect_send" or "easy_apply", which connect.connect_send and apply.* already increment internally themselves.',
    inputSchema: {
      key: z.string(),
      limit: z.number(),
    },
  },
  async ({ key, limit }) => {
    const allowed = checkAndIncrement(db, key, limit);
    return { content: [{ type: 'text', text: JSON.stringify({ allowed }) }] };
  }
);
```

- [ ] **Step 3: Update `.mcp.json`**

Change the `"sqlite"` entry to:
```json
    "db": { "command": "npx", "args": ["tsx", "src/mcp/db.ts"] },
```
(keep its position in the object; every other entry stays untouched).

- [ ] **Step 4: Update `package.json`**

Change `"mcp:sqlite": "tsx src/mcp/sqlite.ts"` to `"mcp:db": "tsx src/mcp/db.ts"`.

- [ ] **Step 5: Update `CLAUDE.md`'s two references**

In the "Status Command" section, change:
```
1. Call `sqlite.get_job_stats()` → returns total, by_status, by_source.
2. Call `sqlite.get_outreach_stats()` → returns total, by_status, by_month.
```
to:
```
1. Call `db.get_job_stats()` → returns total, by_status, by_source.
2. Call `db.get_outreach_stats()` → returns total, by_status, by_month.
```

- [ ] **Step 6: Verify and run the full suite**

Run: `npx vitest run` (existing `sqlite.ts` had no dedicated test file per the current test suite — confirm this is still true by checking `tests/` doesn't reference `mcp/sqlite`; if it does, update the import path to `mcp/db.js`).
Run: `npx tsc -p . --noEmit` — expect only the 2 known pre-existing errors in `src/apply/linkedin.ts` (lines 76, 193).

- [ ] **Step 7: Commit**

```bash
git add src/mcp/db.ts .mcp.json package.json CLAUDE.md
git rm --cached src/mcp/sqlite.ts 2>/dev/null || true
git commit -m "feat: rename sqlite MCP to db, add enqueue/list/update/check_and_increment tools"
```

---

### Task 3: Drop Serper

**Files:**
- Delete: `src/sources/serper.ts`
- Modify: `src/sources/index.ts`, `src/mcp/job-fetch.ts`, `.claude/agents/discoverer.md`

**Interfaces:** none new — this only removes code. `fetchAllJobs` (already Adzuna/Remotive/RemoteOK only, per current `src/sources/index.ts`) is untouched; only `fetchHiringPosts` and the unused `search_hiring_posts` tool go away.

- [ ] **Step 1: Confirm nothing else depends on Serper**

Run: `grep -rn "serper\|fetchHiringPosts\|search_hiring_posts" src tests .claude/agents CLAUDE.md`
Expected matches: `src/sources/serper.ts` (the file itself), `src/sources/index.ts`'s `fetchHiringPosts` export, `src/mcp/job-fetch.ts`'s import and `search_hiring_posts` tool registration, and `tests/` if a `serper.test.ts` exists (check and remove it too in Step 2 if so). `discoverer.md`'s step 1 also mentions "the Serper Google-dork hiring post search" in its description of `list_new_jobs` — this is inaccurate already today (Serper was never in `fetchAllJobs`), but fix it while touching this file anyway.

- [ ] **Step 2: Remove the source and its test**

```bash
git rm src/sources/serper.ts
git rm tests/serper.test.ts 2>/dev/null || true
```

- [ ] **Step 3: Remove `fetchHiringPosts` from `src/sources/index.ts`**

Delete this function and its now-unused import:
```typescript
import { fetchSerper } from './serper.js';
// ...
export async function fetchHiringPosts(params: { role: string; geo?: string }): Promise<Job[]> {
  return fetchSerper({ role: params.role, geo: params.geo });
}
```

- [ ] **Step 4: Remove `search_hiring_posts` from `src/mcp/job-fetch.ts`**

Delete the `fetchHiringPosts` import and this entire `server.registerTool('search_hiring_posts', ...)` block:
```typescript
server.registerTool(
  'search_hiring_posts',
  {
    description: 'Search LinkedIn hiring posts via Google dorks (Serper)',
    inputSchema: {
      role: z.string(),
      geo: z.string().optional(),
    },
  },
  async ({ role, geo }) => {
    const jobs = await fetchHiringPosts({ role, geo });
    return {
      content: [{ type: 'text', text: JSON.stringify(jobs) }],
    };
  }
);
```
Leave `search_jobs` and `list_new_jobs` untouched.

- [ ] **Step 5: Fix `discoverer.md`'s inaccurate Serper mention**

Change:
```
1. Call `list_new_jobs({role, location})` using the exact `role` and `location` values passed to
   you in the prompt. This covers Adzuna, Remotive, RemoteOK, and the Serper Google-dork hiring
   post search.
```
to:
```
1. Call `list_new_jobs({role, location})` using the exact `role` and `location` values passed to
   you in the prompt. This covers Adzuna, Remotive, and RemoteOK.
```

- [ ] **Step 6: Verify**

Run: `npx vitest run` — expect one fewer test file than before (serper.test.ts gone), everything else passing.
Run: `npx tsc -p . --noEmit` — only the 2 known pre-existing errors.
Run: `grep -n "SERPER_API_KEY" .env.example` — leave this env var alone (harmless if unused; removing it is out of scope for this task, not requested).

- [ ] **Step 7: Commit**

```bash
git add src/sources/index.ts src/mcp/job-fetch.ts .claude/agents/discoverer.md
git commit -m "chore: drop Serper hiring-post source (superseded by discover.linkedin_posts)"
```

---

### Task 4: `MATCH_THRESHOLD` default → 60

**Files:**
- Modify: `.env.example`, `CLAUDE.md`

**Interfaces:** none — documentation/config-template only.

- [ ] **Step 1: Update `.env.example`**

Change `MATCH_THRESHOLD=70               # only pursue jobs scored >= this` to `MATCH_THRESHOLD=60               # only pursue jobs scored >= this`.

- [ ] **Step 2: Update `CLAUDE.md`'s three references**

- Preferences section: `- **MATCH_THRESHOLD**: \`70\` (env var; jobs scoring below this are skipped — see \`.env\`)` → `\`60\``.
- "Running the hunt" step 2 (Match): `with \`score < MATCH_THRESHOLD\` (env var, default 70) is SKIPPED` → `default 60`.
- The other inline mention (`score >= MATCH_THRESHOLD`) has no literal number to change — leave as-is, just confirm it doesn't also say "70" anywhere nearby.

- [ ] **Step 3: Commit**

```bash
git add .env.example CLAUDE.md
git commit -m "chore: change MATCH_THRESHOLD documented default from 70 to 60"
```

---

### Task 5: Extend `matcher` — structured extraction for LinkedIn-post-sourced jobs

**Files:**
- Modify: `.claude/agents/matcher.md`

**Interfaces:**
- Produces: extended output shape `{job_id, score, reasons, missing_keywords, extracted_company?, extracted_title?, apply_method?}` — the three new fields are only ever present when `job.source === 'linkedin-posts'`; consumed by the orchestrator's filtering step (unchanged) and by Task 6 (`contact-finder`, which can use `extracted_company` when `job.company` is empty).

- [ ] **Step 1: Rewrite `.claude/agents/matcher.md`**

Replace its full contents:

```markdown
---
name: matcher
description: Scores a batch of jobs against the base resume using the match-jobs skill. Use as the second stage of every hunt run.
tools: Skill, mcp__resume__get_base_resume
---

You are the matching stage of the Jobber pipeline. You are given a list of Job objects and
must score every one of them against the base resume.

## Steps

1. Call `resume.get_base_resume()` ONCE. Keep it in memory for the rest of this task.
2. For EACH job in the list you were given, invoke the `match-jobs` skill with that job and the
   base resume. It returns `{score, reasons, missing_keywords}`.
3. For each job whose `id` starts with `li-post:` (a LinkedIn-hiring-post-sourced job, whose
   `company` field is empty and `description` is raw, unstructured post text), additionally read
   the `description` and extract, best-effort:
   - `extracted_company`: the hiring company's name, if confidently stated in the text (e.g. "at
     Acme Corp", "join Acme's team"). `null` if not confidently extractable — never guess.
   - `extracted_title`: the role title being hired for, if confidently stated. `null` if not
     confidently extractable.
   - `apply_method`: one of `"email"` (an email address appears in the text), `"link"` (a URL
     other than the post author's own LinkedIn profile appears — e.g. a job-board or company
     careers-page link), `"linkedin"` (the text implies applying via LinkedIn/DM, e.g. "DM me" or
     "apply on LinkedIn"), or `null` if none of these are confidently detected.
   These three fields are extras — never fabricate a value when the text doesn't clearly support
   one; use `null` rather than guessing. Do not add these fields for non-`li-post:` jobs at all
   (omit them entirely, don't set them to `null` for jobs where they don't apply).
4. Return a single JSON array, one entry per job, of the shape:
   `{"job_id": "<job.id>", "score": <int>, "reasons": "<string>", "missing_keywords": [...], "extracted_company"?: "<string>"|null, "extracted_title"?: "<string>"|null, "apply_method"?: "email"|"link"|"linkedin"|null}`.
   Preserve the original order of the input jobs.
5. Do not filter anything out yourself and do not apply `MATCH_THRESHOLD` — that decision belongs
   to the orchestrating session, which has the current threshold value. Score every job you were
   given, honestly, including ones you expect to score low.

Do not call `contacts`, `resume.render_resume`, `gmail`, or `draft-outreach` — those belong to
later stages.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/agents/matcher.md
git commit -m "feat: matcher extracts structured fields from raw LinkedIn-post-sourced jobs"
```

(No test task here — see Global Constraints: this is LLM free-text judgment, not a deterministic function; there is nothing to unit-test.)

---

### Task 6: Expand `contact-finder` — email + recruiter/HR profile + peer profile

**Files:**
- Modify: `.claude/agents/contact-finder.md`

**Interfaces:**
- Consumes: `mcp__connect__find_linkedin_profile` (existing tool, `{company: string, role_hint?: string}` → up to 3 candidate profiles) — needs to be added to this subagent's `tools` frontmatter.
- Produces: extended output `{job_id, contact: {...}|null, linkedin_profiles: [{profile: {...}, category: 'recruiter'|'peer'}, ...]}` — consumed by Task 7 (`outreach-preparer`).

- [ ] **Step 1: Rewrite `.claude/agents/contact-finder.md`**

Replace its full contents:

```markdown
---
name: contact-finder
description: Finds a verified company email AND LinkedIn people to connect with (recruiter/HR and a similar-role peer), for a batch of matched jobs. Use as the third stage, after matching and threshold filtering.
tools: mcp__contacts__find_company_emails, mcp__connect__find_linkedin_profile
---

You are the contact-finding stage of the Jobber pipeline. You are given a list of MATCHED
jobs (already filtered by score — do not re-filter or re-score anything). For each job, use
`job.company` if non-empty, otherwise `job.extracted_company` (from the matcher stage) if
present — if neither is available, skip the LinkedIn-profile searches for that job (you cannot
search a company you don't know) but still attempt the email search using whatever company
value is available.

## Steps, for EACH job

1. Call `contacts.find_company_emails({company, domain?: <if known>})`. Determine:
   - If there is at least one `verified: true` entry, pick the highest-confidence one as the
     "top verified contact".
   - If there is none, this job has no usable email contact (`contact: null`).
2. Call `connect.find_linkedin_profile({company, role_hint: "Recruiter"})`,
   `connect.find_linkedin_profile({company, role_hint: "Talent Acquisition"})`, and
   `connect.find_linkedin_profile({company, role_hint: "HR"})`. Merge the three results into one
   candidate pool for the **recruiter** category. From that pool, exclude any candidate whose
   headline/title contains "Intern", "Associate" (too junior), or "Chief", "VP", "Vice
   President", "Director", "Head of" (too senior). From what remains, prefer a candidate whose
   headline/title contains "Senior", "Lead", or "Manager"; if none do, pick the first remaining
   candidate. If nothing remains after exclusion, this job has no recruiter category profile.
3. Call `connect.find_linkedin_profile({company, role_hint: <job's own title — job.title, or
   job.extracted_title if job.title is empty>})`. This is the **peer** category: someone already
   working in a similar role at the company. Do not apply the seniority exclusion from step 2
   here — any peer match is useful signal, pick the first candidate returned. If nothing is
   returned, this job has no peer category profile.
4. Build `linkedin_profiles` as an array containing an entry for each category that found a
   match: `{profile: <the chosen candidate object, unmodified>, category: "recruiter"|"peer"}`.
   This array has 0, 1, or 2 entries (never more than one per category).
5. Return `{"job_id": "<job.id>", "contact": {<top verified contact>}|null, "linkedin_profiles": [...]}`.

Return a single JSON array, one entry per input job, preserving the original order. Never
invent or guess a contact or profile — use `null`/an empty array when nothing usable was found,
and never fall back to an unverified email entry as if it were verified.

Do not call `resume`, `gmail`, `connect.connect_send`, or any drafting skill — those belong to
later stages.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/agents/contact-finder.md
git commit -m "feat: contact-finder also finds recruiter and peer LinkedIn profiles"
```

(No test task here — same reasoning as Task 5: the seniority-band judgment is applied by the LLM reading real headline text, not a coded pure function.)

---

### Task 7: Expand `outreach-preparer` — draft everything, enqueue instead of returning

**Files:**
- Modify: `.claude/agents/outreach-preparer.md`

**Interfaces:**
- Consumes: `mcp__db__enqueue_outreach` (Task 2) — needs to be added to this subagent's `tools` frontmatter, in place of the removed "return JSON to caller" contract.
- Produces: nothing returned to the orchestrator except a short confirmation — the actual output now lives in `outreach_queue` rows (Task 1/2), consumed by Task 8 (`sender`).

- [ ] **Step 1: Rewrite `.claude/agents/outreach-preparer.md`**

Replace its full contents:

```markdown
---
name: outreach-preparer
description: Tailors the resume, drafts the email and connect note(s), determines apply eligibility, and enqueues everything for one matched job. Use as the fourth stage, once per matched job, in parallel across jobs.
tools: Skill, mcp__resume__get_base_resume, mcp__resume__render_resume, mcp__db__enqueue_outreach
---

You are the outreach-preparation stage of the Jobber pipeline. You are given ONE job, its
contact-finder result (`{contact: {...}|null, linkedin_profiles: [...]}`), and the base resume
JSON. Your job is to prepare everything and enqueue it — you do NOT send or connect or apply
yourself; that is the `sender` stage's job, later and separately.

## Steps

1. Invoke the `tailor-resume` skill with the job and the base resume JSON. It handles all
   tailoring rules (schema preservation, no fabrication, one-page trim, humanizer pass) and
   returns `{resume_json, pdf_path}` — do not re-derive or duplicate those rules here; that
   skill is the single source of truth for resume tailoring.
2. If `contact` is present (not `null`): invoke the `draft-outreach` skill with the job, a short
   summary of the tailored resume, and the contact. It returns `{subject, body}` — `body`
   already includes the contact-footer per that skill's Step D. If `contact` is `null`, skip
   this step entirely (no email fields will be enqueued).
3. For EACH entry in `linkedin_profiles` (0, 1, or 2 entries — one per category): invoke the
   `draft-connect-note` skill with the job and that entry's `profile`. It returns a `note`
   string, already humanized and already enforcing the 300-character cap and the
   references-the-job requirement — do not re-derive those rules here.
4. Determine `apply_platform` from `job.apply_url`: `"linkedin"` if it's a LinkedIn Easy Apply
   posting, one of `"greenhouse"`, `"lever"`, `"workday"`, `"ashby"` if it matches a known
   external-ATS URL pattern, or `"none"` if it matches none of these (an unrecognized platform
   is not attempted here — that is out of scope for this stage).
5. Call `db.enqueue_outreach` — if you have both a `contact` and one or more `linkedin_profiles`,
   call it ONCE PER LinkedIn profile entry (so a job with a recruiter AND a peer profile becomes
   TWO queue rows, both carrying the same `job_id`/`resume_pdf_path`/`email_*` fields but
   different `connect_note`/`connect_profile_url`/`connect_category`). If there are NO
   `linkedin_profiles` at all but there IS a `contact`, call it ONCE with only the email fields
   set (all `connect_*` fields omitted). If there is no `contact` AND no `linkedin_profiles`,
   still call it ONCE if `apply_platform` is not `"none"` (so an apply-only row still gets
   queued), passing only `job_id`, `resume_pdf_path`, `apply_platform`, `apply_url`. If none of
   contact, profiles, or a real apply platform exist, do not call `enqueue_outreach` at all for
   this job — there is nothing to queue.
6. Return a short confirmation only: `{"job_id": "<job.id>", "queued_rows": <count>}`. Do not
   return the resume/email/note content itself — it's already persisted.

Do not call `gmail.send_email`, `connect.connect_send`, or any `apply.*` tool — sending/applying
is the separate `sender` stage's job, which reads from the queue you just wrote to.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/agents/outreach-preparer.md
git commit -m "feat: outreach-preparer drafts connect notes and enqueues instead of returning to caller"
```

---

### Task 8: Expand `sender` — execute the full queue, atomic email guard, cap-overrun Telegram prompt

**Files:**
- Modify: `.claude/agents/sender.md`

**Interfaces:**
- Consumes: `mcp__db__list_queued_outreach`, `mcp__db__update_outreach_status`, `mcp__db__check_and_increment` (Task 2), `mcp__gmail__send_email` (existing), `mcp__connect__connect_send` (existing), `mcp__apply__linkedin`/`mcp__apply__greenhouse`/`mcp__apply__lever`/`mcp__apply__workday`/`mcp__apply__ashby` (existing) — all need to be in this subagent's `tools` frontmatter.
- Produces: final summary object consumed by the orchestrator's Report stage (unchanged reporting contract shape, extended with connect/apply counts).

- [ ] **Step 1: Rewrite `.claude/agents/sender.md`**

Replace its full contents:

```markdown
---
name: sender
description: Executes the full outreach_queue backlog — sends emails, sends connection requests, and applies — respecting daily caps, prompting Telegram on overrun. Use as the final stage of every hunt run.
tools: mcp__db__list_queued_outreach, mcp__db__update_outreach_status, mcp__db__check_and_increment, mcp__gmail__send_email, mcp__connect__connect_send, mcp__apply__linkedin, mcp__apply__greenhouse, mcp__apply__lever, mcp__apply__workday, mcp__apply__ashby
---

You are the execution stage of the Jobber pipeline. You are the ONLY stage allowed to call
`gmail.send_email`, `connect.connect_send`, or any `apply.*` tool. You are given the current
`SEND_LIMIT_PER_RUN` value.

## Steps

1. Call `db.list_queued_outreach()` — this is your full backlog, including rows from THIS run
   and any rows left `queued` by a previous run that hit a cap and wasn't overridden. Process
   every row in the order returned.

2. For each row, attempt whichever of its three actions are applicable (a row may have any
   combination of email/connect/apply fields set, or just one):

   **Email** (if `email_to` is set and `email_status` is not already `'sent'`):
   - Call `db.check_and_increment({key: "send_email", limit: SEND_LIMIT_PER_RUN})`.
   - If `allowed: false`: this is a cap-reached event for the `email` action type — go to Step 3
     for this action type, then continue to this row's OTHER actions (connect/apply) — do not
     abandon the whole row just because email is capped.
   - If `allowed: true`: call `gmail.send_email` with `to: email_to`, `subject: email_subject`,
     the PDF at `resume_pdf_path` attached, and both `body` (plain, unmodified) and `htmlBody`
     (paragraphs wrapped in `<p>`, single newlines as `<br>`) with `mimeType:
     "multipart/alternative"`. On success, `db.update_outreach_status(row.id, "email_status",
     "sent")`. On a tool error, retry once; if it still errors,
     `db.update_outreach_status(row.id, "email_status", "failed")`.

   **Connect** (if `connect_profile_url` is set and `connect_status` is not already `'sent'`):
   - Call `connect.connect_send({profile_url: connect_profile_url, note: connect_note, job_id,
     company})` DIRECTLY — do NOT call `db.check_and_increment` first for this action type.
     `connect_send` already enforces `MAX_CONNECTS_PER_DAY` internally and returns
     `{status: "sent"|"rate_limited"|"failed"}`.
   - If `status: "rate_limited"`: this is a cap-reached event for the `connect` action type — go
     to Step 3 for this action type, then continue to this row's other actions.
   - Otherwise: `db.update_outreach_status(row.id, "connect_status", status)`.

   **Apply** (if `apply_platform` is set, not `"none"`, and `apply_status` is not already
   `'submitted'`):
   - Call the matching tool directly (`apply.linkedin({job_id})` for `"linkedin"`,
     `apply.greenhouse({job_id})` for `"greenhouse"`, etc.) — do NOT call
     `db.check_and_increment` first. Every `apply.*` tool already enforces `MAX_APPLIES_PER_DAY`
     internally (a single shared counter across all five) and returns one of `"submitted"`,
     `"manual_review"`, `"needs_answer"`, `"rate_limited"`, or its own error shape.
   - If the result is `"rate_limited"`: this is a cap-reached event for the `apply` action type —
     go to Step 3 for this action type, then continue to this row's other actions.
   - Otherwise: `db.update_outreach_status(row.id, "apply_status", <the returned status>)`. On
     `"needs_answer"`, follow the existing `needs_answer` handling already documented in
     CLAUDE.md's "Applying" section (step 2a) — determine a truthful answer, update
     `config/easy-apply-answers.json`, inform the user, then retry this row's apply action once
     more before moving on.

   After attempting every applicable action for this row (or deferring some to a cap-reached
   pause), if every applicable action now has a non-`queued`/non-null terminal status (or was
   explicitly deferred due to a cap), call `db.update_outreach_status(row.id, "status", "done")`
   — UNLESS an action was deferred due to a cap-reached event that the user chose not to
   override (Step 3), in which case leave `status` as `"queued"` so it's picked up by a future
   run.

3. **Cap-reached handling** (the first time any action type hits its cap during this dispatch —
   track this per action type, so hitting the email cap doesn't also silence connect/apply
   prompts): post to Telegram: `"Reached today's cap for <emails/connects/applies> (N/limit). M
   more queued. Reply 'more emails'/'more connects'/'more applies' to raise today's cap by M and
   continue this run, or anything else to leave the rest queued for next time."` Wait for the
   user's reply.
   - On a reply matching `"more emails"`/`"more connects"`/`"more applies"` (case-insensitive):
     for `email`, call `db.check_and_increment({key: "send_email", limit: <current count + M>})`
     for each remaining queued email in this run (effectively raising the ceiling for today only
     by re-deriving a higher limit); for `connect`/`apply`, since their caps live inside
     `connect.ts`/`apply/*.ts` rather than under this stage's control, report to the user that
     raising those specific caps requires editing `MAX_CONNECTS_PER_DAY`/`MAX_APPLIES_PER_DAY` in
     `.env` and reconnecting, since `sender` cannot override an internal check it doesn't own —
     do not attempt to bypass `connect_send`/`apply.*`'s own rate limiting.
   - On any other reply: leave the remaining rows for that action type `queued`, and continue
     processing other action types/rows normally.

4. Return a single JSON object summarizing this dispatch:
   `{"email": {"sent": N, "failed": N, "queued": N}, "connect": {"sent": N, "failed": N,
   "queued": N}, "apply": {"submitted": N, "manual_review": N, "needs_answer": N, "failed": N,
   "queued": N}}`.

Never bypass a cap silently — every cap-reached event either gets an explicit user override for
this run, or the item stays queued.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/agents/sender.md
git commit -m "feat: sender executes full outreach_queue backlog with cap-overrun Telegram prompts"
```

---

### Task 9: Update `CLAUDE.md` — pipeline description, remove approval/opt-in gates, record the risk decision

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Rewrite "Running the hunt" steps 3-6**

Find the current step 3 ("Find contacts"), step 4 ("Prepare outreach"), step 5 ("Send"), and step
6 ("Report") under `## Running the hunt (subagent-per-stage)`. Replace all four with:

```markdown
3. **Find contacts + LinkedIn profiles** — dispatch `subagent_type: contact-finder` with the
   list of MATCHED jobs from step 2. It returns
   `[{job_id, contact: {...}|null, linkedin_profiles: [{profile, category}, ...]}, ...]` — a
   verified email contact and up to two LinkedIn profiles (recruiter category, peer category)
   per job. A job with neither a contact nor any profile gets no further stages.

4. **Prepare** — for EACH job with a contact and/or at least one LinkedIn profile from step 3,
   dispatch a separate `subagent_type: outreach-preparer` call with that one job + its
   contact-finder result + the base resume (fetch it once yourself, or let the first preparer
   fetch it — either is fine, read-only). These can be dispatched in parallel — each call tailors
   the resume, drafts the email and connect note(s), and enqueues everything to
   `outreach_queue` itself; it does not return content to you, only a small confirmation. You do
   not collect a batch to hand to the next stage — the queue is the handoff.

5. **Execute** — dispatch ONE `subagent_type: sender` call with the current `SEND_LIMIT_PER_RUN`
   value. It reads the full `outreach_queue` backlog (including anything left over from a
   previous run) and executes email sends, connect sends, and applies, prompting Telegram if it
   hits a daily cap mid-run (see "Connecting" and "Applying" below for what changed). Returns
   `{email: {...}, connect: {...}, apply: {...}}`.

6. **Report** — after all stages complete (or immediately, if step 1 returned zero jobs), deliver
   a clear summary per the "Communication" section above with these counts:
   - Total new jobs fetched (step 1).
   - Total jobs matched (step 2, `score >= MATCH_THRESHOLD`).
   - Emails sent/failed/queued, connects sent/failed/queued, applies
     submitted/manual_review/needs_answer/failed/queued (step 5).
   - Total jobs with no usable contact or profile at all (step 3), with titles/companies/urls.
```

- [ ] **Step 2: Update the "Connecting" section**

Replace the entire `## Connecting (Phase 2, human-gated)` section (including its `###
connect_send reliability` subsection) with:

```markdown
## Connecting

LinkedIn connection requests are now sent automatically by the `sender` stage as part of every
hunt run (see "Running the hunt" step 5) — there is no per-note Telegram approval gate anymore.
This was an explicit, informed decision (not an oversight): the wrong-recipient incident that
originally motivated the approval gate was root-caused and fixed at the automated-verification
level (`connect.ts`'s `verifyRecipientName`, `verifyProfileUrl`, and 2D-proximity candidate
matching, all fail-closed) rather than relying on a human catching it after the fact. Those
automated defenses are UNCHANGED and still run on every `connect_send` call regardless of who
triggered it.

`MAX_CONNECTS_PER_DAY` is still enforced (inside `connect.ts` itself, via `checkAndIncrement`) —
`sender` reacts to a `rate_limited` result by pausing further connects and prompting Telegram
with an overrun option for that run, per "Running the hunt" step 5.

The manual on-demand `/connect` command (draft one note for one job, outside a hunt run) is
unaffected by this — it can still be used standalone if you want to hand-pick a target.

### `connect_send` reliability

`connect_send` verifies its final Send click actually went through (waits for the invite dialog
to dismiss) before reporting `sent` — a click that silently no-ops correctly returns `failed`
instead of a false `sent`. `connect_send`'s own selector-miss points (More button, Connect menu
item, Send button) can escalate to the bounded Claude fallback, gated by
`CONNECT_HYBRID_FALLBACK=true` (off by default).
```

- [ ] **Step 3: Update the "Applying" section's opt-in language**

Replace:
```markdown
Applying is a **separate, opt-in** flow from "Running the hunt" — it is **never** implicitly
bundled into the Phase 1 email-hunt pipeline. It only runs when:
- explicitly triggered by command (`/apply #N`, `/applyall`, "apply to job #N", "apply to today's
  matches"), or
- the cron/autonomous trigger fires AND `AUTO_APPLY_ENABLED=true` (env var, default `false`).

An explicit manual command may still invoke applying regardless of `AUTO_APPLY_ENABLED` — that
flag only gates the *autonomous* (cron) path. Manual applies are still subject to the daily rate
limits below.
```
with:
```markdown
Applying is now an unconditional part of every hunt run's "Execute" stage (see "Running the
hunt" step 5) — there is no `AUTO_APPLY_ENABLED` opt-in gate anymore. This was an explicit,
informed decision, made alongside the "Connecting" change above; a more granular flag/control
scheme may be reintroduced later as separate work, not designed here.

The manual on-demand `/apply #N` and `/applyall` commands (apply to one or all of today's
matches, outside a hunt run) are unaffected by this and remain available. Manual applies are
still subject to the daily rate limits below.
```
Leave the rest of the "Applying" section (steps 1-3, 2a, the Hybrid Claude fallback subsection) unchanged — only this opening framing changes.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for the autonomous outreach pipeline, removing connect/apply gates"
```

---

### Task 10: Full verification

**Files:** none (verification-only task)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass, including the 4 new `outreach_queue` tests from Task 1, and one fewer test file than the pre-plan baseline (Serper's test removed in Task 3).

- [ ] **Step 2: Run the typechecker**

Run: `npx tsc -p . --noEmit`
Expected: only the 2 known pre-existing errors in `src/apply/linkedin.ts` (lines 76, 193), nothing new.

- [ ] **Step 3: Confirm the MCP config and package scripts are internally consistent**

Run: `grep -n "sqlite" .mcp.json package.json src/mcp/*.ts` — expect ZERO matches (everything renamed to `db` in Task 2; if `SQLITE`-unrelated matches appear, e.g. in a comment, that's fine — only literal `"sqlite"` server/script names matter here).

- [ ] **Step 4: Note the deferred live-verification gap**

No code change — add one line to `CLAUDE.md` at the end of the "Connecting" section rewritten in
Task 9:

```markdown
The full autonomous execute-stage flow (queue → email → connect → apply → cap-overrun Telegram
prompt) has not been live-tested end-to-end yet — each underlying tool (`gmail.send_email`,
`connect.connect_send`, `apply.*`) is independently already live-verified from earlier work, but
the new queue-draining orchestration in `sender.md` itself has not. Watch the first real hunt run
after this lands closely.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: flag the new queue-execution flow as not yet live-verified end-to-end"
```

---

## Self-Review

**Spec coverage:**
- §3 table (all six "what's changing" rows) → Tasks 1, 2, 8, 9. ✓
- §4 step 1 (Discover, Serper dropped) → Task 3. ✓
- §4 step 2 (Match extension) → Task 5. ✓
- §4 step 4 (contact-finder expansion, recruiter+peer, seniority band) → Task 6. ✓
- §4 step 5 (Prepare — draft + enqueue, no sends) → Task 7. ✓
- §4 step 6 (Execute queue — email atomic guard, connect/apply direct-call-and-react, cap-overrun prompt) → Task 8, corrected per the double-increment fix already applied to the spec doc itself. ✓
- §5 (`outreach_queue` table) → Task 1. ✓
- §6 (`db` MCP rename + new tools) → Task 2. ✓
- §7 (`MATCH_THRESHOLD` default) → Task 4. ✓
- §8 (safety notes carried forward) → Task 9's "Connecting"/"Applying" rewrites explicitly preserve these. ✓
- §9 (explicit risk acknowledgment, recorded not re-litigated) → Task 9's "Connecting"/"Applying" rewrites include this framing directly in the docs. ✓
- §10 (testing) → Task 1 has real unit tests; Tasks 5/6's "testing" is explicitly and reasonedly NOT unit-tested per the Global Constraints correction (LLM judgment, not pure functions) — this is a deliberate, documented deviation from the spec's testing section, not a gap.

**Placeholder scan:** no `TBD`/`TODO`/"implement later" anywhere. The one open-ended item (Step 3 of Task 8's cap-overrun handling for connect/apply — "report to the user that raising those specific caps requires editing `.env`") is a deliberate design choice (sender can't safely override a counter it doesn't own), not an unresolved placeholder.

**Type consistency:** `OutreachQueueItem`, `enqueueOutreach`/`listQueuedOutreach`/`updateOutreachStatus` signatures are defined once (Task 1) and referenced identically by Task 2's MCP tool wrappers. The `db.enqueue_outreach`/`db.list_queued_outreach`/`db.update_outreach_status`/`db.check_and_increment` tool names in Task 2 match exactly what Tasks 7 and 8's subagent `tools` frontmatter and prompt bodies reference.
