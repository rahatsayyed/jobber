# Layout memory

Audience: owner
Last verified against: cc51247
Source files: scripts/layout.ts, src/layout/summary.ts, src/layout/vocab.ts, src/layout/render.ts, src/layout/store.ts, src/layout/classify.ts, src/layout/types.ts, src/layout/config.ts, scripts/status.ts, .env.example

Layout memory is a small file per platform that records what the LinkedIn and Naukri pages looked like the last times the code parsed them, so the scheduled operators can skip exploratory reads when a page matches and stop when a page has drifted. It is not HTML and nothing in it is written by the model: it holds only ids from a closed vocabulary (`src/layout/vocab.ts`: page kinds, landmark ids, count keys, action labels), integers, dates and run ids, so page text can never reach it. It is advisory on reads and, only in `enforce` mode, a precondition for the irreversible typed tools.

The commands below are offline: they start no browser and make no network call. Status, show and learn never write anything.

## What the verdicts mean

The `layout=` token on `linkedin_open`, `linkedin_snapshot` and the Naukri snapshot header carries one of these. It is telemetry: since the browserctl rebuild (live-unverified) no verdict stops an operator, which adapts by snapshot, scroll, screenshot, pointer and escalation instead.

| Verdict | Meaning | What you do |
|---|---|---|
| `match` | Known layout, landmarks present. | Nothing. |
| `partial` | Some landmarks missing. | Nothing at first; if it persists run `npm run layout -- status` and watch the drift counters. |
| `drift` | A learned landmark is gone. | Repeated drift escalates and may halt (see below). Look at the page in a headed session. |
| `unknown` | Kind or variant not learned yet. | Run the learning checklist below. |
| `blocked` | Bot wall or access denied. Not a layout problem. | Follow the platform halt rules, see `docs/linkedin-sessions-setup.md` and `docs/naukri-session-setup.md`. |
| `logged_out` | Login wall. Not a layout problem. | Log in again with the session scripts. |
| `unloaded` | Page not fully loaded or too short. | Nothing; the operator retries. A LinkedIn profile with no extracted name is also `unloaded`, never drift, never learned. |

Per kind, the stored state is `learning`, `stable`, `stale` (not verified for `LAYOUT_STALE_DAYS`) or `drifted`.

## Check the summary

```bash
npm run layout -- status
```

Prints one block per platform (linkedin, then naukri) and exits 0. `npm run status -- layout` prints the same summary. Synthetic example:

```
linkedin: enforce=warn updated=2026-10-15 age=0d
  profile: stable variants=1 hit=96% drift_streak=0 drift_total=1 verified=0d ago
  search: learning variants=1 hit=n/a drift_streak=0 drift_total=0 verified=never
naukri: enforce=warn
  no layout memory yet
```

`HALTED(layout_drift)` after the enforce value means an old `layout_drift:*` halt row is still present (the LinkedIn and Naukri tools no longer write new ones). `INVALID` means the file failed validation; the runtime quarantines it on its next load.

## Show what the operator sees

```bash
npm run layout -- show linkedin
```

Prints the compact memory text given to the operator (one line per kind, vocabulary ids only) and exits 0, or exits 1 with `layout memory invalid` when the file is bad. Platform is `linkedin` or `naukri`. Synthetic example:

```
profile: stable v1 verified 2026-10-14 ok=41 fail=0 drift=0 | needs: profile.name profile.headline action:connect
```

Check that only vocabulary ids appear. The text is capped by `LAYOUT_RENDER_MAX_CHARS`.

## Check learning progress

```bash
npm run layout -- learn naukri
```

Prints the learning-run instructions and, for each variant not yet promoted, `<kind> variant <id>: obs N/<needed> runs N/<needed>`. It starts nothing; it only reads the file. A variant is promoted after `LAYOUT_PROMOTE_N` observations across `LAYOUT_PROMOTE_RUNS` distinct run ids. Promoted variants are never evicted automatically.

## Reset a kind or the whole memory

```bash
npm run layout -- reset linkedin --kind profile
```

Asks you to type `yes`, then moves that kind (or, without `--kind`, the whole file) aside to `<platform>.json.reset-<time>`, so nothing is deleted. Add `--yes` to skip the prompt. Exit 1 with "nothing to reset" when no file exists. An unknown `--kind` exits 2 and lists the valid kinds for that platform.

Reset when a page really changed for good, or when a bad steady state was learned. A third distinct layout is not learned until you reset (promoted variants are not auto-evicted).

## Clear a layout halt

```bash
npm run layout -- clear-halt linkedin
```

Clears only a halt whose reason starts with `layout_drift:`, resets that kind's drift streak, and prints `cleared linkedin layout halt.` Drift totals are kept. It refuses (exit 1) when the halt is some other reason, or when the reason comes from the global `all` halt.

