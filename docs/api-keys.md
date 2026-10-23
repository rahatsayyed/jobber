# API keys and credentials

Audience: owner
Last verified against: 37942b4
Source files: .env.example, src/setup/steps/apikeys.ts, src/setup/skips.ts, src/platform/checksApiKeys.ts, src/mcp/contacts.ts, src/lib/hunter.ts, docs/gmail-mcp-setup.md, docs/telegram-bot-setup.md, src/search/index.ts, src/search/serper.ts, src/search/budget.ts

This page lists every key Jobber can use, what degrades without it, where it goes and how to
check it. Provider free tiers, limits and prices change: each section says `check upstream`
and carries no number.

All keys go in `.env` (project root, mode 600, git-ignored; `.env.example` lists every name).
Never paste a key into chat, a prompt or a committed file. Keep values on one line with no
spaces.

## Minimum viable set

| Credential | Needed for a first dry run | Without it |
|---|---|---|
| `SERPER_API_KEY` | No | Fewer verified contacts (the cache and the browser dork still run first) |
| `HUNTER_API_KEY`, `HUNTER_ENABLED` | No | Last-resort email lookup stays off |
| Gmail OAuth file | No for a dry run; yes for real email | No cold email, follow-ups or reply watching |
| `TELEGRAM_BOT_TOKEN`, `ALLOWED_USERS` | No | No phone control or alerts |

A first dry run needs none of them. The two API keys are optional and the wizard lets you
skip each one.

## How the wizard handles the optional keys

The `apikeys` setup step offers Serper and Hunter one at a time.

```bash
npm run setup -- --step apikeys
```

Expected: the wizard asks for each provider in turn and writes accepted values to `.env`.

- Input is hidden and never echoed or logged.
- For each provider you can choose now or later. Serper defaults to now, Hunter
  defaults to later.
- Each key is checked with one best-effort call to the provider. A 401 or 403 means rejected:
  you get one retry, then a "keep it anyway" question. Any other failure or a network error
  means "could not verify": the key is kept with a warning and the doctor reports later.
- The endpoints the wizard calls and the credit cost of that one check are unverified: see
  `src/setup/steps/apikeys.ts`.
- An existing key is kept if you confirm.
- After a Hunter key, the wizard asks whether to turn `HUNTER_ENABLED` on (default no).
- Skipping the whole step is recorded as skipped; the doctor then shows a skip instead of a
  warn, with the last line `Skipped by choice: apikeys`. Setting any key by hand overrides the
  skip record.

What skipping costs (from `src/setup/skips.ts`): Serper, fewer
verified contacts; Hunter, last-resort email lookup stays off. The step is labelled OPTIONAL.

Check all the key variables at once:

```bash
npm run doctor
```

Expected: the `api-keys` check passes when all are set, otherwise it warns and names the
unset variables (never values).

## Serper

- What it is: a Google search API. It is a contact-finding service, not a job source.
- Variable: `SERPER_API_KEY`.
- Used by: the search layer (`src/search/`, the only reader of the key outside the setup check and
  the doctor). A search tries the cache first (reused for `SEARCH_CACHE_TTL_DAYS`), then a browser
  dork (`DORK_ENABLED`, `DORK_DAILY_BUDGET`, off for `DORK_BLOCK_COOLDOWN_HOURS` after a search engine
  blocks it), then Serper under `SERPER_DAILY_BUDGET` and `SERPER_MONTHLY_BUDGET`. Callers:
  company-domain resolution and `@domain` email search in `contacts.find_company_emails`, and the
  `source-operator`'s careers-page lookups.
- Without it: the cache and the browser dork still run. If both miss or are blocked, domain
  resolution and search-based emails are skipped and fewer contacts are found. Nothing errors.
- Set by: the wizard or editing `.env`.
- Verify: `npm run doctor` (`api-keys` and `search_providers`), or a dry wake and read the
  contact-finder notes.
- Provider: serper.dev. check upstream: free tier, limits and price. The terms of the search engine
  used by the browser dork are unreviewed.

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
- Verify: `npm run doctor` (`api-keys`), or a dry wake and read the contact-finder notes.
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
