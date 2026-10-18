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
followups - Draft follow-ups for approval, resolve stale
apply - Status of a job in the browser-apply queue
connect - Draft + send a LinkedIn connect request
include - Un-exclude a vetoed job (manual override)
outcome - Record a job outcome (replied/interview/offer/rejected...)
calibrate - Check whether match scores predict interviews
checkreplies - Detect replies in Gmail and record outcomes
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
- The greeting message ccgram sends after `/start` is hard-coded in ccgram
  (`handlers/dashboard_command.py`, `private_start_greeting`, an inline string
  that names "ccgram"); no env var or config file was found that changes it, and
  the BotFather fields above do not affect it. Options, not chosen here: accept
  it as is, or patch ccgram in a private fork (owner's call).
