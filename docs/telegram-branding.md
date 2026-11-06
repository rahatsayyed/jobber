# Telegram bot branding

Paste each block into BotFather with the command named in its heading. The
fenced block under each heading is the exact text.

## /setname

```setname
Jobber
```

## /setabouttext (max 120 characters)

```setabouttext
Jobber: autonomous job-hunting agent, built by Rahat. https://github.com/rahatsayyed/jobber
```

## /setdescription (max 512 characters, shown on the empty chat screen before Start)

```setdescription
Jobber finds roles, tailors resumes and handles outreach within strict limits. Built by Rahat. Source: https://github.com/rahatsayyed/jobber
```

## /setcommands

```setcommands
runhunt - Run one wake now: discover, match, contacts, send, apply
status - Funnel, rates and benchmarks
apply - Priority run on a job URL or careers page, or status of job #N
instruction - Give the agent a standing instruction
include - Un-exclude a vetoed job (manual override)
outcome - Record a job outcome (replied/interview/offer/rejected...)
calibrate - Check whether match scores predict interviews
patterns - What kind of jobs reply
report - Offline HTML funnel
limits - Today's send, apply and connect limits
working - Queue, halts and funnel snapshot
health - Platform and pipeline health
```

## Notes

- Telegram renders URLs as tappable links in the about and description fields,
  but does not support HTML or Markdown hyperlinks there, so the visible text is
  the URL itself.
- The greeting after `/start` comes from our own bridge (`src/telegram/`), so it can be changed
  in code.