For any other LinkedIn halt (checkpoint, CAPTCHA, restriction) use `npm run linkedin:clear-halt`; for the kill switch and `all` halts use `npm run jobber:control -- resume`. Only you clear halts; no agent does.

## Enforce modes

Set `LAYOUT_ENFORCE` in `.env` (default and range in `.env.example`).

| Mode | Behaviour |
|---|---|
| `off` | Layout gate disabled. |
| `warn` | Tools add a `layout=` note and proceed. Drift is recorded and escalated, no halt. |
| `enforce` | Affects only the LinkedIn data tools (`linkedin_find_profiles`, `linkedin_search_jobs`, `linkedin_search_posts`, scoped by the tool-requirements table in `src/layout/vocab.ts`) and the ATS applier pages: an unverified or drifted page refuses the read. It no longer gates any send, connect, accept or apply: those tools are gone, and their safety is the arm tool, the semantic guard and the live re-verification (see CLAUDE.md, "Connecting"). |

Recommended path: stay on `warn`; `enforce` now matters only for the data tools and ATS pages. To roll back, set `LAYOUT_ENFORCE=warn` (or `off`) and restart sessions; then run `npm run layout -- clear-halt <platform>` if an old layout halt is still active.

## Supervised learning run

Steps marked `[owner]` need you watching a real session.

1. [owner] Fully quit and restart Claude Code and the ccgram windows (new agents and MCP tool names load only on restart).
2. Confirm the store is git-ignored with `git check-ignore .jobber/layout/linkedin.json`.
3. Keep the dry-run flags on and `LAYOUT_ENFORCE=warn`. Do not flip a dry-run flag for this.
4. [owner] Trigger two scheduler wakes while logged in, so two distinct run ids exist: covering a LinkedIn profile and a search page, and for Naukri a search and a thread page. Promotion needs at least two run ids.
5. Run `npm run layout -- status`: each visited kind should reach `stable`. If not, `npm run layout -- learn <platform>` shows missing observations or runs.
6. Run `npm run layout -- show linkedin` and check only vocabulary ids appear.
7. [owner] Expect to tune the minimum-landmark and critical-landmark tables in `src/layout/vocab.ts`; that is a code change, not a setting.
8. [owner] Switch to `LAYOUT_ENFORCE=enforce` only after a clean stretch on `warn` with no drift on critical kinds and `npm run doctor` `layout_enforce` warning "warn mode can be tightened" (every critical kind stable with zero drift); "not ready to enforce yet" means keep waiting.

## Drift escalation and halt

`LAYOUT_DRIFT_ESCALATE_N` drift observations within `LAYOUT_DRIFT_WINDOW_HOURS` write an owner info escalation and a notification. For LinkedIn and Naukri drift is telemetry only and writes no halt. A `layout_drift:<kind>` halt (streak of `LAYOUT_DRIFT_HALT_N` and two run ids, under `enforce`) can still come from an ATS `ats_<id>` file; in `warn` and `off` the same event records a `layout_drift_halt` escalation (detail ends `mode=warn` or `mode=off`) and halts nothing. Block pages, CAPTCHAs and checkpoints still halt a platform, independently of layout.

When halted:

1. [owner] Look at the page in a headed session (see `docs/linkedin-sessions-setup.md`).
2. If the layout genuinely changed: `npm run layout -- reset <platform> --kind <kind>`.
3. `npm run layout -- clear-halt <platform>`.
4. Relearn that kind with the checklist above.

## Corrupt or invalid files

The runtime never throws on a bad file. It moves it aside as `<platform>.json.corrupt-<time>` (only the newest few are kept) and starts an empty layout, so the platform returns to `unknown` and relearns. Unknown vocabulary ids quarantine the whole file by design, which means a vocabulary change after an update wipes memory once. A file larger than `LAYOUT_MAX_BYTES` is not grown. `npm run layout -- status` shows `INVALID` before the runtime does this; you can also `reset` it yourself.

## Settings

All `LAYOUT_*` keys, their ranges and defaults are in `.env.example`; do not copy values from here. `LAYOUT_EXPLORE_BUDGET` is parsed only and not enforced. `LAYOUT_DIR` must resolve inside the project, otherwise the default is used. Invalid values fall back to the default.

## Limits

Unverified against live sites: the landmark rules come from the parsed snapshot shape and have only run against fixtures and unit tests with fakes, not against real LinkedIn or Naukri pages. The Naukri `chat.input` landmark rests on the live-unverified `chatbot_Drawer` selector. The memory sees the code's view of the page, not the DOM: a change the extractors parse identically is invisible, and `shell` is a proxy. Auto-promotion can learn a bad steady state; use `reset`. Naukri's Akamai blocks are sensitive: observation adds no navigation and no probe pages exist.
