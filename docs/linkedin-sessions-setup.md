# LinkedIn session setup

The `linkedin` MCP (`linkedin_find_profiles`, connection requests, messages, invitations) uses ONE
saved session for the MAIN account at `secrets/linkedin-main-state.json`, in one locked headless
Chrome session at a time. The path is hardcoded, which is a structural safeguard.

The burner account's session file (`secrets/linkedin-burner-state.json`) is used only by the
`applier` MCP for LinkedIn Easy Apply (`APPLY_LINKEDIN_EASY`, off by default; the scripted
`apply.linkedin` is gone). There is no login command for it any more: an existing file keeps
working until it expires. Never use the burner session for the `linkedin` MCP.

## One-time login procedure

Run from the repo root:

```bash
npm run linkedin:login
```

The command takes no flag and asks no question: there is only the main account now. It prints a
short instruction and opens the browser.

1. A real, visible Google Chrome window opens on LinkedIn's login page (patchright, installed
   Chrome, the same browser settings as the headless runtime).
2. Log in yourself (2FA, CAPTCHA and device-verification prompts are expected).
3. When you see your feed, return to the terminal and press Enter.
4. The command saves the session to `secrets/linkedin-main-state.json` (mode 600, written
   atomically, refused if it has no `li_at` cookie), prints `Saved session (N cookies)` and closes
   Chrome.

`secrets/` is fully gitignored. These files must never be committed.

## Re-running later

LinkedIn sessions expire periodically. If the `linkedin` MCP fails with a login or redirect error,
or `npm run doctor` (check `sessions`) says the session is missing or expired, run
`npm run linkedin:login` again.

## Checking the saved session

```bash
npm run linkedin:check
```

Read-only: it opens the saved session headless, loads your feed and prints one line, `OK session
valid` (exit 0) or `FAIL <reason>` (exit 1). Reasons: `session_missing`, `session_stale`,
`session_invalid`, `halted`, `session_locked` (another LinkedIn session is open), `chrome_unavailable`,
`logged_out`, `checkpoint`, `captcha`, `blocked`, `unexpected_page`, `page_load_failed`. It clicks
and sends nothing, writes no halt and does not re-save the session. Run it after
`npm run linkedin:login`.

## Before live LinkedIn reads or sends

The `linkedin` MCP is dry-run while `JOBBER_DRY_RUN=true` (the one master flag, shipped in `.env.example`) and, when live, refuses every read and send until the prompt-injection classifier is downloaded, pinned and fitted and `CLASSIFIER_MODEL` is set (see [classifier models](classifier-models.md)). `npm run doctor` shows the `classifier_wired` check.
