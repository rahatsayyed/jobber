# ADR-001: Agent-driven browser runtime for LinkedIn and Naukri

**Status:** Accepted
**Date:** 2026-10-13
**Deciders:** Jane Doe (owner)
**Requirements:** `2026-10-08-agent-browser-outreach-requirements.md`

## Context

The scripted LinkedIn tools (`connect.ts`, `discover.linkedin_*`, `apply.linkedin`) keep
failing: selector rot, a false-positive connection status (the notification-bell check), the
recipient-name check misfiring, and `catch -> []` hiding empty discovery results. Every fix is
reactive. Naukri already runs the other way: the `naukri` MCP gives Claude generic browser tools
and a compact text state, and a real NetApp application went through that way.

Constraints that shape the choice:
- Real (main) LinkedIn account, so ban risk is the dominant cost.
- Fully autonomous sending, so the agent holds send tools while reading untrusted text.
- Claude subscription, no API key (the headless `claude` CLI is the only model access), so
  usage limits cap how much agent time exists per day.
- Mac first for end-to-end tests, then a VPS for live runs.
- Stable-layout ATS sites (Greenhouse, Lever, Workday, Ashby) and Gmail stay scripted.

## Decision

Replace the scripted LinkedIn tools with an agent-driven runtime built on the Naukri pattern,
and use the same runtime for Naukri messaging. Five parts:

1. **Browser layer:** one MCP server per platform (`linkedin`, `naukri`) on Patchright with a
   persistent profile and a real installed Chrome, headless for now (the Naukri recipe:
   `--headless=new`, real Chrome UA). Headed Chrome under xvfb is deferred to a later phase and
   will be tested then. Generic tools only: open, state, click, type, scroll, screenshot
   (fallback). State is a compact text snapshot, not selectors.
2. **Narrow action tools for anything irreversible.** Reading and navigation are free-form.
   Sending a connection request or message, submitting an apply, and similar actions go through
   separate typed tools that enforce the rules in code: recipient and thread checked against
   SQLite, `resume.check_text` on the text, ceilings, quiet hours, cooldowns, per-company limits,
   and a verification that the action really happened. The model cannot bypass these by clicking.
3. **Prompt-injection defense in four cheap layers, no LLM sanitizer** (an extra model call per
   page costs too much against subscription limits). Checked on input and again on output:
   1. *Input code gate:* strips hidden text (`display:none`, zero-width characters, tiny fonts,
      HTML comments, `<system>`-style tags), caps length, and regex-matches injection and
      exfiltration phrases. A hit drops the field or skips the contact.
   2. *Small local classifier on free text* (profile About, replies, job descriptions): a
      CPU-only model run locally with no per-call cost, chosen for small size and speed.
      Decided: Llama Prompt Guard 2 22M (English, 512-token window, so long text is chunked).
      No fallback model. Thresholds are fitted on our own injection corpus, and latency and
      memory are measured on the Mac and the VPS. A hit halts that thread. Never the only layer.
   3. *Least privilege plus blocking hooks:* the scheduled `claude` run gets only the platform
      MCP tools (no Bash, no file read, no web fetch, secrets absent from its environment).
      Claude Code `PreToolUse` hooks deny any tool or action outside an allowlist, as a second
      barrier behind `--allowedTools`. A hidden "send the ENV file" has no tool to use.
   4. *Output gate in code* on every send: recipient and thread match SQLite; text passes
      `resume.check_text`; any URL, email, path or secret-shaped string not on an allowlist
      blocks the send; an overlap check against the raw page catches copied payloads.
4. **Random scheduler outside the model.** A small process (launchd on the Mac, systemd or cron
   on the VPS) draws random wake times, burst sizes and waits, skips quiet hours, and launches a
   fresh bounded `claude` run per wake. Pacing lives in code, not in prompts.
5. **SQLite as the source of truth** for people, stages, messages, variants, cooldowns and
   per-company counts, extending the existing outreach, connection and outcome tables.

```
 scheduler (random wake, quiet hours, ceilings)
      |  launches bounded run
      v
 actor agent (MCP tools only; hooks + allowedTools block everything else)
   |  free reads/navigation          ^ page text after input gate + classifier
   v                                 |
 linkedin / naukri MCP (Patchright, headless persistent profile) -- text state
   |  irreversible actions only via typed tools
   v
 gated tools: check recipient vs SQLite, check_text, caps, cooldown, quiet hours, verify sent
   v
 SQLite (people, stages, touches, variants, cooldowns, company counts, halt flags)
```

## Options considered

### Option A: Patchright agent on generic browser tools (chosen)
| Dimension | Assessment |
|---|---|
| Complexity | Medium: new MCPs, scheduler, sanitizer |
| Cost | Model time per action; subscription limits are the cap |
| Selector rot | Largely removed (no site selectors) |
| Ban risk | Reduced by human-like pacing and real Chrome, not eliminated |
| Team familiarity | High: the Naukri MCP is the template |

**Pros:** survives UI changes, matches the working Naukri result, safety stays enforceable in code.
**Cons:** non-deterministic, slower and costlier per action than scripts, depends on model quality.

