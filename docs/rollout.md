# Rollout: five phases from dry run to autonomous

Audience: owner
Last verified against: 37942b4
Source files: CLAUDE.md, src/safety/dryRun.ts, src/stack/mode.ts, src/verify/cli.ts, scripts/dry-run.ts, scripts/stack.ts, scripts/jobber-control.ts, scripts/status.ts, scripts/layout.ts, scripts/linkedin-seed-person.ts, scripts/scheduler.ts, .env.example, docs/superpowers/plans/2026-10-14-6d-scheduler-agents-naukri.md, docs/superpowers/plans/2026-10-15-8a-wiring-and-legacy-removal.md, docs/backup-and-restore.md, src/webcore/hostCaps.ts, src/sources/runner.ts

Each phase is gated on the one before. Do not skip ahead. Steps marked `[owner]` can only
be done by you (a login, a key, a flag flip). No agent flips a dry-run flag, clears a halt or
sets a permission set for you.

Nothing in the platform and outreach work has run against real LinkedIn, Naukri, a downloaded
classifier model, real tmux/ccgram wiring or a real backup. Every live-facing item below is
`unverified` until you run it; the rollout is how you verify it. See "Known limits and not yet
live-verified" in `CLAUDE.md`.

## How to read the mode

Dry run wins. Any dry flag on, or a flag unset, means actions are recorded in
`dry_run_actions` and not performed (`src/safety/dryRun.ts`). Live needs
`SCHEDULER_DRY_RUN=false`, and for LinkedIn paths also `LINKEDIN_DRY_RUN=false`. The
email path also honours the Gmail dry flag, JOBBER_DRY_RUN (see `CLAUDE.md` Safety rule 15; it is not listed in `.env.example`).

```bash
npm run up -- --status
```

Prints the current mode as `MODE: DRY RUN (nothing is sent)` or `MODE: LIVE (real email,
LinkedIn and Naukri actions, within caps)` plus the three flag values. It is read-only and
changes nothing.

Three commands you use in every phase:

```bash
npm run status -- health
npm run status -- limits
npm run dry-run:report
```

`health` shows platform and pipeline health, `limits` shows usage against the ceilings, and
the report lists recorded dry actions. Read them at the end of every time box.

## Kill switch test (before every phase that sends or reads live)

```bash
npm run jobber:control -- stop rollout test
npm run jobber:control -- status
npm run jobber:control -- resume
```

Expected: stop writes the STOP file and halts `all`, `linkedin` and `naukri`; status shows
it; resume removes the STOP file and clears only halts that carry the stop prefix.
`[owner]` Hook propagation of the kill switch into subagents in real `claude` is unverified:
test it once per `CLAUDE.md` and the 8A owner checklist (start a session, stop, ask it to send,
expect a "kill switch" denial; with STOP set `./run-hunt.sh` must report a skipped wake with
reason `killed`, and the launcher itself exits 4).

## Phase 1: Mac, dry run

**Entry**
- `[owner]` `npm run setup` finished and `npm run doctor` has no `fail`.
- `[owner]` Kill switch tested (section above).
- `data.sqlite` backed up outside the repo.

**Flags (names only)**
- `SCHEDULER_DRY_RUN` set to anything other than `false`, `LINKEDIN_DRY_RUN` the same.
- `LAYOUT_ENFORCE` left at `warn`.
- Keep the permission set at `read_only` (`npm run permissions -- --status`).

**Commands**

```bash
npm run dry-run
npm run up
```

`dry-run` runs the hermetic end to end smoke on fixtures and a temporary database and prints
the banner `DRY RUN VERIFY: nothing is sent, applied or connected; temp database; your .env is
not changed`. `up` runs the doctor gate, refuses with exit 4 under the kill switch, then starts
bridge, windows, scheduler and dashboard, and prints `MODE: DRY RUN`. If it prints
`MODE: LIVE` stop and fix `.env` before anything else.

Then let the scheduler wake on its own (see the operations doc, docs/operations.md). Look at the plan without
launching: `npm run scheduler -- --dry-run-plan`.

**Time box:** 48 hours (estimate, not measured), covering at least one night (quiet hours skip
wakes; you want to see them skipped).

**Exit criteria (observable)**
- `npm run dry-run` ends with no failed stage.
- `npm run dry-run:report` shows only action kinds you expect, with zero unexpected kinds.
- Wakes in `npm run scheduler -- --status` show skip reasons `quiet_hours` at night and no
  repeated `halted`.
