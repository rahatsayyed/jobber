# career-ops import report

Generated 2026-10-16 by `npx tsx scripts/import-career-ops.ts` from a local checkout. Source: https://github.com/career-ops-hq/career-ops, commit `c3230d12a5e94e9c00840410c75e8d89753218f0`.

## Licence ruling

Licence found: MIT. Compatible with this project, so providers are ported by hand as adaptations with an attribution header on line 1 (`Adapted from career-ops-hq/career-ops providers/<file>.mjs (MIT, (c) <holder>), commit <hash>`), disabled by default.

```text
MIT License

Copyright (c) 2026 Santiago Fernández de Valderrama

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Counts

- Provider modules found in `providers/` (files not starting with `_`): **109**
- Imported in this task: **18**
- Already present before this task (earlier plans): **13**
- Skipped: **78**

| Classification (heuristic) | Modules |
|---|---|
| json_api | 64 |
| rss | 10 |
| html_list | 24 |
| needs_login | 8 |
| needs_js | 0 |
| unclear | 3 |

Scope: 47 board-wide, 62 per-company (tenant). Classification is a code heuristic over the source text (`scripts/import-career-ops.ts` `classify`), not a live check: treat it as a triage list.

## Providers

| Provider | Lines | Class | Scope | Status | Reason |
|---|---|---|---|---|---|
| 4dayweek | 159 | json_api | board_wide | imported | ported as src/sources/providers/4dayweek.ts, disabled, discover-only |
| a16z-speedrun-talent | 215 | json_api | board_wide | skipped | board-wide feed, not ported in this pass (candidate for a later batch) |
| adp-workforcenow | 472 | json_api | board_wide | skipped | board-wide feed, not ported in this pass (candidate for a later batch) |
| agentic-jobs | 186 | json_api | board_wide | skipped | board-wide feed, not ported in this pass (candidate for a later batch) |
| alibaba | 194 | needs_login | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| amazon | 138 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| applitrack | 155 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| arbeitnow | 128 | json_api | board_wide | imported | ported as src/sources/providers/arbeitnow.ts, disabled, discover-only |
| arbeitsagentur | 266 | needs_login | board_wide | skipped | looks like it needs credentials, a token or a session (heuristic); agent tier, no script provider |
| ashby | 539 | json_api | tenant | already_present | already ported earlier (plan 4/5 boards or the Adzuna/Remotive/RemoteOK sources) |
| avature | 282 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| bamboohr | 235 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| beesite | 188 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| breezy | 165 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| builtin | 535 | html_list | board_wide | skipped | HTML scraping with no stable machine shape; left to the agent tier or a later declarative generated provider |
| careerviet | 335 | html_list | board_wide | skipped | HTML scraping with no stable machine shape; left to the agent tier or a later declarative generated provider |
| collage | 106 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| comeet | 151 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| consider | 217 | needs_login | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| cryptocurrencyjobs | 117 | rss | board_wide | imported | ported as src/sources/providers/cryptocurrencyjobs.ts, disabled, discover-only |
| csod | 274 | needs_login | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| dassault | 189 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| deutschebahn | 296 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| echojobs | 141 | unclear | board_wide | skipped | could not classify automatically; needs a manual read |
| eightfold | 481 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| eploy | 261 | rss | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| feishu-jobs | 224 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| flowxtra | 143 | json_api | board_wide | imported | ported as src/sources/providers/flowxtra.ts, disabled, discover-only |
| garena | 152 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| gem | 345 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| generalist-world | 336 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| getonbrd | 198 | json_api | board_wide | imported | ported as src/sources/providers/getonbrd.ts, disabled, discover-only |
| getro | 294 | json_api | board_wide | skipped | board-wide feed, not ported in this pass (candidate for a later batch) |
| glints | 251 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| google | 146 | html_list | board_wide | skipped | HTML scraping with no stable machine shape; left to the agent tier or a later declarative generated provider |
| greenhouse | 281 | json_api | tenant | already_present | already ported earlier (plan 4/5 boards or the Adzuna/Remotive/RemoteOK sources) |
| gupy | 470 | json_api | board_wide | skipped | board-wide feed, not ported in this pass (candidate for a later batch) |
| hackernews | 186 | json_api | board_wide | already_present | already ported earlier (plan 4/5 boards or the Adzuna/Remotive/RemoteOK sources) |
| hecklerkoch | 101 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| higheredjobs | 146 | rss | board_wide | skipped | board-wide feed, not ported in this pass (candidate for a later batch) |
| himalayas | 130 | json_api | board_wide | already_present | already ported earlier (plan 4/5 boards or the Adzuna/Remotive/RemoteOK sources) |
| hiringroom | 194 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| ibm | 125 | json_api | board_wide | skipped | board-wide feed, not ported in this pass (candidate for a later batch) |
| icims | 267 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| itviec | 304 | html_list | board_wide | skipped | HTML scraping with no stable machine shape; left to the agent tier or a later declarative generated provider |
| jazzhr | 239 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| jibeapply | 150 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| jobbankca | 298 | html_list | board_wide | skipped | HTML scraping with no stable machine shape; left to the agent tier or a later declarative generated provider |
| jobicy | 84 | json_api | board_wide | imported | ported as src/sources/providers/jobicy.ts, disabled, discover-only |
| jobspresso | 128 | rss | board_wide | imported | ported as src/sources/providers/jobspresso.ts, disabled, discover-only |
| jobstreet | 259 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| jobvite | 444 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| join | 101 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| joinup | 73 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| justjoin | 129 | json_api | board_wide | imported | ported as src/sources/providers/justjoin.ts, disabled, discover-only |
| kalibrr | 291 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| landingjobs | 133 | json_api | board_wide | imported | ported as src/sources/providers/landingjobs.ts, disabled, discover-only |
| larajobs | 128 | rss | board_wide | imported | ported as src/sources/providers/larajobs.ts, disabled, discover-only |
| lever | 134 | json_api | tenant | already_present | already ported earlier (plan 4/5 boards or the Adzuna/Remotive/RemoteOK sources) |
| local-parser | 285 | unclear | tenant | skipped | not a provider: runs an owner-supplied local command |
| manfred | 223 | json_api | board_wide | imported | ported as src/sources/providers/manfred.ts, disabled, discover-only |
| meituan | 190 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| mokahr | 308 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| mycareersfuture | 224 | json_api | board_wide | skipped | board-wide feed, not ported in this pass (candidate for a later batch) |
| neogov | 189 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| nodesk | 137 | rss | board_wide | imported | ported as src/sources/providers/nodesk.ts, disabled, discover-only |
| nofluffjobs | 168 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| occ | 281 | html_list | board_wide | skipped | HTML scraping with no stable machine shape; left to the agent tier or a later declarative generated provider |
| oraclecloud | 274 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| pageup | 295 | needs_login | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| peoplesoft | 946 | needs_login | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| personio | 528 | html_list | tenant | already_present | already ported earlier (plan 4/5 boards or the Adzuna/Remotive/RemoteOK sources) |
| phenom | 273 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| pinpoint | 158 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| platsbanken | 359 | json_api | board_wide | skipped | board-wide feed, not ported in this pass (candidate for a later batch) |
| prevueaps | 254 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| pythonorg | 176 | rss | board_wide | imported | ported as src/sources/providers/pythonorg.ts, disabled, discover-only |
| radancy | 525 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| recruitee | 503 | json_api | tenant | already_present | already ported earlier (plan 4/5 boards or the Adzuna/Remotive/RemoteOK sources) |
| redrover | 148 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| remoteok | 44 | json_api | board_wide | already_present | already ported earlier (plan 4/5 boards or the Adzuna/Remotive/RemoteOK sources) |
| remotive | 43 | json_api | board_wide | already_present | already ported earlier (plan 4/5 boards or the Adzuna/Remotive/RemoteOK sources) |
| remotli | 327 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| rheinmetall | 152 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| rippling | 231 | json_api | board_wide | skipped | board-wide feed, not ported in this pass (candidate for a later batch) |
| schoolspring | 203 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| senjob | 232 | html_list | board_wide | skipped | HTML scraping with no stable machine shape; left to the agent tier or a later declarative generated provider |
| smartrecruiters | 257 | json_api | tenant | already_present | already ported earlier (plan 4/5 boards or the Adzuna/Remotive/RemoteOK sources) |
| softgarden | 147 | html_list | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| solidjobs | 83 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| startup-jobs | 269 | rss | board_wide | imported | ported as src/sources/providers/startup-jobs.ts, disabled, discover-only |
| successfactors | 461 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| taleo | 305 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| teamtailor | 180 | rss | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| techinasia | 447 | needs_login | board_wide | skipped | looks like it needs credentials, a token or a session (heuristic); agent tier, no script provider |
| telegram-channel | 445 | html_list | board_wide | skipped | HTML scraping with no stable machine shape; left to the agent tier or a later declarative generated provider |
| tencent | 148 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| thehub | 184 | json_api | board_wide | imported | ported as src/sources/providers/thehub.ts, disabled, discover-only |
| themuse | 179 | json_api | board_wide | imported | ported as src/sources/providers/themuse.ts, disabled, discover-only |
| tkms | 192 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| torre | 235 | unclear | board_wide | skipped | could not classify automatically; needs a manual read |
| ultipro | 480 | json_api | tenant | skipped | per-company ATS (needs a tracked_companies entry): the ats union, slug rules and fetchBoards wiring belong to the boards code, not the feed engine |
| vdab | 323 | json_api | board_wide | skipped | board-wide feed, not ported in this pass (candidate for a later batch) |
| weworkremotely | 135 | rss | board_wide | already_present | already ported earlier (plan 4/5 boards or the Adzuna/Remotive/RemoteOK sources) |
| workable | 346 | json_api | tenant | already_present | already ported earlier (plan 4/5 boards or the Adzuna/Remotive/RemoteOK sources) |
| workday | 1266 | json_api | tenant | already_present | already ported earlier (plan 4/5 boards or the Adzuna/Remotive/RemoteOK sources) |
| workingnomads | 41 | json_api | board_wide | imported | ported as src/sources/providers/workingnomads.ts, disabled, discover-only |
| wttj | 250 | needs_login | board_wide | skipped | looks like it needs credentials, a token or a session (heuristic); agent tier, no script provider |
| yourator | 212 | json_api | board_wide | imported | ported as src/sources/providers/yourator.ts, disabled, discover-only |

## What the imported providers are and are not

- Shapes were read from career-ops code only. NOTHING was run against a real site: every imported row is `stability: fixture`, `enabled: false`.
- Terms of use and robots.txt of every source are unreviewed. Run `npx tsx scripts/check-portal.ts` style checks from a networked shell and read each site's terms before enabling a row in `config/platforms.json`.
- Most feeds carry no job description (career-ops is listing-only for them): those jobs get a "Listing only" description and score on title and location only until a description fetch exists.
- Imported sources are discover-only for apply (`src/lib/discoverOnly.ts`): email and connect outreach may run, an apply attempt never does.
- The runner applies no title/location filter to `api` sources, so each imported provider keeps only titles that share a word with the configured role and caps the result at 200.
