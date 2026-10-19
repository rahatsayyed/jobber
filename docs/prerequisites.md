# Prerequisites

Audience: owner
Last verified against: cc51247
Source files: package.json, config/ccgram.pin.json, config/update-known-failures.json, scripts/ccgram/start.sh, scripts/ccgram/check-version.sh, scripts/bootstrap.sh, scripts/bootstrap.ts, src/bootstrap/catalog.ts, src/platform/checks.ts, src/platform/checksSetup.ts, src/setup/steps/prereqs.ts, src/scheduler/units.ts, src/backup/create.ts, docs/backup-and-restore.md

This page lists every tool Jobber needs on the machine, which feature it unlocks, how to verify it and what to do when it is missing. It is macOS first; Ubuntu (VPS) differences are marked. Windows is not covered.

## Fastest path

```bash
bash scripts/bootstrap.sh --check
```

Detects every item below and changes nothing. Then run `bash scripts/bootstrap.sh` to be offered the installs (it asks before each action; sudo actions need an explicit `--allow-sudo`). `--plan` shows what would run without running it. The setup wizard (`npm run setup`) `prereqs` step checks only five doctor checks (`node-version`, `tmux`, `chrome`, `browser-binaries`, `ccgram-version`), prints each failing one's fix text and never runs an installer.

```bash
npm run doctor
```

Runs the full health check; each failing item prints a `fix:` line.

## Required and optional at a glance

| Item | Required | Unlocks |
|---|---|---|
| Node.js | yes | everything |
| git | yes | clone, auto-update |
| C build tools | yes | native module build (`better-sqlite3`) |
| npm dependencies, renderer dependencies | yes | all servers, PDF rendering |
| Claude Code CLI (`claude`), logged in | yes | scheduler wakes (and `./run-hunt.sh`), setup guide |
| tmux | yes | ccgram bridge, named windows, scheduler runs |
| uv | yes | installing ccgram |
| ccgram (pinned) | yes | Telegram bridge |
| Google Chrome | yes (warning if missing) | every browser tool (LinkedIn, Naukri, scout, applier) and the resume PDF render |
| patchright browser | per package install | LinkedIn and apply sessions |
| age, rclone | optional | backups only |
| launchctl or systemctl | optional | scheduler unit install only |

## Tool table

