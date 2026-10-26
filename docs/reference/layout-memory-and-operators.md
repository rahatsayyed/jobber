<!-- Moved verbatim from CLAUDE.md; the rules in CLAUDE.md "Safety" and "Commands" still apply. -->

## Layout memory and platform operators

Plan 8B. Code, not the model, remembers what the LinkedIn, Naukri and Wellfound pages looked like, as
**telemetry**: the operators can see what the pages looked like, but since the browserctl rebuild a
drifted layout never stops anything (see "Drift handling").

**Layout memory** (`src/layout/*`). One JSON file per platform at `.jobber/layout/<platform>.json`
(git-ignored; `LAYOUT_DIR` must resolve inside the project, else the default is used; a file
over `LAYOUT_MAX_BYTES` is not grown). It holds only ids from the closed vocabulary in
`src/layout/vocab.ts` (page kinds, landmark ids, count keys, action labels): page text can never
reach it, and nothing in it is model-written. The observer is advisory: the browserctl engine feeds it every snapshot (and the data tools feed it
their parsed reads); it records and never blocks a read or an action. Variants are promoted after
`LAYOUT_PROMOTE_N` observations over `LAYOUT_PROMOTE_RUNS` distinct run ids. A run id is the
process or run id (`JOBBER_RUN_ID`, else `SCHEDULER_RUN_ID`, else per process). Promoted variants
are never auto-evicted: a third distinct layout needs `npm run layout -- reset`
(`variant_replaced` is effectively dormant).

**Reading `layout=`**: `linkedin_open`/`linkedin_snapshot` and the Naukri and Wellfound snapshot headers carry
`layout=<match|partial|drift|unknown|blocked|logged_out|unloaded>`. `match`: known layout. `partial`: some landmarks missing, re-snapshot before relying on a ref. `drift`:
a learned landmark is gone (adapt, do not stop). `unknown`: kind or variant not learned yet. `blocked`, `logged_out`:
not layout problems (halt and login rules win). `unloaded`: page not fully loaded, retry.
Read-only tools `linkedin_layout`, `naukri_layout` and `wellfound_layout` return the enforce mode, the last verdict
and the compact memory.

**No enforcement on sends.** The LinkedIn, Naukri and Wellfound action tools no longer have a landmark
precondition: the old `layout_drift` and `layout_unverified` refusals of `linkedin_connect_send`,
`linkedin_send_message`, `linkedin_accept_invite` and `naukri_send_message` are gone with those tools,
and the send safety now comes from the arm tool, the semantic guard and the live re-verification (see
"Connecting"). `TOOL_REQUIRES` (`src/layout/vocab.ts`) now scopes only the data tools
(`linkedin_find_profiles`, `linkedin_search_jobs`, `linkedin_search_posts`), where `LAYOUT_ENFORCE=enforce`
can still refuse an unverified read page. `LAYOUT_ENFORCE=warn` (default) only adds a `layout=` note;
`off` disables it. The ATS applier's own enforce behaviour is described under "Applying".

**Drift handling.** Drift is telemetry only for LinkedIn, Naukri and Wellfound. `LAYOUT_DRIFT_ESCALATE_N` drift
observations within `LAYOUT_DRIFT_WINDOW_HOURS` still write an owner info escalation, but there is no
`layout_drift` halt for these platforms any more: operators adapt (snapshot, scroll, screenshot,
pointer, escalate, see "Connecting"). The halts that remain are the real ones: a block page, CAPTCHA,
checkpoint or restriction page halts the platform, consecutive Naukri send failures halt Naukri (three
unconfirmed or failed Wellfound sends halt Wellfound the same way), and
`.jobber/STOP` and `halt_flags` still win. `npm run layout -- clear-halt <platform>` remains for any
old `layout_drift:*` row and for the ATS `ats_<id>` files. A LinkedIn `profile` URL whose snapshot has
no extracted profile name ("profile unavailable") is `unloaded`, never drift and never learned.
`LAYOUT_*` is in the `outreach_wake` env allowlist (`env_prefixes` in `config/run-profiles.json`), so
the MCP servers of a wake see it; `npm run status -- layout`, the layout CLI and the doctor read
`LAYOUT_*` from `.env` through one helper (`src/layout/config.ts` `loadLayoutEnv`, nothing else is read).

