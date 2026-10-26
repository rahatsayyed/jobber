<!-- Moved verbatim from CLAUDE.md; the rules in CLAUDE.md "Safety" and "Commands" still apply. -->

## Resume tailoring rules

Resume tailoring (schema preservation, no fabrication, keyword mirroring, a hard one-page limit
with the fill ratio reported as advisory only (about 0.70-0.85 is fine; there is no fill target
and no restore pass), and a mandatory humanizer pass with no em dashes) is fully specified in the
`tailor-resume` skill (`.claude/skills/tailor-resume/SKILL.md`) — that skill is the single
source of truth. Any flow that needs a tailored resume (the pipeline's `outreach-preparer`
stage, or an ad hoc single-job request) should invoke that skill rather than re-deriving these
rules inline, so a future change only needs to happen in one place.

What the code enforces around that skill (resume MCP: `get_base_resume`, `render_resume`,
`check_text`, `apply_review_edits`):

- `resume.render_resume` runs fact gate v2 (`checkResume`, `src/resumeFacts.ts`,
  `src/factClaims.ts`, `src/proseClaims.ts`): the v1 checks plus noun-bound counts, prose
  tools/employers/titles, delegated authorship, scope/lead/years/tool-context checks, and the
  `user-data/fact-gate.json` allow-lists and phrases. It also blocks any `projects[]` title or
  `certificates[]` name not in the base (`project:<title>`, `certificate:<name>`) and any
  `skills[].category` using words outside the base's category names and skill items
  (`skill-category:<name>`). It makes text ATS-safe FIRST (`src/atsText.ts`: ASCII dashes and
  quotes, and every invisible Unicode format character such as zero-width spaces and soft
  hyphens stripped), then gates and renders that same copy, auto-trims the lowest-relevance
  bullets on page overflow (`trimResume`), and classifies the passed `keywords` as covered /
  synonym_only / missing_have_it / skills_only / gap (`src/atsKeywords.ts`).
- The normalizer also strips non-Cf invisibles (U+034F, Hangul fillers, U+2800, U+180E, U+17B4/5, variation selectors), and the gate blocks `mixed-script:<word>` (a word mixing Latin with Cyrillic, Greek, Han, Arabic, etc.; the homoglyph bypass) in resume text and outreach; `job_title`/`company` are normalized before posting-context blanking.
- `resume.check_text` normalizes the text the same way, runs the same gate on that normalized
  text (`checkOutreachText`) and returns it as `normalized_text`; the preparer enqueues exactly
  that text (email subject/body, connect notes), never the pre-gate draft.
- `resume.apply_review_edits` normalizes the resume, email and edits first, applies the
  reviewer's exact-quote edits (`src/reviewEdits.ts`) and rejects any edit that adds a claim.
- `job_description` on all three tools is clamped to 20000 characters in code (a longer posting
  is truncated, not rejected).
- Every rendered PDF now has ASCII dashes and quotes, ` - ` between dates and `: ` after the
  skills label (typography normalization plus a template edit; reversible with `git revert`).
- Node.js, and any other item that is only in the Skills list, is `skills_only`: it never counts
  toward ATS coverage, and `tailor-resume` never writes it into a bullet or the summary. If the
  user has real Node.js work to claim, they add it to `user-data/resume.json` (the agent never edits
  that file); the gate and classifier pick it up on the next render. Open user decision.
- `user-data/fact-gate.json`: `allow_facts` / `allow_metrics` are the escape hatch for facts the
  gate wrongly blocks; `forbidden_phrases` block, `warn_phrases` warn. Only add an allow entry
  for a fact the user confirmed, and add that fact to `user-data/resume.json` first.

Known limits: the gate is a lexical floor and cannot catch paraphrased inflation, spelled-out or
vague counts ("two products"), a number moved to different work, or "3+ years" bound to a narrower
stack than the base binds it to (the judge flags these; the gate does not). Last measured
tailoring result (pre-fix prompt, judge run a, sonnet): NEW vs baseline A truthfulness 4.50 vs
4.38, jobFit 3.75 vs 2.88, send 7/8 vs 4/8, 100% pass the gate, 100% one page, 4.1 base bullets
dropped per resume. ATS keyword coverage missed its target (29.5% vs 34%, because cutting
irrelevant bullets also cuts some posting keywords). The run-b judge only finished 4 of 8 jobs
(judge JSON parse failures), so no two-run mean exists, and the rewritten DO examples have not
been re-evaluated.

### Eval harness

