# API keys and credentials

Audience: owner
Last verified against: <fill at merge>
Source files: .env.example, src/setup/steps/apikeys.ts, src/setup/skips.ts, src/platform/checksApiKeys.ts, src/sources/adzuna.ts, src/mcp/contacts.ts, src/lib/hunter.ts, docs/gmail-mcp-setup.md, docs/telegram-bot-setup.md

This page lists every key Jobber can use, what degrades without it, where it goes and how to
check it. Provider free tiers, limits and prices change: each section says `check upstream`
and carries no number.

All keys go in `.env` (project root, mode 600, git-ignored; `.env.example` lists every name).
Never paste a key into chat, a prompt or a committed file. Keep values on one line with no
spaces.

## Minimum viable set

| Credential | Needed for a first dry run | Without it |
|---|---|---|
| `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | No | One job source returns nothing |
| `SERPER_API_KEY` | No | Fewer verified contacts |
| `HUNTER_API_KEY`, `HUNTER_ENABLED` | No | Last-resort email lookup stays off |
| Gmail OAuth file | No for a dry run; yes for real email | No cold email, follow-ups or reply watching |
| `TELEGRAM_BOT_TOKEN`, `ALLOWED_USERS` | No | No phone control or alerts |

A first dry run needs none of them. The three API keys are optional and the wizard lets you
skip each one.

## How the wizard handles the optional keys

The `apikeys` setup step offers Adzuna, Serper and Hunter one at a time.

```bash
npm run setup -- --step apikeys
```

Expected: the wizard asks for each provider in turn and writes accepted values to `.env`.

- Input is hidden and never echoed or logged.
- For each provider you can choose now or later. Adzuna and Serper default to now, Hunter
  defaults to later.
- Each key is checked with one best-effort call to the provider. A 401 or 403 means rejected:
  you get one retry, then a "keep it anyway" question. Any other failure or a network error
  means "could not verify": the key is kept with a warning and the doctor reports later.
- The endpoints the wizard calls and the credit cost of that one check are unverified: see
  `src/setup/steps/apikeys.ts`.
- An existing key is kept if you confirm. A provider with only part of its keys set (Adzuna
  needs both) is treated as not configured.
- After a Hunter key, the wizard asks whether to turn `HUNTER_ENABLED` on (default no).
- Skipping the whole step is recorded as skipped; the doctor then shows a skip instead of a
  warn, with the last line `Skipped by choice: apikeys`. Setting any key by hand overrides the
  skip record.

What skipping costs (from `src/setup/skips.ts`): Adzuna, one job source off; Serper, fewer
verified contacts; Hunter, last-resort email lookup stays off. The step is labelled OPTIONAL.

Check all four key variables at once:

```bash
npm run doctor
```

Expected: the `api-keys` check passes when all four are set, otherwise it warns and names the
unset variables (never values).

## Adzuna

- What it is: a job-search API, one of the sources `job-fetch.list_new_jobs` queries.
- Variables: `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` (both needed).
- Used by: discover stage, `fetchAdzuna` in `src/sources/adzuna.ts`.
- Without it: the request is sent with empty values, fails, is logged to stderr and returns
  no jobs. Company boards, Remotive and Naukri still run.
- Set by: the wizard (`apikeys` step) or by editing `.env`.
- Verify: `npm run doctor` (`api-keys`), or a dry-run hunt and read the discoverer's
  `BOARD_STATUS:` line and the `[adzuna]` stderr log.
- Provider: developer.adzuna.com. check upstream: free tier, limits and price.

## Serper

- What it is: a Google search API.
- Variable: `SERPER_API_KEY`.
- Used by: contact stage, `serperSearch` in `src/mcp/contacts.ts` (the only reader of the key
  outside the setup check and doctor), to find the company's official domain (`findDomain`)
  and to search for `@domain` emails (`searchDomainEmails`). Nothing in code runs other
  searches with it. The `.env.example` comment says "dorks + contact search"; that wording is
  broader than the code, which only does these two lookups.
- Without it: the search returns nothing, so domain resolution and search-based emails are
  skipped and fewer contacts are found. Nothing errors.
- Set by: the wizard or editing `.env`.
- Verify: `npm run doctor` (`api-keys`), or a dry-run hunt and read the contact-finder notes.
- Provider: serper.dev. check upstream: free tier, limits and price.

## Hunter

- What it is: an email finder, used as the LAST resort only.
- Variables: `HUNTER_API_KEY`, `HUNTER_ENABLED` (must be exactly `true`), `HUNTER_MONTHLY_CAP`
  (default and meaning in `.env.example`).
- Used by: contact stage, `hunterDomainSearch` in `src/lib/hunter.ts`, called from
  `contacts.find_company_emails`. Emails it returns are still verified before any send.
- Without it: with `HUNTER_ENABLED` not `true` the call returns nothing and spends nothing.
  Keep it `false` for the first smoke test.
- Cap: a counter in `.hunter_usage.json`, resolved against the process working directory when
  the module loads; at the cap, lookups stop. Known code limitations: `hunterDomainSearch`
  increments and saves the counter before it reads `HUNTER_API_KEY`, so with
  `HUNTER_ENABLED=true` and an empty key every lookup still spends local cap and sends an
  unauthenticated request. The counter file is relative to where the process was started, so a
  process started from another directory uses a separate counter, which acts as a reset.
- Set by: the wizard (key and the enable question) or editing `.env`.
- Verify: `npm run doctor` (`api-keys`), or a dry-run hunt and read the contact-finder notes.
- Provider: hunter.io. check upstream: free tier, credits and price.

## Gmail

- What it is: an OAuth client file for the Gmail MCP, used for cold email, follow-ups and
  reply watching.
- Variables: `GMAIL_OAUTH_PATH`, `GMAIL_CREDENTIALS_PATH` (paths, defaults in `.env.example`).
  `GMAIL_USER` and `GMAIL_APP_PASSWORD` are a legacy SMTP fallback and unused.
- Without it: no cold email, no email follow-ups, no reply watching. LinkedIn and Naukri
  outreach still run.
- Set by: the wizard (`gmail` step) after you create the OAuth client yourself; consent is
  owner-only. Full steps: [Gmail setup](gmail-mcp-setup.md).
- Verify: `npm run doctor` (`gmail-oauth`).

## Telegram

- What it is: a bot token plus your numeric user id, for the ccgram bridge.
- Variables: `TELEGRAM_BOT_TOKEN`, `ALLOWED_USERS` (comma-separated numeric ids).
- Without it: no phone control and no alerts. Anything the agent asks you over Telegram, such
  as approving a draft in legacy follow-up mode, has no channel. How follow-ups are approved
  in each mode is in `CLAUDE.md`, section "Safety" and the `/followups` command row.
- Set by: the wizard (`telegram` step) after you create the bot with @BotFather yourself.
  Full steps: [Telegram bot setup](telegram-bot-setup.md).
- Verify: `npm run doctor` (`telegram-api`).