| Tool | Purpose | Minimum version (from code) | Verify | If missing |
|---|---|---|---|---|
| Node.js | runs every script and MCP server | `engines.node` in `package.json` is `>=20`; doctor `node-version` fails below 20 | `node -v` | macOS: bootstrap runs `brew install node`. Ubuntu: the apt package is used only if its version is new enough, otherwise nvm or NodeSource (check upstream: https://github.com/nvm-sh/nvm). |
| git | clone and fast-forward updates | none checked | `git --version` | macOS: `xcode-select --install`. Ubuntu: bootstrap offers `apt-get install -y git`. |
| C build tools | build `better-sqlite3` | none checked | macOS `xcode-select -p`; Ubuntu `cc --version` | macOS: `xcode-select --install`. Ubuntu: `apt-get install -y build-essential`. |
| npm dependencies | the servers and scripts | lockfile | `npm ls --depth=0` | `npm ci` |
| renderer dependencies | PDF template (handlebars) | lockfile | check that `renderer/node_modules/handlebars` exists | `npm ci --prefix renderer` |
| Claude Code CLI | runs the agent sessions | doctor `restricted_hook` warns below 2.1.295 (hook `onFailure: block`) | `claude --version` | check upstream: https://docs.claude.com/en/docs/claude-code/setup. Bootstrap may offer `npm install -g @anthropic-ai/claude-code` when the npm global prefix is writable. Then run `claude` once. |
| Claude login | subscription session used by headless runs | n/a | `claude auth status` | `claude auth login` |
| tmux | holds ccgram, windows and scheduler runs | none checked | `tmux -V` | macOS `brew install tmux`; Ubuntu `apt-get install -y tmux` |
| uv | installs the pinned ccgram | none checked | `uv --version` | macOS `brew install uv`. Ubuntu: official installer (check upstream: https://astral.sh/uv/install.sh); bootstrap can download it, show url, size and sha256, then ask again. |
| ccgram | Telegram bridge | exactly the version in `config/ccgram.pin.json` | `ccgram --version` | see "ccgram" below |
| Google Chrome | every browser (LinkedIn, Naukri, scout, applier) and the resume PDF render use `channel: 'chrome'` | none checked | macOS: `/Applications/Google Chrome.app` exists; else `google-chrome --version` | macOS: bootstrap runs `brew install --cask google-chrome`. Linux: download page (check upstream: https://www.google.com/chrome/). |
| patchright | launches the installed Chrome for every browser tool | `patchright` dependency in `package.json`; doctor `browser-binaries` | `npx patchright --version` | `npm ci` installs the package. No browser download is needed: browsers run on the installed Google Chrome. |
| age | encrypts backups | none checked | `age --version` | `brew install age` (Ubuntu `apt install age`) |
| rclone | optional cloud mirror of backups | none checked | `rclone version` | `brew install rclone` (Ubuntu `apt install rclone`); see `docs/backup-and-restore.md` |
| launchctl / systemctl | scheduler units | none checked | macOS `launchctl help`; Linux `systemctl --user status` | built into the OS; see the scheduler unit docs. `npm run scheduler:units` only writes files and prints install commands. |

## Per-item notes

### Claude Code CLI and login

Doctor has two checks: `claude-cli` (the binary runs) and `claude-login` (`claude auth status`). Jobber has no separate API key; headless fallbacks and the scheduler use your Claude Code subscription session.

### ccgram (pinned, never upgrade it)

The exact version lives in `config/ccgram.pin.json`. Install exactly that version; the doctor and bootstrap print the command:

```bash
uv tool install --python <python version in the doctor hint> "ccgram==<version in config/ccgram.pin.json>"
```

Take the version from `config/ccgram.pin.json` and the exact command (including the Python version it passes to `uv`) from the doctor `ccgram-version` hint (`ccgramInstallHint` in `src/platform/checks.ts`). `scripts/ccgram/start.sh` runs `scripts/ccgram/check-version.sh` first, which exits non-zero if ccgram is missing or its `--version` output does not equal the pin, so the bridge refuses to start on a mismatch. Never run ccgram's own upgrade command (owner decision 2026-10-14, see CLAUDE.md "Platform and sessions"). After installing, set `installed` to `true` in the pin file when doctor's `ccgram-pin-state` warns.

### Google Chrome (the only browser)

Every browser use goes through patchright and the installed Google Chrome (`channel: 'chrome'`), launched by the one shared launcher `launchRealChrome` (`src/linkedin/browser.ts`): LinkedIn, Naukri, scout, applier and the resume PDF render (`src/pdfRender.ts`, headless Chrome printing `renderer/` HTML to an A4 PDF). Playwright's own browser downloads and its headless shell are not used and not installed, and the repo has no `playwright` dependency. Patchright's bundled Chromium and stock headless were blocked in the 2026-10-13 Naukri measurement (see CLAUDE.md "Naukri"). Doctor `chrome` is a warning, not a failure, when Chrome is missing, but then every browser tool and the PDF render fail. Headless Naukri from a VPS or datacenter IP is untested.

The test baseline has no known failures any more: `tests/renderChecked.test.ts` and `tests/resume.test.ts` render real PDFs through the installed Chrome, so they need Chrome on the machine running the tests (`config/update-known-failures.json` is `{}`; it is used by the auto-update test gate).

### age and rclone (backups only)

Backups are one age-encrypted archive; creating a backup probes `age --version` and encrypts with `age -r <recipient>`. rclone is used only when a remote is configured. Both are `report_only` in bootstrap: it tells you the install command and never installs them. Setup and key handling are in `docs/backup-and-restore.md`. Backups are off by default.

### launchctl and systemctl (scheduler units only)

`npm run scheduler:units` writes unit files under `.jobber/units` and prints the install commands (`launchctl bootstrap gui/$(id -u) ...` on macOS, `systemctl --user ...` on Linux). It installs nothing itself, and you need neither tool to run the scheduler by hand with `npm run scheduler`.

## What each optional item breaks when absent

| Missing | Effect |
|---|---|
| Google Chrome | every browser tool unavailable, the resume PDF render fails (so no outreach rows can be prepared) and the render tests fail |
| age | no backups |
| rclone | no cloud mirror; local backups still work |
| launchctl / systemctl | no unattended scheduler; run it in the foreground |

## Unverified

- Install commands and package names for Ubuntu (Homebrew and apt names) are listed in CLAUDE.md as unverified (U5, U6). check upstream.
- Exact minimum versions of tmux, git, uv, age and rclone are not enforced by code.
