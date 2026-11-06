<!-- Moved verbatim from CLAUDE.md "Running a wake". -->

### Report

The wake's summary carries counts from the pipeline stage and the operator results: new jobs fetched
and the `SOURCE_STATUS:` rows worth attention (errors, fallbacks, flaky sources, zero-kept
companies); matched jobs with veto flags; exclusions with reasons; deadline items (newly expired,
closing soon with `days_left`, unparseable, or `deadline sweep failed: <error>`); `injection_suspects`
and rejected match rows; one line per matched job (`stored score (confidence) - top strength / top gap
- flags`, with `score_cap_reason` when capped); per prepared job the ATS coverage %, gap count, review
applied/rejected and any `flags` (dropped email or notes, gate fallbacks); jobs with no usable contact
or profile; the job-description line `JD fetched N, unavailable N, waiting N` (jobs of Naukri and LinkedIn jobs wait for their full description before they are matched; code puts the figures into the prompt, the wake corrects them with the `jd_fetch` results); the Hacker News domain-check skips; priority (manual) jobs and any `repeat_contact` skips;
promoted jobs and prepares deferred by the cap; emails queued (a wake sends none; sent, failed and
capped counts belong to the drip lane: `npm run status -- limits`, `db.get_outreach_stats`); connects and
messages; applies submitted/held/manual_review/needs_owner/failed/rate_limited/queued; and the
follow-up candidates (`db.list_followup_candidates`) and stale count (`db.list_stale`) with the active
follow-up mode (`FOLLOWUPS_AUTONOMOUS` true means follow-ups send without a Telegram approval step,
under the four code guards in Safety rule 10; the shipped default is legacy, with approval).

Match rubric lines: a job dropped by the pass rule is reported with its `score_cap_reason` (`location_fail`,
`hard_stop`) and its Global score from its reasons; jobs removed by the role gate appear as
exclusions `role: <word>` (status `role_mismatch`). A matched job's line shows its career-ops dimensions and band
(`CV match 4.5, North Star 5.0, Comp 3.0, Culture 3.5, Red flags -0.5, Global 4.2: apply`, see `docs/matching.md`); an old stored row shows `rubric_v2` or `legacy`.
