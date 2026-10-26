<!-- Moved verbatim from CLAUDE.md; the rules in CLAUDE.md "Safety" and "Commands" still apply. -->

## Outreach safety layers

LinkedIn, Naukri and Wellfound outreach is agent-driven (ADR `docs/superpowers/specs/2026-10-13-adr-agent-driven-browser-runtime.md`,
revised by the browserctl design `.superpowers/sdd/linkedin-arch-design.md`): the model reads and acts by
snapshot ref, and anything irreversible needs an armed intent that the arm tool created after the code
gates and that the engine re-verifies against the live page. Layers, outermost first:

1. **Restricted runner**: `scripts/run-claude.sh|ts <profile>` builds the `claude` argv from
   `config/run-profiles.json`: exact allowlisted tool names (wildcards rejected), allowlisted
   child environment, `--strict-mcp-config`, no bypassPermissions, no skip-permissions. Profile
   `outreach_wake` (scheduler, and `./run-hunt.sh` through it) has the platform (LinkedIn, Naukri,
   Wellfound), pipeline, mail and applier tools plus the db tools they need, and `Skill`, `Agent` and
   `Task`; no Bash, Read or web fetch. Its main thread holds the send tools (only subagents are narrowed by
   the hook). Profile `mail_drip` (the mail drip lane, one run per email, wall and token budget only) holds
   only the `mail-operator` tools of `config/worker-tools.json` (the `db` and `gmail` servers, `Agent` and `Task`),
   an allowlisted environment without secrets and `gmail.send_email` as a screened argument surface; it is
   launched by the scheduler daemon, never by a session.
   Interactive profiles (`setup_guide`, `interactive: true`) take only an allowlisted env, list
   Bash commands as exact strings in `bash_exact` (no wildcard), may declare `classifier:
   not_required` only when validated to have no MCP tools, and are covered by the
   `prompt-secret-guard` hook, which blocks a prompt that looks like a pasted secret.
2. **PreToolUse allowlist hook** (`.claude/hooks/tool-allowlist.cjs`): denies any tool, path or
   secret-shaped argument outside the run profile, fail closed. `block-outside-project.cjs`
   (project `.claude/settings.json`) denies Read/Write/Edit/Bash paths outside the project.
3. **Input gate** (`src/safety/inputGate.ts`): strips hidden text and invisible characters,
   caps length, regex-matches override and exfiltration phrases, wraps page text as data.
   Applied inside the `linkedin`, `naukri` and `wellfound` read tools, then by layer 4.
4. **Local injection classifier** (`src/safety/classifier*.ts`, `config/classifier-models.json`):
   exactly one model, chosen by `CLASSIFIER_MODEL`, no fallback chain. Weights are downloaded by
   the owner (`npm run models -- fetch|pin`, then `classifier:fit`); see
   `docs/classifier-models.md`. The default profile is English-only. It is wired through one
   function, `screenUntrusted` (`src/safety/screen.ts`: code gate, then classifier), called on
   every surface in `SCREENED_SURFACES`: `linkedin_snapshot` (also covers open, scroll, click, type and press_key
   output), `linkedin_arm_send`, `linkedin_find_profiles`, `linkedin_search_jobs`, `linkedin_search_posts`, the `naukri` reads (`naukri_snapshot`,
   `naukri_arm_send`, `naukri_arm_apply`, `naukri_search`, `naukri_discover`, `naukri_inbox`, `naukri_read_thread`) and the Naukri send path, the `wellfound`
   reads and arm tools (`wellfound_snapshot`, `wellfound_arm_send`, `wellfound_arm_apply`, `wellfound_discover`, `wellfound_inbox`,
   `wellfound_read_thread`), the three owner-page reads `linkedin_manual_job`, `naukri_manual_job` and `wellfound_manual_job`
   (`src/manual/platformJob.ts`), the Naukri
   inbound classifier (`src/naukri/inbound.ts`) `outreach.escalate`, and the applier and scout page reads (`apply_state`, `apply_escalate`, `scout_search`, `scout_state`, `scout_extract_jobs`, site state; the full list is `SCREENED_SURFACES` in `src/safety/screen.ts`); a lint test and the
   `classifier_wired` doctor check fail when one of them stops calling it. Fail-closed policy:
   a live (non-dry-run) read or send is BLOCKED when the classifier is unset, unpinned, unfitted,
   missing or erroring (`classifier_unavailable`), truncated (`classifier_truncated`) or flags
   injection (`injection_suspected`); in a dry run only `classifier_unavailable` degrades: the call
   continues with the result marked `classifier=unscreened`, while `injection_suspected` and
   `classifier_truncated` verdicts still block (`src/safety/screen.ts`), and an automatic reply
   (`mayAutoReply`) is never allowed on an unscreened result; an escalation
   is never dropped: it is stored with a `[blocked: <code>]` or `[unscreened]` prefix. The
   launcher refuses to start any profile whose classifier is not ready (`src/platform/launchCheck.ts`,
   exit 3 `classifier not ready`); the legacy `config/classifier.pin.json` is removed. Each MCP
   process (`linkedin`, `naukri`, `wellfound`, `outreach`) loads its own copy of the model on first use (about
   750 MB of weights each; `outreach` only on `escalate`). The four screenshot tools (`linkedin_screenshot`,
   `naukri_screenshot`, `wellfound_screenshot`, `scout_screenshot`) return raw pixels that are NOT screened, and their
   `*_click_at` pointer tools act on coordinates; both are ON by default behind `LINKEDIN_SCREENSHOT`,
   `NAUKRI_SCREENSHOT`, `WELLFOUND_SCREENSHOT` and `SCOUT_SCREENSHOT` (owner decision: off only when the value is exactly `false`; unset or any other value is on; `APPLY_SCREENSHOT` is different and still ships off). `click_at` needs its flag not `false`, a snapshot and a screenshot at the current epoch, and is
   classified by the same semantic guard as a ref click (an element under the point that is a commit
   or irreversible class needs an armed intent; scout refuses all of them). The arm tools, the guard
   and the armed-intent store are described under "Connecting".
