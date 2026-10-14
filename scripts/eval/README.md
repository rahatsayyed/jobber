# Resume-tailoring eval (regression harness)

Frozen input: `fixtures/jobs.json` (8 public postings). The base-resume fixture (`fixtures/base-resume.json`) and the
baselines (`fixtures/baseline/`) are local and git-ignored. Copy your own `user-data/resume.json` to
`scripts/eval/fixtures/base-resume.json`, then `npm run eval:gen` writes generated runs under `runs/`. The A/C comparison
in `eval:judge` needs baselines you have generated locally.

Re-score a prompt change (run from repo root, outputs go to the git-ignored scripts/eval/runs/):
    npm run eval:gen -- scripts/eval/runs/<date> --system A --model sonnet   # 8 x claude -p, uses the CURRENT tailor-resume SKILL.md
    npm run eval:metrics -- scripts/eval/runs/<date>              # fact gate v1+v2, render, pages, fill, keyword coverage, hygiene
    npm run eval:judge -- scripts/eval/runs/<date> --compare A,C --model sonnet   # blind judge NEW vs baseline A and C

Model: gen and judge pass `--model` to `claude -p` (default `sonnet`, override with `--model` or `EVAL_MODEL`) and print it at start.
The model that produced the 2026-10-07 baseline A/B/C outputs was not recorded, so a rerun's NEW row differs from the baseline in
model as well as prompt; record the model of every run next to its results.
gen and judge each take 8 sequential `claude -p` calls (up to 600 s each), longer than a foreground shell command may run: start them
with the shell tool's background mode (or split with `--jobs id1,id2,...` batches) and poll for the output files. The nested `claude`
session inherits your user-global CLAUDE.md, plugins and hooks (`CLAUDECODE=1`); smoke-test one nested call first (Task 1 Step 12).

Comparisons are only valid WITHIN one judge run. `judge-rubric.md` is a reconstruction (the original 2026-10-07 packets did not
contain a rubric), so a rerun's BASE_A / BASE_C scores will not reproduce 3.38 / 4.00 exactly; compare NEW against BASE_A and BASE_C
from the same run, never against the published headline.
`eval:metrics` renders through `renderResumeChecked`, so a resume the v2 fact gate blocks is not rendered and gets no page count;
"rendered OK" and "exactly 1 page" are therefore not comparable with the 2026-10-07 baseline numbers for B/C.
`eval:metrics` renders with `maxTrims: 0`, so the auto-trimmer never hides an overflow: page counts are raw.
Single samples per cell: treat differences under ~0.3 as noise; judge on the mean of 2 gen+judge runs.