- No halt appeared in `npm run status -- health`.
- Kill switch tested before the box started.

**Stop and go back if** a real email, connect or apply appears anywhere (check Gmail sent and
LinkedIn activity), or the mode line ever reads `LIVE`.

## Phase 2: Mac, read-only live

Real sessions for reads; sends stay dry.

**Entry**
- Phase 1 exit criteria met.
- `[owner]` Classifier downloaded, pinned and fitted, per `docs/classifier-models.md`:
  `npm run models -- fetch <id>`, `npm run models -- pin <id>`, `npm run classifier:fit --
  --profile <id>`, the CLASSIFIER_MODEL key set in `.env`, and `npm run doctor` shows
  `classifier_wired` ok. Until then live reads fail closed by design.
- `[owner]` LinkedIn main session saved (`npm run linkedin:login`) and Naukri session saved
  (see `docs/linkedin-sessions-setup.md`, `docs/naukri-session-setup.md`).
- `[owner]` Claude Code and the ccgram windows fully restarted after any code change.

**Flags (names only)**
- Dry flags stay on: `SCHEDULER_DRY_RUN`, `LINKEDIN_DRY_RUN`, `WEB_DRY_RUN`, `APPLY_DRY_RUN`, `SCOUT_DRY_RUN`.
- NAUKRI_HEADLESS per `CLAUDE.md` Naukri section (the headless recipe passed from a home IP
  only).
- `LAYOUT_ENFORCE` still `warn`.

**Commands**

```bash
npm run doctor
npm run status -- working
npm run layout -- status
```

Expected: doctor has no `fail`, `working` shows queue, halts and funnel, `layout` shows what
each platform has observed so far.

Try one supervised canary read-only pass: a supervised forced wake (`./run-hunt.sh`, the
`/runhunt` shim) with `LINKEDIN_DRY_RUN` on, then read the first resumes, emails and ATS coverage lines yourself.
The review step (`review-application` to `resume.apply_review_edits`) has never run end to end
with a real model: `unverified`.

**Time box:** 48 hours (estimate, not measured) of wakes with real reads, covering a night.

**Exit criteria**
- Doctor `classifier_wired` ok and no `classifier_unavailable` or `injection_suspected` flood in
  the reports.
- `npm run dry-run:report` shows sends recorded as dry, never performed.
- No `checkpoint`, CAPTCHA or restriction halt on LinkedIn, no Naukri halt.
- You read at least one tailored resume and one drafted email and accepted them.

**Stop and go back to Phase 1 if** a halt appears, the classifier errors, or a read returns
`session_locked` repeatedly (two processes collided; see `CLAUDE.md` Safety rule 6).

## Between phases 2 and 3: layout supervised learning run

`[owner]` Layout memory is learned from real pages. This is the supervised run described in
`CLAUDE.md` "Layout memory and platform operators" (the 8B build did not perform it).

1. Fully restart Claude Code. Check the store is ignored: `git check-ignore .jobber/layout/linkedin.json`.
2. Keep `LINKEDIN_DRY_RUN`, `SCHEDULER_DRY_RUN` on and `LAYOUT_ENFORCE=warn`.
3. Trigger two scheduler wakes (two distinct run ids) while logged in, covering a LinkedIn
   profile and search page and, for Naukri, a search page and a chatbot or thread page.
4. Check progress.

```bash
npm run layout -- status
npm run layout -- learn linkedin
npm run layout -- show linkedin
```

Expected: each visited kind is `stable`; `learn` lists missing observations or runs; `show`
holds only vocabulary ids (no page text). Expect to tune the minimum-set and critical landmark tables in
`src/layout/vocab.ts` after the first live look (a code change).

5. Set `LAYOUT_ENFORCE=enforce` only after a clean week of `warn` with no drift on critical
   kinds and doctor `layout_enforce` ready. Landmark rules and the Naukri `chat.input`
   selector are `unverified` against real pages.

**Exit criteria:** the kinds the operators use are `stable`, no `layout_drift` halt, doctor
`layout_store`, `layout_age` and `layout_drift` are ok.

**On a `layout_drift:*` halt:** look at the page in a headed session, `npm run layout --
reset <platform> --kind <id>` if the layout really changed, `npm run layout -- clear-halt
<platform>`, then relearn. Only you clear it.

## Between phases 2 and 3: sources, discover tasks and browser apply

`[owner]` Everything below is `unverified` against real sites: it is covered by unit tests with
fakes only. Keep every apply and web flag dry until the step that says otherwise.