5. **Output gate** (`src/safety/outputGate.ts`) after the AI-tells style gate
   (`src/safety/styleGate.ts`, `config/ai-tells.json`: banned phrases, no em or en dashes, no
   markdown, per-kind word limits) and `resume.check_text` (fact gate): recipient and thread must
   match SQLite, URLs, emails and secret-shaped strings must be allowlisted
   (`LINKEDIN_ALLOWED_URLS`, `LINKEDIN_ALLOWED_EMAILS`), and an overlap check against raw page text.
6. **Ceilings, halts, kill switch**: rolling per-platform caps and per-company limits in
   `src/outreach/limits.ts` (catalog and defaults in `src/setup/limitsCatalog.ts`), halt flags in
   `halt_flags` (halt targets `all`, `linkedin`, `naukri` and `wellfound`; a LinkedIn checkpoint, CAPTCHA or
   restriction page halts LinkedIn; consecutive Naukri send failures halt Naukri, three unconfirmed or failed
   Wellfound sends halt Wellfound; clear LinkedIn's with `npm run linkedin:clear-halt --
   --yes`), quiet hours, cooldowns. Kill switch:
   `npm run jobber:control -- stop [reason]` writes `.jobber/STOP` and halts `all`, `linkedin`,
   `naukri` and `wellfound`; the scheduler kills its window within one poll. `npm run jobber:control --
   resume` (`src/scheduler/control.ts` `applyResume`) removes the STOP file unconditionally and
   clears only the halts whose reason carries its own stop prefix; halts set by anything else
   stay. `JOBBER_KILL=1` has the same effect on wakes. Enforced in code (plan 8A, task 7):
   `.claude/hooks/kill-switch.cjs` is called from `tool-allowlist.cjs` (every tool is denied
   while `.jobber/STOP` exists, `JOBBER_KILL=1` is set, or the STOP path cannot be read) and from
   `.claude/settings.json` as a `onFailure: block` matcher hook for the irreversible tools and every tool that
   opens a page for a platform session (`gmail.send_email`, the applier's acting tools (`apply_open`, `apply_autofill`,
   `apply_fill`, `apply_choose`, `apply_upload`, `apply_next`, `apply_submit`, `apply_propose_recipe`, `site_login`,
   `site_signup`, `site_open_link`), `linkedin_(open|click|type|press_key|click_at|arm_send|search_jobs|search_posts|manual_job)`
   (the matcher also still lists the retired `connect_send`, `send_message` and `accept_invite`),
   `naukri_(open|click|type|press_key|click_at|arm_send|arm_apply|discover|manual_job)`,
   `wellfound_(open|click|type|press_key|click_at|arm_send|arm_apply|discover|manual_job)` and every `scout` tool); the same hook
   denies `gmail.send_email` when `JOBBER_DRY_RUN` is dry (`1` or `true`, same parse as `isDryRun`); the launcher (`scripts/run-claude.ts`) exits 4 when STOP or `JOBBER_KILL` is set, and a wake (also a
   forced one from `./run-hunt.sh`) is skipped with reason `killed`. Not covered: `halt_flags` rows are not
   read by the hook (the typed tools read them); a tool call already executing when STOP is
   written completes; hook propagation into subagents is unverified in real `claude`;
   interactive sessions outside this project directory; sends done through Bash; the Gmail dry
   run is the same single `JOBBER_DRY_RUN` flag;
   `JOBBER_KILL` is not in the `outreach_wake` profile's `env_keys`, so inside restricted runs
   the hook's `JOBBER_KILL` path is inert (the STOP file and the launcher cover it).
7. **Dry run**: ONE master flag, `JOBBER_DRY_RUN` (`src/safety/dryRun.ts` `isDryRun`, copied into the
   hook `.claude/hooks/kill-switch.cjs`, parity test `tests/dryrun-parity.test.ts`). Dry iff the trimmed,
   lowercased value is `1` or `true`; unset, empty, `false`, `0` or anything else is LIVE (the default).
   It covers the scheduler (the mail drip lane included), LinkedIn, Naukri, Wellfound, scout, applier, web actions (login, sign-up, upload, typing,
   submit) and the Gmail send hook. `.env.example` ships `JOBBER_DRY_RUN=true`. The old
   `SCHEDULER_DRY_RUN`, `LINKEDIN_DRY_RUN`, `WEB_DRY_RUN`, `APPLY_DRY_RUN` and `SCOUT_DRY_RUN` keys are
   ignored (the doctor warns when `.env` still has one). Dry actions are recorded in `dry_run_actions`
   (`npm run dry-run:report`), redacted and clamped.

Not covered by code: `gmail.send_email` has the kill-switch and `JOBBER_DRY_RUN` hook only (no
`halt_flags` read). The
browserctl actions do check halts and the kill switch themselves, but the semantic guard is a word
list over accessible names (English plus a short extension list), so a control it mis-reads is a
residual risk; it fails closed for unknown dialog-footer and submit buttons. See layer 6 for the full
kill-switch scope.
