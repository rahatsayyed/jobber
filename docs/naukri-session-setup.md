# Naukri session setup

`src/sources/naukri.ts`'s apply-URL-resolution phase (clicking Naukri's "Apply on company site"
button to resolve a job's real employer-ATS URL) only runs if a saved, logged-in Naukri session
exists at `secrets/naukri-state.json`. Without it, Naukri jobs still get discovered and scored
normally — they just keep the Naukri listing URL as `apply_url` (a harmless, already-supported
fallback), and the valuable part of this feature (routing straight to the employer's real ATS)
silently never activates.

## One-time login procedure

Run from the repo root:

```bash
npx tsx scripts/save-naukri-session.ts
```

1. A real Chrome window opens to Naukri's login page.
2. Log in manually (OTP/CAPTCHA prompts are expected — handle them as you normally would).
3. Once you land on your Naukri homepage/dashboard, return to the terminal and press Enter.
4. The script saves the session to `secrets/naukri-state.json` and closes the browser.

`secrets/` is fully gitignored — this file must never be committed.

## Re-running later

Naukri sessions expire periodically. If Naukri jobs stop getting resolved apply URLs (check the
`[naukri] session state not found at ...` log line), re-run
`npx tsx scripts/save-naukri-session.ts` to refresh the session file.

## Headed browser / Akamai constraint

Naukri sits behind Akamai Bot Manager, which blocks headless Chromium outright — both the search
phase and the apply-URL-resolution phase in `naukri.ts` launch with `headless: false` (see
`docs/superpowers/specs/2026-07-28-naukri-discovery-design.md` for the live-verified details).

This means a real, visible browser window is required. If this runs on a server without a
physical display, you need a virtual display (e.g. Xvfb) available — this is an
operational/deployment concern, not something the code configures for you.
