# How a job gets scored (matching)

Audience: owner
Last verified against: 2c0a3aa
Source files: src/matchRubric.ts, src/score.ts, src/northStar.ts, src/northStarLoad.ts, src/roleGate.ts, config/role-families.json, .claude/skills/match-jobs/SKILL.md, .claude/agents/matcher.md, scripts/rematch-gate.ts, user-data.example/profile.json

This page explains how Jobber decides which jobs move ahead. The scoring flow is the one from the open source project career-ops, copied as closely as our setup allows. Only the jobs that score well enough get a tailored resume, a contact search, outreach and an application.

## Credit and license

The five scoring dimensions, the 1 to 5 Global score, the score bands, the North Star rule, the Cultural signals rules and the two-pass requirement table follow career-ops by Santiago Fernandez de Valderrama, https://github.com/career-ops-hq/career-ops, MIT License, copyright 2026. The text they come from is `modes/_shared.md` (Scoring System, Archetype Detection), `modes/oferta.md` (archetype step, Block A, Block B), `modes/ofertas.md` (the dimension anchors) and `AGENTS.md` (Ethical Use) in that repository. The license requires the copyright and permission notice to stay with copied text, so the notice is repeated here and at the top of the `match-jobs` skill: "Copyright (c) 2026 Santiago Fernandez de Valderrama. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction..." (the full MIT text is in the career-ops `LICENSE` file).

## The five dimensions

For each job the model scores five things, then gives one overall (Global) score. Four dimensions are numbers from 1.0 to 5.0 (one decimal). Red flags is a negative adjustment (0 when clean, down to -3.0).

| Dimension | What it measures |
|---|---|
| CV match (`cv_match`) | Skills, experience, proof points. 5 means 90 percent or more of the requirements are matched, 1 means under 40 percent. |
| North Star alignment (`north_star`) | How well the role fits your target archetypes. 5 is the exact target role, 1 is unrelated. |
| Comp (`comp`) | Salary against the market. 5 is top quartile, 1 is well below. If your own range is not set, the model uses the market for the role and never invents a number for you. |
| Cultural signals (`culture`) | Company culture, growth, stability, remote policy. If you listed what you look for in a team, a contradiction caps this at 2. |
| Red flags (`red_flags`) | Blockers and warnings, as a negative adjustment. |
| Global (`global`) | One holistic judgment across the five. There is no formula and no averaging. |

The model also gives one short evidence line for each dimension and the name of the archetype it matched. If a role matches none of your archetypes, the model says so and gives North Star alignment 1. It must not stretch the role to look like a fit.

## What moves ahead

career-ops reads the Global score like this, and so does the code:

- 4.5 and above: strong match, recommend applying immediately.
- 4.0 to 4.4: good match, worth applying.
- 3.5 to 3.9: decent but not ideal, recommend against applying unless there is a specific reason.
- Below 3.5: recommend against applying.

career-ops also says to strongly discourage applying below 4.0 of 5. So the go line is 4.0.

The stored score is the Global score itself, on the 1 to 5 scale with one decimal (`score = Global`), so 3.9 is 3.9, 4.0 is 4.0 and 4.5 is 4.5. Only an expired posting is stored as 0. The setting `MATCH_THRESHOLD` is the go line on the same scale and defaults to 4.0. Write it as `3.5`, `4` or `4.5`. For backward compatibility an old 0 to 100 value above 5 (for example `60` or `80`) is still read and divided by 20 (60 is 3.0, 80 is 4.0), and the doctor warns you to rewrite it on the 1 to 5 scale. A blank value is the default; a junk or negative value, or one above 100, falls back to 4.0 and the doctor reports it. Lowering it to 3.5 lets 3.5 to 3.9 matches through, which career-ops recommends against. The evidence ceiling and the injection cap use the same scale (an injection-suspect posting is capped at 4.4, an empty requirement table at 3.5), and a location FAIL or hard stop is stored 0.1 under the threshold. Score bands in the funnel patterns and calibration are `<3.0`, `3.0-3.4`, `3.5-3.9`, `4.0-4.4` and `4.5+`.

Until 2026-11-06 the score was stored as `round(Global x 20)` (0 to 100). The first time a database is opened by the new code it is converted once (see "Older scores").

