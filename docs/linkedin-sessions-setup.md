# LinkedIn session setup

The `linkedin` MCP (`linkedin_find_profiles`, connection requests, messages, invitations) uses ONE
saved session for the MAIN account at `secrets/linkedin-main-state.json`, in one locked headless
Chrome session at a time. The path is hardcoded, which is a structural safeguard.

The burner account's session file (`secrets/linkedin-burner-state.json`) is used only by
`apply.linkedin` (Easy Apply, off in the 8G design) and the older `discover.linkedin_*` tools.
There is no login command for it any more: an existing file keeps working until it expires, and
both of those paths are being retired. Never use the burner session for the `linkedin` MCP.

## One-time login procedure

Run from the repo root:

```bash
npm run linkedin:login -- --account main
```

Without `--account main` the command asks `Log in the MAIN LinkedIn account? (y/N)` and needs a
terminal. It never reads an environment variable for this (the old `LINKEDIN_LOGIN_ACCOUNT` gate
is gone).

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
`npm run linkedin:login -- --account main` again.

## Before live LinkedIn reads or sends

The `linkedin` MCP is dry-run by default (`LINKEDIN_DRY_RUN=true`) and, when live, refuses every read and send until the prompt-injection classifier is downloaded, pinned and fitted and `CLASSIFIER_MODEL` is set (see [classifier models](classifier-models.md)). `npm run doctor` shows the `classifier_wired` check.
