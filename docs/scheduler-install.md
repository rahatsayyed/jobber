# Scheduler install (launchd and systemd)

Audience: owner
Last verified against: cc51247
Source files: scripts/scheduler-units.ts, src/scheduler/units.ts, scripts/scheduler.ts, src/scheduler/driver.ts, src/platform/checksScheduler.ts, src/stack/up.ts, src/stack/down.ts, src/stack/plan.ts, .env.example, package.json

This page is for running the scheduler daemon as a service that starts at login and restarts
itself, instead of by hand or through `npm run up`. It covers macOS (launchd) first and Linux
(systemd user unit) as a variant. Windows is not covered.

Nothing here installs itself. `npm run scheduler:units` only writes text files and prints
commands. You run the commands.

Do the rollout first: start in dry mode and only go live phase by phase, see
[rollout.md](./rollout.md). For stop, resume and halts see [operations.md](./operations.md).

## Do you need this

You need it only if you want the scheduler to survive a reboot or a crash without you. Two other
ways to run it exist and are simpler:

- `npm run up` starts the scheduler in a tmux window named `scheduler` (session from
  `STACK_TMUX_SESSION`) and `npm run down` stops it.
- `npm run scheduler -- --daemon` runs it in your terminal.

If a launchd or systemd unit is already loaded, `npm run up` skips starting its own scheduler and
prints that a unit is loaded. `npm run down` does not stop a unit; it prints how to stop it
yourself. Do not run both a unit and a hand-started daemon (the scheduler takes a shared run lock,
but one owner of the process is easier to reason about).

## Generate the unit files

```bash
npm run scheduler:units
```

Writes two files under `.jobber/units/` (mode 600, directory mode 700) and prints the install
commands. The files are `dev.jobber.scheduler.plist` (launchd) and `jobber-scheduler.service`
(systemd). It never runs the commands and never writes outside the project root.

Options, passed after `--`:

```bash
npm run scheduler:units -- --node /absolute/path/to/node --out .jobber/other-dir
```

- `--node` sets the node binary written into the unit. The default is the node that ran the
  command. Use the absolute path of the node you want the service to use (a version manager shim
  path is a bad choice: pick the real binary).
- `--out` must resolve inside the project root, otherwise the command fails.

Run it from the project root: the unit's working directory is the directory you ran it from.

## Review the generated files

Open both files and check:

- The program is your node binary, then `<project>/node_modules/tsx/dist/cli.mjs`, then
  `scripts/scheduler.ts --daemon`. That means `npm install` must have been run in that project
  (the `tsx` file must exist).
- The working directory is the project root.
- The only environment variable in the unit is a fixed `PATH` (the node directory plus
  `/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin`). No secrets are written in
  the unit. The daemon reads `.env` itself.
- Output goes to `.jobber/logs/scheduler.log` (stdout and stderr both).
- launchd: `RunAtLoad` and `KeepAlive` are true with a throttle interval. systemd:
  `Restart=always` with `RestartSec=30`, `WantedBy=default.target`.

The path values must be absolute and must not contain control characters. For systemd they must
also contain no whitespace, quotes, `%`, `$` or backslash. A project path with a space cannot
become a systemd unit; the generator fails with a message.

## Install on macOS (launchd)

Run the commands the generator printed, as printed. Their shape, with placeholders:

```bash
mkdir -p "<project>/.jobber/logs"
launchctl bootstrap gui/$(id -u) "<project>/.jobber/units/dev.jobber.scheduler.plist"
```

Expected: no output, and the daemon starts at once (`RunAtLoad`).

Check it is loaded:

```bash
launchctl list | grep dev.jobber.scheduler
```

Expected: one line with the label `dev.jobber.scheduler`. `npm run up` and `npm run down` detect a
loaded unit by looking for this label in `launchctl list`.

Unload (stop and remove from launchd):

```bash
launchctl bootout gui/$(id -u) "<project>/.jobber/units/dev.jobber.scheduler.plist"
```

Expected: the daemon stops and the label disappears from `launchctl list`. The generator does not
print an uninstall command; `bootout` is the counterpart of `bootstrap`, check upstream:
`man launchctl`. Note that `npm run down` prints a different hint
(`launchctl unload ~/Library/LaunchAgents/dev.jobber.scheduler.plist`); that path assumes you
copied the plist there, which the generator's commands do not do. See "Known issues" below.

## Install on Linux (systemd user unit)

Run the commands the generator printed, as printed. Their shape:

```bash
systemctl --user link "<project>/.jobber/units/jobber-scheduler.service"
systemctl --user enable --now jobber-scheduler.service
```

Expected: `link` creates a symlink into your user unit directory, `enable --now` starts the unit
and enables it for the default target.

Create the log directory first, because the unit appends to a file under it:

```bash
mkdir -p "<project>/.jobber/logs"
```

The generator prints this `mkdir` only in its macOS block, so run it yourself on Linux.

Check it:

```bash
systemctl --user status jobber-scheduler.service
```

