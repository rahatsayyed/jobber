# LinkedIn session setup (Phase 2)

Phase 2 uses two separate, never-shared LinkedIn browser sessions:

- **Burner account** — used only by `linkedin-apply` (Easy Apply). Never used for the `linkedin` MCP.
- **Main account** — used only by the `linkedin` MCP (profile search, connection requests, messages). Never used for Easy Apply.

Each MCP server loads its session from a hardcoded path — this is a structural safeguard, not just convention, so the two accounts can't accidentally get cross-wired.

## One-time login procedure

Run from the repo root:

```bash
npx tsx scripts/save-linkedin-session.ts burner
```

1. A real Chrome window opens to LinkedIn's login page.
2. Log in manually with the burner account (2FA/CAPTCHA/device-verification prompts are expected — handle them as you normally would).
3. Once you land on your feed, return to the terminal and press Enter.
4. The script saves the session to `secrets/linkedin-burner-state.json` and closes the browser.

Repeat with `main` instead of `burner` to save `secrets/linkedin-main-state.json`.

Both files are gitignored (`secrets/` is fully excluded) and must never be committed.

## Re-running later

LinkedIn sessions expire periodically. If `linkedin-apply` or the `linkedin` MCP starts failing with a login/redirect error, re-run the relevant `save-linkedin-session.ts <account>` command to refresh that session file.

## Before enabling `AUTO_APPLY_ENABLED`

Fill in real values in `user-data/easy-apply-answers.json` (years of experience, work authorization, sponsorship needs, relocation, etc.) — the placeholder defaults in that file are not safe to submit as-is.