### Option B: Claude-in-Chrome extension
| Dimension | Assessment |
|---|---|
| Complexity | Low to start |
| Cost | Same model cost |
| Ban risk | Lowest (your real browser) |
| Team familiarity | Medium |

**Pros:** real browser, real session, hardest to detect.
**Cons:** needs your Chrome open and a desktop session, cannot run unattended on a VPS, weaker
control over where irreversible actions go. Kept as a manual fallback only.

### Option C: Keep scripts and add the Claude fallbacks already in the repo
| Dimension | Assessment |
|---|---|
| Complexity | Low (exists) |
| Cost | Cheapest per action |
| Selector rot | Still the failure mode; fallbacks only help at click misses |

**Pros:** fastest, deterministic, no new infrastructure.
**Cons:** the problem we are leaving. The hybrid fallback is off by default and covers only
button-click misses, not status logic, discovery parsing or message flow.

### Option D: Custom MCP that runs its own Claude loop internally
**Pros:** tidy tool surface (`search_jobs`, `send_connect`).
**Cons:** a hidden agent loop inside a tool is hard to test, hard to cap, and duplicates the
orchestrator. Rejected.

## Trade-off analysis

- Reliability vs determinism: we trade script speed and determinism for resilience. Mitigation:
  irreversible steps stay in typed code paths with verification.
- Ban risk is the dominant cost and no option removes it. Option A lowers it with pacing, jitter,
  quiet hours, per-week ceilings and a kill switch, and the owner has accepted the residual risk.
- Autonomy vs injection: least privilege, blocking hooks and the output gate mean a poisoned
  profile or reply cannot cause a send to an arbitrary recipient, cannot read files or secrets,
  and cannot put unlisted URLs or addresses in a message. The remaining risk is injected text
  subtly steering message wording, bounded by the output gate and the fact gate. Detection layers
  (code gate, classifier) reduce it but miss paraphrases, so they are not the only barrier.
- Model access: with only the subscription, a heavy day of agent runs can hit usage limits. The
  scheduler must treat "usage limit reached" as a halt, not an error to retry.

## Consequences

**Easier:** no selector maintenance for LinkedIn and Naukri; one pattern for both platforms; the
funnel, outcomes and reply handling stay one system; schedule and limits are config.

**Harder:** testing non-deterministic behavior (needs dry-run mode, recorded page snapshots, an
injection corpus); running a scheduler process on the VPS; keeping sessions alive per machine.

**Revisit:**
- Prompt Guard 2 22M thresholds and latency: no source found gives verified CPU latency, so
  measure locally. It is English-only, so Arabic or other non-Latin profile text may slip
  through, which is another reason it is never the only layer. If it misses too much on our
  corpus, revisit the model choice then.
- Headed Chrome under xvfb (planned for a later phase) vs headless, per platform.
- Per-wake model cost against subscription limits, after the first week of data.
- Naukri headless from the VPS IP (tested only from a home IP).
- The salary-floor rule, once the first dry run shows exclusion counts.

## Rollout (each phase gated on the previous)

1. **Mac, dry run:** all gated tools log instead of act. Verify state parsing, sanitizer, scheduler
   randomness, ceilings, quiet hours, per-company limit, stage machine. No sends.
2. **Mac, read-only live:** discovery and reply detection on the real accounts; compare with
   what a human sees.
3. **Mac, canary sends:** a handful of real sends with a temporary Telegram approval step, to
   check recipient verification, pacing and message quality. The approval step is rollout-only;
   the end state is fully autonomous as decided.
4. **Mac, autonomous:** full cadence for several days, watching for warnings and blocks.
5. **VPS cutover:** re-check Naukri headless from that IP, re-create sessions there, repeat 2
   to 3 briefly, then go live.

## Action items

1. [ ] Retire `connect.ts`, `discover.linkedin_*` and `apply.linkedin` from the pipeline once the
   new runtime passes phase 3 (keep the code until then).
2. [ ] Build the `linkedin` MCP on the `naukri` MCP's tool shape.
3. [ ] Build the typed action tools with SQLite recipient checks and `check_text`.
4. [ ] Build the input code gate, the output gate, the Claude Code blocking hooks and the
   `--allowedTools` allowlist, plus the injection test corpus. Then run Prompt Guard 2 22M on
   that corpus, fit its thresholds, and measure latency and memory on the Mac and the VPS.
5. [ ] Build the random scheduler with quiet hours, ceilings and halt flags.
6. [ ] Extend SQLite: people, stages, touches, variants, cooldowns, company counts, halt flags.
7. [ ] Wire `naukri` into `sender` / `apply.auto` using the same gated tools.
8. [ ] After phase 3, batch the CLAUDE.md updates (Safety rules 3, 6, 10, HN rule, Preferences,
   new env vars, new commands).
9. [ ] Replace `.env` ceilings (`MAX_CONNECTS_PER_DAY=200`, `MAX_APPLIES_PER_DAY=100`) with the
   new per-platform limits.