Expected: `active (running)`. `npm run up` detects the unit with
`systemctl --user is-active jobber-scheduler.service`.

Start at boot without a login session: neither the generator nor the code mentions
`loginctl enable-linger`. check upstream: systemd documentation for user services and linger.

Uninstall:

```bash
systemctl --user disable --now jobber-scheduler.service
```

Expected: the unit stops and is disabled. This is the same command `npm run down` prints.
Removing the symlink that `link` created is not printed by the generator: check upstream:
`man systemctl` (`link` and `disable`).

## Verify

```bash
npm run scheduler -- --status
```

Expected: prints the next wake time, usage backoff, whether the kill switch is on, any halted
platform, the open escalation count and the last runs with their status and a `dry=` flag. It
opens the database read-only and fails if the database file does not exist yet.

```bash
npm run scheduler -- --dry-run-plan
```

Expected: prints the plan for a wake right now as JSON (what the planner would do given the kill
switch, halts, ceilings and due work). It launches nothing.

```bash
npm run doctor
```

Expected: the scheduler checks are `scheduler: tmux >= 3.2`, `lock dir writable`,
`STOP file absent or reported`, `dry run state`, `units generated` and `agents: worker tool lint
ok`. `units generated` shows skip until `npm run scheduler:units` has run. `dry run state` is a
warning when the scheduler is live; that is information, not a fault.

To run exactly one wake by hand (it forces a wake even before the planned time):

```bash
npm run scheduler -- --once
```

Expected: one line with the run id, its status and the next wake time. In dry mode nothing real is
sent. Only run it when you mean it and the dry flags are what you want.

## Start in dry mode first

The scheduler is dry unless every flag says otherwise. `.env.example` ships
`SCHEDULER_DRY_RUN=true`. A LinkedIn path also needs `LINKEDIN_DRY_RUN=false` to go live, and
the Gmail dry flag (see the dry run rules in `CLAUDE.md`, "Outreach safety layers") must not be on. Leave all of them dry when you first install the unit, watch
`npm run scheduler -- --status` and `npm run dry-run:report`, and only then follow the phases in
[rollout.md](./rollout.md).
Dry flags are changed by the owner only, see `CLAUDE.md` "Safety" rule 15. `npm run up -- --status`
shows `unit loaded` for the scheduler when the launchd or systemd unit is loaded.

`SCHEDULER_ENABLED=false` makes the daemon exit at start. Under launchd or systemd the unit will
then restart it every throttle or restart interval, so to pause a unit use the unload command
above, not this flag.

## Logs

- Service output: `.jobber/logs/scheduler.log`.
- Wake runs: the wake windows live in the tmux session named by `SCHEDULER_TMUX_SESSION`
  (`.env.example` default `jobber-runs`). `tmux attach -t <session>` to watch one.
- Run history and status: `npm run scheduler -- --status`.
- Notifications and escalations: `.jobber/notify.jsonl` and the `escalations` table.

## Change settings

The daemon reads the environment and `.env` once at start. After you edit `.env`, restart the
daemon: on macOS `launchctl bootout` then `launchctl bootstrap` again, on Linux
`systemctl --user restart jobber-scheduler.service`. Restart Claude sessions after an applied
update too, because MCP servers keep old code (see `CLAUDE.md`, "Platform and sessions").

## Upgrade

After pulling a new version, or when your node path or project path changed:

1. Unload the unit (commands above).
2. `npm install` if dependencies changed.
3. `npm run scheduler:units` again. It overwrites the two files in `.jobber/units/`.
4. Review them, then install again with the printed commands.
5. `npm run scheduler -- --status` and `npm run doctor`.

If only code changed and the paths did not, a restart of the unit is enough.

## Kill switch and the units

The kill switch is independent of the unit manager:

```bash
npm run jobber:control -- stop "reason"
```

Expected: writes `.jobber/STOP` and sets halts for `all`, `linkedin` and `naukri`. The running
daemon sees it and ends its wake window within one poll; later wakes are skipped as `killed`.
The unit itself keeps running (launchd or systemd does not know about STOP), so the daemon idles
rather than exiting. `npm run jobber:control -- resume` removes STOP and clears only the halts
whose reason carries its own stop prefix. Details and the halt table are in
[operations.md](./operations.md).

Use the unload command when you want the process itself gone, and the kill switch when you want
all sends refused everywhere, including by hand.

## Known issues

- Printed uninstall hint mismatch: `npm run down` prints
  `launchctl unload ~/Library/LaunchAgents/dev.jobber.scheduler.plist`, but the generator installs
  with `launchctl bootstrap` from the `.jobber/units/` path and never copies the plist into
  `~/Library/LaunchAgents`. Use the `bootout` command on the same path you bootstrapped.
- The generator prints the `mkdir` for the log directory only in the macOS block.
- No unit has been exercised against a real launchd or systemd in this repo (unit text is covered
  by unit tests with fakes). Treat the first install as supervised: unverified.
