# Browser apply

Audience: owner
Last verified against: 37942b4
Source files: src/mcp/applier.ts, src/applier/tools/open.ts, src/applier/tools/submit.ts, src/applier/escalate.ts, src/applier/cooldown.ts, src/applier/confirm.ts, src/applier/recipes/store.ts, src/applier/recipes/learn.ts, src/applier/recipes/layoutGuard.ts, src/apply/registry.ts, src/apply/answers.ts, src/webcore/hostCaps.ts, src/webcore/accounts.ts, src/webcore/checkboxes.ts, src/webcore/launch.ts, scripts/site-account.ts, config/ats-recipes/, .claude/agents/apply-operator.md, .env.example

This page explains how Jobber applies to jobs through the browser, what limits it, where accounts and
credentials live, what it hands back to you, and which checks only you can do. Safety rules are not
restated here: they live in [CLAUDE.md](../CLAUDE.md) under "Applying" and "Safety" (rules 14, 15
and 17).

## How it works

The `apply-operator` runs as the last step of a wake. It works the queued rows that carry an apply
platform, one application at a time, up to a quota computed in code from the remaining daily budgets.
It uses the typed tools of the `applier` MCP and nothing else:

- `apply_open({job_id})` is the only tool that navigates. The page address comes from the job row in
  the database; no tool takes a URL from the model, and a link found in a posting, a page or an email
  is never opened.
- Every other tool takes ids and refs taken from the latest tool result (a field, a control). The
  operator never types a value. Values are resolved in code from the answer book: the fields of
  `user-data/profile.json` and `user-data/easy-apply-answers.json` (including its `custom` map of
  question text to answer). A value is never returned to the model.
- A job is refused before any browser use when it is unknown, vetoed (it has an exclusion reason),
  hard-stopped, already applied to, has no prepared resume PDF, sits on a host in cooldown, was opened
  on the same host too recently (`WEB_MIN_GAP_SEC`), or a daily cap is spent.

Per job: `apply_autofill` tries a recipe, `apply_state` shows the compact form model, the remaining
fields are filled by ref, `apply_submit` submits and `apply_close` ends the job. The result is one of
`submitted`, `held`, `unconfirmed`, `dry_run`, `needs_owner`, `rate_limited`, `halted` or `failed`.
`submitted` needs a confirmation (a recipe signal, a thank-you URL path or confirmation text, with the
form gone). A click that cannot be confirmed is `unconfirmed`, counted as `manual_review`, and never
retried by code: check it by hand.

## What it applies to

The apply platform of a queued job is decided in code when the job is queued, never by the model,
from the stored apply URL (`src/apply/registry.ts`):

| Class | Hosts | Notes |
|---|---|---|
| Fast path (shipped recipe) | Greenhouse, Lever, Ashby, Workable, SmartRecruiters | recipes in `config/ats-recipes/` |
| Agent path (no recipe) | Workday, Recruitee, Personio | the operator fills the form from the state; Workday normally needs an account |
| `browser` | any other host | only when `APPLY_ALLOW_UNKNOWN_HOSTS` is `true` |
| `linkedin_easy` | linkedin.com | only when `APPLY_LINKEDIN_EASY` is `true`; uses the burner session |
| `naukri` | naukri.com | the native Naukri Apply through the Naukri tools; it also consumes `NAUKRI_MAX_APPLIES_PER_DAY` |
| never | everything else | discover-only and generated sources, no apply URL, look-alike hosts, credentials in the URL, non-http(s) URLs, an unknown host or LinkedIn while the matching flag is off |

Jobs from discover-only sources never reach the queue with an apply platform; see
[sources-and-platforms.md](sources-and-platforms.md).

## Limits

| Limit | Key | Default |
|---|---|---|
| Applications per day (all kinds, shared with Naukri) | `MAX_APPLIES_PER_DAY` | 5 |
| Application attempts per day (counted at open) | `APPLY_MAX_ATTEMPTS_PER_DAY` | 30 |
| Applications per host per day | `APPLY_MAX_PER_HOST` | 10 (range 1 to 50, out of range is clamped and the doctor warns) |
| Per-platform override | `APPLY_MAX_PER_HOST_GREENHOUSE`, `_LEVER`, `_ASHBY`, `_WORKABLE`, `_SMARTRECRUITERS`, `_WORKDAY`, `_RECRUITEE`, `_PERSONIO`, `_BROWSER` | falls back to `APPLY_MAX_PER_HOST`, then 10 |
| Next/back/save clicks per application | `APPLY_MAX_STEPS` | 12 |
| New site accounts per day | `SITE_MAX_ACCOUNTS_PER_DAY` | 2 |

Per-host counters are consumed together with `MAX_APPLIES_PER_DAY` at the moment of the submit click.
A `rate_limited` result is reported and not retried. `npm run status -- limits` shows today's usage.

## Dry run, hold and submit

Everything ships dry. A real browser action needs `SCHEDULER_DRY_RUN=false` and `WEB_DRY_RUN`,
`APPLY_DRY_RUN` and `SCOUT_DRY_RUN` all `false`. Even then `APPLY_SUBMIT_MODE` ships `hold`: the
operator fills the form, uploads the PDF and stops at the review step, reporting `held`. Only exactly
`submit` clicks submit. You flip these flags; the agent never does.

## Accounts and credentials

