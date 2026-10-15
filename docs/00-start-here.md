# Start here: from clone to first supervised send

Audience: owner
Last verified against: <fill at merge>
Source files: package.json, scripts/setup.ts, scripts/bootstrap.sh, scripts/stack.ts, scripts/dry-run.ts, scripts/dry-run-report.ts, scripts/linkedin-seed-person.ts, src/setup/steps/index.ts, src/setup/skips.ts, README.md

This page is the ordered map. Each row points to the page that holds the detail; it does not
repeat it. Time estimates are rough author ranges, labelled `estimate, not measured`.

The first send is always supervised and under low ceilings. Read the safety layers in
`CLAUDE.md` section `Outreach safety layers` and the dry-run rule in `CLAUDE.md` section `Safety`
before you flip anything live. Nothing on this path flips a dry-run flag for you.

## The path

| # | Step | Command | Time (estimate, not measured) | Who | Done when |
|---|---|---|---|---|---|
| 1 | Check prerequisites ([prerequisites.md](prerequisites.md)) | see page | 10 to 30 min | owner only (installs may need sudo) | every tool on the page reports a version |
| 2 | Clone and install dependencies | `npm install` | depends on network | agent can run | command exits 0 |
| 3 | Install what is missing | `bash scripts/bootstrap.sh` | 10 to 30 min, depends on network | owner only (it asks before installing; sudo is yours) | the printed table has no missing item you need |
| 4 | Run the wizard, agent or terminal mode ([setup-modes.md](setup-modes.md)) | `npm run setup` | 30 to 90 min | owner only (secrets, logins, consent) | `npm run setup -- --status` shows every step done or skipped |
| 5 | Check health | `npm run doctor` | 1 to 3 min | agent can run | no `fail`; every `warn` is understood |
| 6 | Create API keys ([api-keys.md](api-keys.md)) | `npm run setup -- --step apikeys` | 15 to 45 min | owner only (key creation) | the `api-keys` doctor check is ok or skipped by choice |
| 7 | Edit config: portals, target regions, languages ([config-reference.md](config-reference.md)) | edit `config/portals.json`, `config/target-regions.json`, `user-data/languages.json` | 15 to 30 min | owner only (your choices) | `confirmed` is `true` in `user-data/languages.json` once the list is true |
| 8 | Dry-run end to end | `npm run dry-run` | 5 to 15 min | agent can run | it ends without a failed stage |
| 9 | Read the dry-run report | `npm run dry-run:report` | 10 to 20 min | owner only (you judge the output) | you read every recorded action and nothing surprised you |
| 10 | Fetch, pin and fit the classifier ([classifier-models.md](classifier-models.md)) | `npm run setup -- --step classifier` then `npm run classifier:fit` | download depends on network, fit 5 to 15 min | owner only (licence, pin review) | doctor checks `classifier_model` and `classifier_smoke` are ok |
| 11 | Enable sessions ([telegram-bot-setup.md](telegram-bot-setup.md), [gmail-mcp-setup.md](gmail-mcp-setup.md), [linkedin-sessions-setup.md](linkedin-sessions-setup.md), [naukri-session-setup.md](naukri-session-setup.md)) | `npm run setup -- --step sessions`, `npm run linkedin:login` | 20 to 60 min | owner only (QR, password, consent) | doctor session checks are ok |
| 12 | Dashboard sign-in ([dashboard-login.md](dashboard-login.md)) | `npm run dashboard -- token` | 5 min | owner only | you can sign in on loopback |
| 13 | Canary send, supervised, low ceilings | `npm run linkedin:seed` with `--url`, `--name`, `--company`, `--category`, then one send you watch | 30 to 60 min | owner only (you watch it) | the one message arrived at the person you chose and a row exists in the DB |
| 14 | First supervised `/runhunt` | `/runhunt` in the hunt window | 20 to 60 min | owner only (read resumes, emails, ATS lines yourself) | summary arrives on Telegram and you reviewed the first outputs |
| 15 | Start the stack | `npm run up` | 5 min | agent can run | the table shows every started component; `MODE:` line is the one you intended |
| 16 | Install the scheduler units ([scheduler-install.md](scheduler-install.md)) | `npm run scheduler:units` and the printed install commands | 10 to 20 min | owner only (installs system units) | units listed by launchd or systemd |
| 17 | Walk the rollout phases ([rollout.md](rollout.md)) | per phase | days (rollout is phased over days) | owner only (you raise ceilings) | each phase's exit criteria are met before the next |

## Notes per step

- Step 3: `scripts/bootstrap.sh` is the entry point before Node exists; `npm run bootstrap` is
  the same CLI afterwards.
- Step 4: wizard step ids, in order, from `src/setup/steps/index.ts`: `prereqs`, `claude`,
  `telegram`, `gmail`, `apikeys`, `sessions`, `resume`, `profile`, `limits`, `access`,
  `classifier`, `dashboard`, `final`. Run one with `npm run setup -- --step <id>`; list them with
  `npm run setup -- --list`. `telegram`, `dashboard`, `gmail` and `apikeys` can be skipped
  (`src/setup/skips.ts`); a skip is recorded, never silent.
- Step 5: the doctor never prints secret values. Safety checks (classifier, permission set,
  hooks, limits, kill switch, halts) are never skipped.
- Step 8: dry run uses fixtures and a temporary database and sends nothing.
- Step 10: the model download size is large (see the page); fitting is required before any live
  send. Dry runs work without a fit.
- Step 13: seeding registers one person so the typed LinkedIn send tools accept them. Keep
  ceilings low through `npm run setup -- --step limits` (limits are explained by
  `npm run status -- limits`, not repeated here). Live LinkedIn and Naukri paths are
  live-unverified (see `CLAUDE.md` section `Known limits and not yet live-verified`), which is
  why this step is supervised.
- Step 15: `npm run down` stops the stack. `up` refuses while the kill switch is set.

## If something is red

Open [operations.md](operations.md): it has the failure table, stop and resume, halts, dry-run
status and logs. Run `npm run doctor` first and read the fix line printed next to the failing
check. To stop everything at once, the kill switch is `npm run jobber:control -- stop`.

## Map of the other docs

- [prerequisites.md](prerequisites.md): tools and versions, how to verify each.
- [setup-modes.md](setup-modes.md): bootstrap, wizard modes, dry-run, up and down.
- [api-keys.md](api-keys.md): Adzuna, Serper, Hunter, Gmail, Telegram, where each goes.
- [config-reference.md](config-reference.md): every owner-edited file in `config/` and `user-data/`.
- [dashboard-login.md](dashboard-login.md): dashboard sign-in modes and recovery.
- [rollout.md](rollout.md): the five rollout phases with exit criteria.
- [operations.md](operations.md): stop, halts, dry run, status, logs, failure table.
- [scheduler-install.md](scheduler-install.md): launchd and systemd units.
- [layout-memory.md](layout-memory.md): the `npm run layout` owner page.
- [architecture.md](architecture.md): diagram, state stores, where to look when X breaks.
- [telegram-bot-setup.md](telegram-bot-setup.md), [gmail-mcp-setup.md](gmail-mcp-setup.md), [linkedin-sessions-setup.md](linkedin-sessions-setup.md), [naukri-session-setup.md](naukri-session-setup.md): per-service setup.
- [classifier-models.md](classifier-models.md): model profiles, licences, fit.
- [telegram-slash-commands.md](telegram-slash-commands.md): the slash commands.
