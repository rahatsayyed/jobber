# Naukri session setup

The `naukri` MCP and the Naukri search in `src/sources/naukri.ts` use a saved, logged-in Naukri
session at `secrets/naukri-state.json`. Without it, Naukri tools report logged out and Naukri
jobs keep their listing URL as `apply_url` (a harmless, already-supported fallback).

## One-time login procedure

Run from the repo root:

```bash
npm run naukri:login
```

The command takes no flag and asks no question. It prints a short instruction and opens the browser.

1. A real, visible Google Chrome window opens on Naukri's login page. The command uses the same
   Chrome recipe and browser settings as the headless runtime (patchright, installed Chrome,
   `en-IN`, `Asia/Kolkata`), so the saved session matches what Naukri's bot protection sees later.
2. Log in yourself (OTP and CAPTCHA prompts are expected, handle them as you normally would).
3. When you see your Naukri homepage, return to the terminal and press Enter.
4. The command saves the session to `secrets/naukri-state.json` (mode 600, written atomically),
   prints `Saved session (N cookies)` and closes Chrome. If it finds no Naukri login cookie it
   saves nothing and tells you to finish logging in and run it again.

`secrets/` is fully gitignored. This file must never be committed.

## Re-running later

Naukri sessions expire periodically. When `npm run doctor` (check `sessions`) or the `naukri`
tools report a missing or expired session, run `npm run naukri:login` again.

## Checking the saved session

```bash
npm run naukri:check
```

Read-only: it opens the saved session headless, loads the Naukri home page and prints one line,
`OK session valid` (exit 0) or `FAIL <reason>` (exit 1). Reasons: `session_missing`, `session_stale`,
`session_invalid`, `halted`, `chrome_unavailable`, `logged_out`, `blocked`, `captcha`,
`unexpected_page`, `page_load_failed`. It clicks and sends nothing and does not re-save the session.
Run it after `npm run naukri:login`.

## Chrome requirement

Naukri sits behind Akamai Bot Manager, which blocks headless Chromium and stock Playwright. Every
Naukri page runs through patchright with installed Google Chrome (`channel: 'chrome'`), never the
bundled Chromium. Install Google Chrome first. On a server without a display the login command
needs a virtual display (for example Xvfb) or must be run on a machine with one, then copy the
session file over.