`scripts/eval/` (see its README): `npm run eval:gen` (generate tailored resumes for the frozen
fixtures in `scripts/eval/fixtures/`), `npm run eval:metrics` (gate pass rate, page count, bullets
dropped, fill ratio, keyword coverage), `npm run eval:judge -- scripts/eval/runs/<date> --compare
A,C --model sonnet` (blind LLM judge, NEW vs the 2026-10-07 baselines). Gen and judge run long
(sequential `claude -p` calls), so start them in the background. The judge rubric
(`judge-rubric.md`) is a reconstruction of the original, so compare systems only WITHIN one judge
run, never against the old baseline averages (truthfulness A 4.25 / B 4.00 / C 3.25, jobFit 3.38 /
3.00 / 4.00); single samples differ by ~0.3 as noise. Acceptance thresholds used: jobFit >= 3.75
and >= baseline A + 0.25, truthfulness >= 4.0 and no regression, 100% not blocked by the gate,
>= 88% exactly one page, >= 1.5 base bullets dropped, keyword coverage >= 34%. What it measures:
`eval:gen` (`scripts/eval/generate.ts`) runs `tailor-resume` single-shot only. Nothing in the eval
exercises `review-application`, `apply_review_edits`, `draft-outreach` or `check_text` through an
LLM (the gate is applied to the generated resumes by `eval:metrics`, in code). Rerun after any
change to `tailor-resume` or the fact gate; a change to the review step or the outreach drafting
is not measured by it.

### After merge: user checklist

0. First-time machine setup (install, `npm run setup`, doctor, sessions, permission set,
   classifier, dashboard) is `docs/00-start-here.md`; the platform and scheduler owner
   checklists are in the 6B, 6B2, 6D and 7D plans and `docs/backup-and-restore.md`. The items
   below are the older, still-true ones. Start with `bash scripts/bootstrap.sh`, then see
   "Bring-up commands" under "Platform and sessions".
1. FULLY quit and restart Claude Code (not a selective MCP reconnect) after any change to an MCP
   server, `src/db.ts`, the agents or the skills. Every stdio MCP server in `.mcp.json` (`job-fetch`,
   `resume`, `contacts`, `gmail`, `gates`, `db`, `applier`, `naukri`, `linkedin`, `scout`, `outreach`) loads the shared code, and a restart also reloads `CLAUDE.md`, the
   agents and the skills.
2. Review `user-data/languages.json`: add the languages you really speak and set `"confirmed":
   true`. Until then the language gate only flags, it never excludes.
3. Rerun the eval to measure the rewritten DO examples: `npm run eval:gen`, then
   `npm run eval:metrics`, then `npm run eval:judge -- scripts/eval/runs/<date> --compare A,C
   --model sonnet` (always pass `--model` explicitly). Start gen and judge in the background.
4. After steps 1 and 2, run one supervised `/runhunt` (one forced wake; keep the dry-run flags until you have read `npm run dry-run:report`) and read the first outputs yourself (resumes, emails, the
   per-job ATS coverage and gap lines), since the gate cannot catch paraphrased inflation. That
   run is the first-ever LLM execution of review-application -> apply_review_edits -> re-render
   -> check_text: none of it has run end to end with a real model before, so watch it closely.
5. Decide whether to add a real Node.js work fact to `user-data/resume.json`.
6. Plan 3 (replies and follow-ups): back up `data.sqlite` first; the same full restart loads
   `reply-watcher`, `followup-drafter`, `mail-operator` and the new `db` tools; then run the
   dry runs in docs/superpowers/plans/2026-10-08-3-post-send-replies-followups-funnel.md (U3-U7).
7. Plan 4 (board discovery): run the live slug check (four commands in the plan) from a shell
   with network, then the same full restart; `source_status` is read-only and never fetches (it returns the last recorded run, or `ran: false`; `board_status` is the board-only alias).
8. Plan 5 (board breadth): run the live probes at the end of
   docs/superpowers/plans/2026-10-13-5-board-breadth.md, enable only the tenants and aggregators that
   returned jobs, then the same full restart (the `job-fetch`, `db`, `gates` and `applier` servers load new code).
