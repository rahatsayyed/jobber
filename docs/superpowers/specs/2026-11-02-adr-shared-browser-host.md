# ADR 2026-11-02: one shared browser host for every platform and the web group

## Status

Accepted (owner decision). Built and tested with fakes only; not yet run against real Chrome or a real site.

## Context

Each platform runtime (LinkedIn, Naukri, Wellfound) launched its own headless Chrome (a state file or its own profile
`secrets/browser-profile-<name>/`), the web group (scout, applier, sources runner, contacts dork) used the profile
`secrets/browser-profile/` under `secrets/webcore.lock`, and the login commands used yet other profiles. Every MCP server
is its own OS process, so a second web process got `session_locked`, cookies and history were split over four profiles,
and headed and headless use did not share state.

## Decision

1. ONE persistent profile, `secrets/browser-profile/`, for all of them.
2. ONE long-lived host process (`scripts/browser-host.ts run`, `src/webcore/hostServer.ts`) owns it. Chrome is started
   with `--remote-debugging-port=0` on loopback; the endpoint goes only into the 0600 pidfile `secrets/browser-host.json`.
   Every client (`src/webcore/hostClient.ts`) attaches with `connectOverCDP` and opens its OWN tab; its `close()` closes
   only its tabs. Clients write a lease file; the host exits after `BROWSER_HOST_IDLE_MIN` minutes with no live lease,
   at once on the kill switch, and refuses new tabs during an `all` halt.
3. Headed and headless on the same profile: an owner window command asks a headless host with no client to hand over
   (`SIGUSR1`, it exits), starts the host headed, and stops it (`SIGTERM`) when done; the next task starts it headless.
   While headed, task clients get `session_locked`. Chrome allows one process per profile directory, so there is never
   a second Chrome on it.
4. Extensions are allowed in general (`--disable-extensions` is dropped in both modes; nothing relies on
   `--load-extension`, which branded Chrome 137+ ignores).
5. The resume PDF render, the session checks and the anonymous Naukri code-pass search keep a throwaway browser.
6. Platform locks stay; the web group's per-host gap is shared across processes by file instead of the web lock.
7. When the host is off (`BROWSER_HOST=false`), on Windows, or cannot be started or attached, every runtime falls back
   to exactly the old behaviour.

## Consequences

- No more `session_locked` between scout, applier and the other web processes; LinkedIn, Naukri and Wellfound see the
  same cookies as the owner's window.
- A local process running as the owner that reads the pidfile or finds the loopback port can drive the logged-in
  browser while the host runs (same trust boundary as the profile directory).
- Extensions installed in the old per-platform profiles must be installed again in the shared profile.
- A wake has to wait while the owner has the window open (as with the old web lock).

## Rollback

Set `BROWSER_HOST=false` in `.env` and restart the MCP servers (and run `npm run browser:host -- stop`). Every runtime then
uses its own browser as before; the old per-platform profiles and the state files are untouched by this change.