1. Sources: run a wake with the dry flags on, then `npm run status -- sources`. Enable an imported
   feed only after you read the site's terms of use and robots.txt, one at a time
   ([sources-and-platforms.md](sources-and-platforms.md)). Force one failure (unset
   `ADZUNA_APP_KEY` on a copy of `.env`) and confirm the table shows an error row.
2. LinkedIn discover: with the classifier fitted, one supervised wake with `LINKEDIN_DRY_RUN` set to
   exactly `false`; confirm new jobs from the `linkedin-jobs` and `linkedin-posts` sources, no
   checkpoint halt, and `layout=` verdicts learned (the layout learning run above covers the new page
   kinds).
3. Fallback and providers: break one board slug on a copy of `config/portals.json`; confirm a queued
   source task, the `source-operator` fallback in the next wake, and (if it authors one) a generated
   provider that reaches `validated`. Review it with `npm run providers -- show <id>` before any
   `approve`.
4. Browser apply: follow the owner live checks in [apply.md](apply.md) in order (hold mode on
   Greenhouse, Lever and Ashby, then one submit, then account walls and blocks). Flip `WEB_DRY_RUN`,
   `APPLY_DRY_RUN` and `SCOUT_DRY_RUN` to exactly `false` one at a time, and `APPLY_SUBMIT_MODE` to
   `submit` last.
5. Search: confirm browser dork results for five companies; force a block and confirm the fall back to
   Serper under its budget; `npm run doctor` shows usage.

**Exit criteria:** each step above matched what you saw on the real site, nothing was sent or
submitted that you did not choose, and `npm run dry-run:report` lists only expected action kinds.

## Phase 3: Mac, canary sends

Real sends under temporary low ceilings, supervised.

**Entry**
- Phase 2 exit criteria and the layout learning run met.
- `[owner]` Permission set moved to `outreach_send` on purpose:
  `npm run permissions -- outreach_send`. Check with `--status`.
- `[owner]` Low ceilings set in `.env` for this phase: `SEND_LIMIT_PER_RUN`,
  `MAX_APPLIES_PER_DAY`, `LINKEDIN_MAX_INVITES_PER_WEEK`, `LINKEDIN_MAX_MESSAGES_PER_WEEK`,
  `NAUKRI_MAX_MESSAGES_PER_DAY`. Defaults and ranges: `src/setup/limitsCatalog.ts`; current
  usage: `npm run status -- limits`.
- Gmail OAuth done (`docs/gmail-mcp-setup.md`). Sending rules: see `CLAUDE.md` "Safety".

**Flags (names only)**
- `[owner]` `SCHEDULER_DRY_RUN` set to exactly `false`. Set `LINKEDIN_DRY_RUN` to exactly
  `false` only when you are ready for a LinkedIn canary. One flag at a time.
- [owner] JOBBER_DRY_RUN (the Gmail dry flag): while it is `1`, Gmail send stays blocked (`src/safety/dryRun.ts`
  and the kill-switch hook under `.claude/hooks`). Clear it yourself for a real email. It is
  absent from `.env.example`, so add it deliberately.
- `FOLLOWUPS_AUTONOMOUS` stays `false`.

**Commands**

```bash
npm run linkedin:seed -- --url <profile_url> --name "<name>" --company "<company>" --category recruiter
npm run up -- --status
npm run status -- working
```

The seed script registers one LinkedIn person in `people` (category is one of `recruiter`,
`hiring_manager`, `peer`, `connection`), so the typed send tools accept that person as a known
recipient for the first supervised send. Use a real person you are happy to contact, or
yourself on a second account. `up -- --status` must read `MODE: LIVE`.

Send one canary email and one canary connect, then check Gmail, LinkedIn and the DB (the
dashboard or `npm run status -- working`). The browserctl snapshot walker and semantic guard are `unverified`
against live pages: with the screenshot flags off, read the page yourself the first time (or set
`LINKEDIN_SCREENSHOT=true` for the supervised session only).

**Time box:** 3 to 5 days (estimate, not measured) of supervised canaries; you watch each send.

**Exit criteria**
- Every canary send arrived at the intended recipient, with the intended text.
- `linkedin_arm_send` followed by the Send click never reported `unconfirmed` for a send that did not happen, and no
  `unknown_recipient` for freshly found contacts.
- No halt, no `late_block`, no `stuck_sending` follow-up rows.
- `npm run status -- limits` usage matches what you counted by hand.