| Variable | Default | Meaning |
|---|---|---|
| `LAYOUT_ENFORCE` | `warn` | `off`, `warn` or `enforce` (data tools and ATS pages only) |
| `LAYOUT_PROMOTE_N` | `3` | observations before a variant is promoted |
| `LAYOUT_PROMOTE_RUNS` | `2` | distinct run ids needed for promotion |
| `LAYOUT_MATCH_MIN` | `0.9` | landmark score for `match` |
| `LAYOUT_PARTIAL_MIN` | `0.6` | landmark score for `partial` (must be <= match min) |
| `LAYOUT_STALE_DAYS` | `30` | days before a kind counts as stale |
| `LAYOUT_DRIFT_ESCALATE_N` | `3` | drift streak that escalates |
| `LAYOUT_DRIFT_HALT_N` | `5` | drift streak that halts (needs 2 run ids) |
| `LAYOUT_DRIFT_WINDOW_HOURS` | `24` | window for the streak |
| `LAYOUT_MAX_BYTES` | `65536` | file size cap (floor 4096) |
| `LAYOUT_RENDER_MAX_CHARS` | `1200` | cap on the memory text given to an operator |
| `LAYOUT_UNLOADED_MAX_CHARS` | `80` | a page shorter than this is `unloaded` |
| `LAYOUT_EXPLORE_BUDGET` | `6` | parsed and range-checked (0..100) only; prompt-only, the operators' prompts state 6 and it is not enforced or injected |
| `LAYOUT_DIR` | `.jobber/layout` | store directory, inside the project only |

Invalid values fall back to the default and never throw.

**Operators.** `linkedin-operator`, `naukri-operator` (which replaced the four old workers
`due-followups`, `new-outreach`, `inbox-recruiter-replies` and `naukri-search`) and `wellfound-operator`
are the platform operators with layout memory. The wake session dispatches operators with one Agent call each, in the
order of the wake prompt (see "Running a wake"). A platform operator gets a list of tasks with a
`kind` and `quota`: `manual_url` (owner-submitted job pages, run first, quota = pages), `inbox`,
`followups`, `new_outreach`, `discover` (named LinkedIn job and post
searches, or the Naukri or Wellfound searches; the quota is the number of searches or, for Naukri and
Wellfound, the job pages it may open for descriptions) and `search` (Naukri only; it returns counts
only). The `wellfound-operator` has only `manual_url`, `inbox` and `discover`. Every platform operator
starts with its layout tool (telemetry) and then follows snapshot-first, arm-then-commit and the
failure ladder; a refusal from an arm or commit step is final for that item. The browser applier also observes ATS pages under per-platform `ats_<id>` layout files (see
"Applying"). Tool lists: `config/worker-tools.json`.

**Owner CLI.** `npm run layout -- status|show <platform>|reset <platform> [--kind <id>]|clear-halt
<platform>|learn <platform>` (offline; `reset` moves the file or one kind aside to
`*.reset-<time>`; `clear-halt` clears only a `layout_drift` halt). `npm run status -- layout`
prints the summary. `npm run doctor` checks `layout_store`, `layout_age`, `layout_drift` and
`layout_enforce`. The dashboard chat box still accepts only `limits`, `working` and `health`.

**Supervised learning run (owner-only; NOT performed in this build; now only informs telemetry).**
1. Fully restart Claude Code (new agents, new MCP tool names, removed workers); check
   `git check-ignore .jobber/layout/linkedin.json`.
2. Dry-run flag (`JOBBER_DRY_RUN=true`) and `LAYOUT_ENFORCE=warn`.
   Trigger two scheduler wakes (two run ids) while logged in, covering a profile, a search page,
   and for Naukri a search and a chatbot or thread page.
3. `npm run layout -- status`: each visited kind should be `stable`; `learn <platform>` shows
   missing observations or runs.
4. `npm run layout -- show linkedin` and check only vocabulary ids appear; expect to tune
   `MIN_SET` and `CRITICAL` in `src/layout/vocab.ts` (a code change).
5. `LAYOUT_ENFORCE=enforce` now only affects the data tools and ATS pages; set it only after a clean
   week of `warn` with no drift on critical kinds and doctor `layout_enforce` ready.
6. On an old `layout_drift:*` halt: look at the page in a headed session, `reset <platform> --kind <id>`
   if the layout really changed, `clear-halt <platform>`, then relearn.

**Known limits.** Real pages are unverified: landmark rules come from the parsed snapshot shape,
so `MIN_SET`/`CRITICAL` need tuning after the first live observation, and the browserctl snapshot
walker (generic, role and name based) has not been run against real LinkedIn or Naukri. `chat.input` rests on the
unverified Naukri `chatbot_Drawer` selector. The memory detects the code's view of the page, not
the DOM: a change the extractors parse identically is invisible. LinkedIn structure counts are a
coarse extra signal, and `shell` is a proxy. Naukri's Akamai blocks are sensitive: observation adds
no navigation and no probe pages exist; do not add any without re-running the 2026-10-13 headless
check. Auto-promotion can learn a bad steady state (use `reset`). Halts need the owner to clear.