"Moves ahead" means the job is prepared (tailored resume, contact search, drafted outreach) and queued for sending or applying, under the usual daily limits. The best-scored jobs are prepared first. Code adds three safety rules that career-ops does not have, and they stay: a location FAIL stops the job, a hard stop (a verified critical requirement you do not meet) stops the job, and the evidence ceiling can only lower a score when the model cannot back its claims with quotes from the posting. A posting that talks to an AI screener is capped at 89, so it can never be a 4.5 "apply immediately" match.

## Your North Star (archetypes)

career-ops reads your target roles from your profile file. Jobber reads them from the optional `north_star` section of `user-data/profile.json` (see `user-data.example/profile.json` for a full example):

- `archetypes`: your target roles. Each has a `name`, a `fit` (`primary` is your dream role, `secondary` is a good fit, `adjacent` is a stretch), `title_patterns` (regular expressions on the job title), and optional `title_not`, `requires_signal`, `signals` and `level`.
- `require`, `deprioritize_if_absent`: what you look for in a team (career-ops `culture_screen`). Leave `require` empty for no culture screen.
- `dealbreakers`: hard "never" rules. A match needs a posting sentence that states the fact; a missing fact never breaks a rule.
- `comp`: `currency`, `target_range`, `minimum`. Empty strings mean unknown, and the model treats them as unknown. The shipped example leaves them empty on purpose.

One list drives both the code and the model. The code role gate (`config/role-families.json` plus these archetypes) is a cheap title check that runs before any model call. It is stricter than career-ops (career-ops has no code gate, only a model judgment) and it saves model cost: a title like "Code Reviewer" or "AI Tutor" never reaches the model. When `north_star` is present, its archetypes replace the allowed families of the gate; the deny words, pay-model phrases and the backend signal stay in `config/role-families.json`. When it is missing, the families in that file are the archetypes. The matcher is meant to receive the same list as a `North Star:` line (`northStarLine` in `src/northStar.ts`); until the wake prompt appends that line, the `match-jobs` skill falls back to built-in default archetypes that equal the shipped families, so your own archetypes change the code gate first and the model prompt once the line is wired in.

## Older scores

Jobs scored before this change keep their score and stay readable. They are labelled `rubric_v2` (five keys from 0 to 20, summed) or `legacy` (four keys from 0 to 25). The stored `score_dims` of every new row carries `"rubric": "career_ops_v1"`. A new save in an older shape is refused.

**Scale migration (2026-11-06).** Every stored score used to be 0 to 100. On the first open of the database by the new code (`src/scoreScale.ts`, called from `openDb`) the database is first copied to `data.sqlite.pre-scale-<timestamp>` next to it (mode 0600, made with `VACUUM INTO`; the migration is refused if the copy fails), then in one `BEGIN IMMEDIATE` transaction every non-null `jobs.score` of every rubric (`career_ops_v1`, `rubric_v2`, `legacy`, no dimensions) becomes `round(score / 20, 1)`. The dimension values inside `score_dims` are not rescaled, and the `rubric` label stays. The marker is `PRAGMA user_version = 2` plus a `meta` row `match_scale=5`, written last. It runs once, a second open changes nothing, two processes starting together are safe, and a database that already holds only values of 5 or less just gets the marker. A database with a newer `user_version` than the code knows is refused with a clear error.

**Grandfathering.** The old rule gave `rubric_v2` and `legacy` rows the line of 60 (3.0 now). To keep that promise exactly once, the migration sets `jobs.grandfathered = 1` on (a) every older-rubric row that scored at least the old 60, and (b) every job that already has an outreach queue row (queued or prepared). A grandfathered job counts as matched whatever its new score (the "already matched" list, the funnel and the dashboard). A new match save for the job clears the flag, so a re-scored job is judged by `MATCH_THRESHOLD` like any other.

`npm run matches:regate` re-checks queued emails that have not been sent. It applies the title gate to every row, the old per-dimension minimums (`MATCH_DIM_MINIMUMS`) to `rubric_v2` rows, and the new cutoff only to `career_ops_v1` rows. It is a dry run unless you add `-- --apply`.

## Before you trust it

The scoring rules are code and tests, but the model's output has not been checked live yet. Run the first wakes in dry run and read the scores, the evidence lines and the reasons. If the scores look too strict or too loose, tell the agent what you saw; do not just change `MATCH_THRESHOLD`.