**Stop and go back to Phase 2 if** any send went to the wrong person, any text broke a gate
you expected to catch it, or a checkpoint or CAPTCHA appeared. Run
`npm run jobber:control -- stop <reason>` first, then flip the dry flags back.

## Phase 4: Mac, autonomous

**Entry**
- Phase 3 exit criteria met.
- `[owner]` Backup working: `npm run backup -- --plan`, then a restore drill per
  `docs/backup-and-restore.md`. Backups are `unverified` until you run the drill.

**Flags (names only)**
- Raise ceilings one at a time, never two in the same day: `SEND_LIMIT_PER_RUN`,
  `MAX_APPLIES_PER_DAY`, `LINKEDIN_MAX_INVITES_PER_WEEK`, `LINKEDIN_MAX_MESSAGES_PER_WEEK`.
- Optional, each its own decision: `FOLLOWUPS_AUTONOMOUS` (autonomous follow-ups never ran
  against real Gmail: `unverified`; they raise deliverability risk), `AUTO_UPDATE`,
  `BACKUP_ENABLED`, `LAYOUT_ENFORCE=enforce`.

**Commands**

```bash
npm run status -- working
npm run doctor
npm run dry-run:report
```

**Time box:** 5 or more days (estimate, not measured) unattended after the last ceiling change.

**Exit criteria**
- 5 days (estimate, not measured) with the machine awake and no manual intervention beyond reading reports.
- No halt that you did not set; no `layout_drift` halt.
- `npm run status -- limits` never shows a ceiling exceeded.
- Reply check (`/checkreplies`) surfaced no bounce you failed to see.

**Stop and go back to Phase 3 if** a ceiling is hit by surprise, a halt appears twice in a
week (estimate, not measured), or a platform shows a restriction notice. Lower the ceilings first, then decide.

## Phase 5: VPS cutover

**Entry**
- Phase 4 exit criteria met.
- `[owner]` A fresh checkout on the VPS passes `bash scripts/bootstrap.sh --check` and
  `npm run doctor` (Linux packages and Chrome installers: `check upstream: each tool's site`).

**Redo on the VPS (nothing carries over by copying state)**
- `[owner]` Recreate the LinkedIn main session
  (`npm run linkedin:login`) and the Naukri session
  (`npm run naukri:login`).
- `[owner]` Re-run the Naukri headless check from the VPS IP. Akamai may treat a datacenter
  IP harder; the recipe passed from a home IP only. Do not add probe pages.
- `[owner]` Download, pin and fit the classifier again (models live in `models/`, which is
  git-ignored).
- `[owner]` Reinstall scheduler units (`npm run scheduler:units` prints the commands, it
  installs nothing; see `docs/scheduler-install.md` for systemd).
- `.env` is not in git: recreate it, mode 600.
- Stop the Mac scheduler first so two machines never run the same sessions.

**Order:** repeat Phase 1 briefly (24 hours dry), then Phase 2 (a day read-only), then go
straight to Phase 3 canaries with low ceilings. Layout memory is per machine: relearn.

**Exit criteria:** 24 hours dry (estimate, not measured) with no unexpected action kinds, a day of clean live reads (estimate), then
the Phase 3 canary exit criteria on the VPS.

**Stop and go back if** Naukri returns 403 or an Access Denied title (halt `naukri`), or
LinkedIn shows a checkpoint on first login from the new IP.

## After a long break (3 months or more)

The 3 month threshold is an estimate, not measured; use your judgement.

Go back to dry before anything live.

1. Set the dry flags on (`SCHEDULER_DRY_RUN`, `LINKEDIN_DRY_RUN`, `WEB_DRY_RUN`, `APPLY_DRY_RUN`, `SCOUT_DRY_RUN`) and run
   `npm run jobber:control -- status`.
2. `[owner]` Re-save sessions if expired (`npm run linkedin:login`,
   `npm run naukri:login`). A dead session shows as `logged_out` in `layout=`.
3. `npm run doctor`: classifier pinned and fitted, hooks installed, permission set as you left it.
4. Update state: `npm run auto-update -- --status`. After an applied update restart Claude
   sessions (MCP servers keep old code).
5. `npm run layout -- status`: reset any kind that is stale or drifted and relearn.
6. `npm run dry-run`, then one dry wake, then read `npm run dry-run:report`.
7. Back to Phase 3 canaries with low ceilings; do not resume at the old ceilings.