- The operator never creates an account on its own. `site_signup` works only when
  `APPLY_ALLOW_ACCOUNT_CREATION` is `true` (ships `false`), every web dry-run flag is `false` and
  `SITE_MAX_ACCOUNTS_PER_DAY` has room. Otherwise the job is escalated as `account_needed`.
- Credentials are stored in `secrets/site-accounts.json` (mode 600 in a mode 700 directory), one
  entry per host, with a unique code-generated password for accounts the agent creates. A password is
  read only inside the MCP process and is never returned by a tool or shown to the model.
- You manage the file with `npm run site:account -- add <host>` (hidden prompt), `list`, `remove <host>`
  and `status`. The agent never runs it. Create an account yourself where you can.
- Email verification is owner assist by default (`SITE_MAIL_VERIFY=owner_assist`): the job is escalated
  with `email_verification`, you verify the account by hand and re-queue the job. `gmail` mode needs a
  non-empty `SITE_MAIL_SENDERS`; senders set without `gmail` still mean owner assist.
- Discovery sites visited by the scout follow the same rule with `SCOUT_ALLOW_SIGNUP`.

## What gets escalated to you

`apply_escalate` hands one job to you with a reason from a closed list and a short code-built detail;
it is written to the notify file (`.jobber/notify.jsonl`).

| Reason | Meaning |
|---|---|
| `captcha`, `mfa`, `phone_verification` | never solved or waited out; recorded against the host |
| `blocked` | the site blocked the browser; recorded against the host |
| `email_verification` | a verification mail is needed (owner assist) |
| `account_needed` | the site needs an account and creation is off or capped |
| `question` | a screening question the answer book cannot answer (`needs_owner`) |
| `consent` | an attestation or data-sharing box, or a required box while `APPLY_ACCEPT_LEGAL_REQUIRED` is `false` |
| `marketing_checkbox` | a marketing box was checked; submit is refused |
| `cover_letter` | the form asks for a cover letter |
| `host_unknown`, `drift`, `login_failed`, `other` | unknown host, a page that no longer matches what was learned, a failed sign-in, anything else |

Marketing and newsletter boxes are never checked. Required privacy-notice or terms boxes are checked
when `APPLY_ACCEPT_LEGAL_REQUIRED` is `true` (the default); attestations and third-party data-sharing
boxes always wait for you.

Two blocks on one host within 7 days put that host on cooldown for `APPLY_HOST_COOLDOWN_DAYS` (default
7): the applier does not open it meanwhile. A streak of three bot-wall blocks over at least two runs
sets the `apply` halt; only you clear it (`npm run jobber:control -- clear-halt apply`).

### Answering a question you were asked

When the report carries a `needs_owner` item with the exact question text: decide a truthful answer
from your real background (never a guess), add it under `custom` in `user-data/easy-apply-answers.json`
keyed by the question as written (matching ignores case, whitespace and a trailing `*`), and
re-queue or wait for the next wake. The file is read again on each use, so no restart is needed.

## Recipes and drift

A recipe is data: field roles, safe selectors and answer-book refs, with no code and no typed values.
Shipped recipes are in `config/ats-recipes/`. Learned recipes are written to `.jobber/ats-recipes/`
only from confirmed submitted applications, after `APPLY_RECIPE_PROMOTE_N` of them over
`APPLY_RECIPE_PROMOTE_RUNS` distinct runs, and never for a platform that already has a recipe.

Drift is detected through layout memory: every ATS page read is observed under a per-platform
`ats_<id>` layout file ([layout-memory.md](layout-memory.md)). With `LAYOUT_ENFORCE=enforce` a drifted
page makes autofill and submit refuse; with `warn` it is only recorded. A recipe that no longer fits
shows up as a recipe miss in the operator's report and, for a changed page, as `drift`.

## Owner live checks

Nothing in browser apply has run against a real ATS posting: it is covered by unit tests with fakes
and invented fixture pages, and the shipped recipes were written from fixtures (`unverified`). Do
these yourself, in order, after backing up `data.sqlite` and fully restarting Claude Code:

1. Hold mode: one Greenhouse job with `APPLY_DRY_RUN` `false` and `APPLY_SUBMIT_MODE` `hold`. Check it
   fills by reference, uploads the PDF and stops at review (`held`); compare with the posting in your
   own browser and check every marketing box is unchecked. Repeat for Lever and Ashby.
2. First submit: `APPLY_SUBMIT_MODE` `submit` for one job; confirm `submitted` and the vendor's
   confirmation email.
3. Account walls: create the account yourself first (`npm run site:account -- add <host>`), then run
   one Workday application in hold mode and check no password appears anywhere. Only then try
   `APPLY_ALLOW_ACCOUNT_CREATION` on one tenant.
4. Blocks: note which sites show a CAPTCHA, MFA or phone check; confirm the stop, the escalation and
   the cooldown after two blocks.
5. Kill switch: during an apply run `npm run jobber:control -- stop test`; the next acting call must
   be denied.

`npm run doctor` has the checks `web_flags`, `apply_limits`, `apply_recipes`, `site_accounts`,
`browser_launch` and `login_commands`. All browsers (LinkedIn, Naukri, scout, applier) run on
patchright with the installed Google Chrome; a site that blocks it has no bundled-browser fallback.
Terms of service of the sites you apply to are your responsibility.