9. Gulf targeting (plan 5): decide the target countries (default all six GCC countries; edit `config/target-regions.json` and the Gulf terms in `config/portals.json`), confirm `user-data/languages.json` (add Arabic only if you really speak it, then `"confirmed": true`), decide whether you need relocation or visa sponsorship (the `no sponsorship` deal-breaker in `config/deal-breakers.json` excludes Gulf postings that ask for an existing work permit), add Gulf `jobs[]` entries to `config/linkedin-discovery.json`, and review the Preferences text.
   Check the Himalayas and We Work Remotely attribution and terms before enabling them. Hacker News
   outreach no longer needs a manual review: the automated domain check (see Preferences, "Target
   companies") holds back a job whose resolved company domain does not appear in the posting.
10. Sources and operators (plan 8G): after a wake run `npm run status -- sources`. Enable an imported
    career-ops feed only after you reviewed its terms of use and robots.txt: set `enabled: true` on its
    row in `config/platforms.json`, one at a time. Review generated providers with
    `npm run providers -- list` and `show <id>` before any `approve <id>`.
11. Browser apply (plan 8G): follow the owner live checks in `docs/apply.md`. Keep `JOBBER_DRY_RUN`
    `true` and `APPLY_SUBMIT_MODE=hold` until a supervised check, and
    keep `APPLY_ALLOW_ACCOUNT_CREATION`, `SCOUT_ALLOW_SIGNUP`, `APPLY_ALLOW_UNKNOWN_HOSTS` and
    `APPLY_LINKEDIN_EASY` off until you decide otherwise.
12. Sessions: run `npm run linkedin:login` and `npm run naukri:login` (neither takes a flag), then
    `npm run doctor`.
13. Browserctl rebuild (LinkedIn, Naukri, scout; all live-unverified): (a) fully quit and restart every
    Claude window (new MCP tool names, rewritten operator agents); (b) re-apply the permission set
    (`npm run permissions -- outreach_send`, or the set you currently use) and check
    `npm run permissions -- --status`; (c) `LINKEDIN_SCREENSHOT`, `NAUKRI_SCREENSHOT` and
    `SCOUT_SCREENSHOT` are on by default (screenshots and the pointer fallback; the pixels are
    unscreened): set one to `false` in `.env` to disable it; (d) supervised live structure checks in dry run: `linkedin_open` and
    `linkedin_snapshot` on a profile, a search page and the messaging page, the same for Naukri (a job
    page and a thread), and a scout read of one custom site, confirming the snapshot shows the
    Connect, Message, Send and Apply controls with sensible names; (e) the first supervised canary
    (one hand-picked profile, low ceilings, `JOBBER_DRY_RUN=false` only for that session) before any
    unattended wake, reading the `dry_run_actions` report first.
14. Wellfound, manual requests and the mail drip lane: (a) fully restart every Claude window and the scheduler
    daemon (new `wellfound` MCP, new agents, the `mail_drip` profile, the drip lane starts with the daemon) and
    re-apply the permission set (`npm run permissions -- outreach_send`); (b) `npm run wellfound:login`, then
    `npm run doctor` (`wellfound-session`); until that file exists no Wellfound operator is planned; (c) supervised
    dry-run checks of `wellfound_open` and `wellfound_snapshot` on a search page, a job page and a thread, and of
    one `wellfound_discover` search, before trusting any selector, URL shape or promoted marker; (d) the same for
    `linkedin_manual_job`, `naukri_manual_job` and `wellfound_manual_job` with one real job page each, and
    `npm run apply:request -- <url>` with the kill switch off and `JOBBER_DRY_RUN=true`; allow
    `Bash(npm run apply:request:*)` in the `hunt` window if `/apply <url>` should run there; (e) review the
    `EMAIL_*` drip keys (the shipped window is 09:30 to 19:00 IST, batches of 2 to 3, 5 to 8 minutes between
    ticks, no daily cap) and decide on `EMAIL_MAX_PER_DAY` BEFORE the first live day, because
    `SEND_LIMIT_PER_RUN` no longer limits the drip; check `npm run status -- limits` after the first day;
    (f) run `npx tsx scripts/fix-linkedin-posts.ts --dry` once, then without `--dry`, to retire old hiring-post rows
    stored with a profile url and no company.

Board discovery known limits: the Greenhouse/Lever/Ashby response shapes are not live-verified
inside a wake yet (only the seeded slugs were checked while writing). The Workable, Recruitee,
Personio, SmartRecruiters, Workday, Hacker News, Himalayas and We Work Remotely providers (plan 5) and the
18 imported career-ops feeds (plan 8G) are
unit-tested against fixtures read from career-ops code only and are live-unverified (see the plan's
"Unverified assumptions"). Not built: Recruitee apply support, BambooHR, Breezy, Teamtailor, Getro,
and the Indian and Gulf job boards.
