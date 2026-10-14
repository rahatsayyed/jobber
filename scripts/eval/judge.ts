// Blind-judge a candidate run against frozen baselines with `claude -p`.
//   npm run eval:judge -- <candDir> [--compare A,C] [--model <alias-or-id>] [--force]
// The judge model is pinned (default EVAL_DEFAULT_MODEL) and printed at start.
// <candDir> must hold A-<job>.json files (the new system). Each packet mixes NEW + the --compare baselines,
// shuffled with a fixed seed; the label->system key is written next to the verdicts and never shown to the judge.
// Resumable: a job whose verdict file already exists is skipped unless --force is given. Each raw judge reply is saved
// to <candDir>/judge-raw/<jobId>.txt before parsing; a job that fails twice is recorded in <candDir>/judge-errors.json
// and the run continues with the other jobs (rerun to retry just those).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EVAL_DEFAULT_MODEL, parseLoose, resumeAsText, safeId, seededShuffle, summarizeVerdicts, type EvalJob, type Verdict } from './lib.js';
import { makeClaudeRunner } from './claude.js';
import { judgeJob, parseModelArg, recordJudgeErrors } from './judgeLib.js';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const cand = args[0];
if (!cand || cand.startsWith('--')) {
  console.error('usage: npm run eval:judge -- <candDir> [--compare A,C] [--model <alias-or-id>] [--force]');
  process.exit(2);
}
const force = args.includes('--force');
let model: string;
try { model = parseModelArg(args, process.env.EVAL_MODEL ?? EVAL_DEFAULT_MODEL); } catch (e) { console.error(`[eval:judge] ${(e as Error).message}`); process.exit(2); }
const compare = (opt('--compare') ?? 'A,C').split(',').map((s) => s.trim().toUpperCase());
const jobs: EvalJob[] = JSON.parse(readFileSync(path.join(DIR, 'fixtures', 'jobs.json'), 'utf8'));
const base = JSON.parse(readFileSync(path.join(DIR, 'fixtures', 'base-resume.json'), 'utf8'));
const rubric = readFileSync(path.join(DIR, 'judge-rubric.md'), 'utf8');
const outDir = path.join(cand, 'judge');
mkdirSync(outDir, { recursive: true });
console.error(`[eval:judge] model=${model} compare=${compare.join(',')}${force ? ' force' : ''}`);

const runner = makeClaudeRunner(model, 'jobber-judge-', 'judge');
const rawDir = path.join(cand, 'judge-raw');

const key: Record<string, Record<string, string>> = {};
const packets: { job: EvalJob; prompt: string }[] = [];
for (const [i, job] of jobs.entries()) {
  const entries = [
    { sys: 'NEW', file: path.join(cand, `A-${safeId(job.id)}.json`) },
    ...compare.map((s) => ({ sys: `BASE_${s}`, file: path.join(DIR, 'fixtures', 'baseline', `${s}-${safeId(job.id)}.json`) })),
  ];
  const order = seededShuffle(entries, 20261008 + i);
  key[job.id] = {};
  const parts = order.map((e, k) => {
    const label = `Resume ${k + 1}`;
    key[job.id][label] = e.sys;
    return `### ${label}\n\n${resumeAsText(parseLoose(readFileSync(e.file, 'utf8')))}`;
  });
  const packet = [
    `## Job posting\nJob id: ${job.id}\nTitle: ${job.title}\nCompany: ${job.company}\n\n${job.description}`,
    `## Candidate's ORIGINAL resume, the only source of truth for facts\n\n${resumeAsText(base)}`,
    `## Tailored versions (anonymous, random order)\n\n${parts.join('\n\n')}`,
  ].join('\n\n');
  packets.push({ job, prompt: `${rubric}\n\n${packet}` });
}
// The key is written BEFORE judging so a crash mid-run never loses the label->system mapping.
writeFileSync(path.join(outDir, 'key.json'), JSON.stringify(key, null, 2));

const verdicts: Verdict[] = [];
const failures: Record<string, string> = {};
let judgedNow = 0;
let skipped = 0;
for (const { job, prompt } of packets) {
  const r = await judgeJob({
    jobId: job.id, prompt, runner, force,
    rawPath: path.join(rawDir, `${safeId(job.id)}.txt`),
    verdictPath: path.join(outDir, `verdict-${safeId(job.id)}.json`),
  });
  if (r.status === 'failed') { failures[job.id] = r.error; console.error(`[eval:judge] ${job.id} FAILED (${r.error})`); continue; }
  verdicts.push(r.verdict);
  if (r.status === 'skipped') { skipped++; console.error(`[eval:judge] ${job.id} skipped (verdict exists)`); }
  else { judgedNow++; console.error(`[eval:judge] ${job.id} done`); }
}
recordJudgeErrors(path.join(cand, 'judge-errors.json'), failures, verdicts.map((v) => v.job));

const summary = summarizeVerdicts(verdicts, key);
const cols = ['n', 'truthfulness', 'jobFit', 'bulletQuality', 'voice', 'skimmability', 'sendCount', 'avgRank', 'violations'] as const;
const md = [`| system | ${cols.join(' | ')} |`, `|---|${cols.map(() => '---').join('|')}|`,
  ...Object.entries(summary).map(([s, r]) => `| ${s} | ${cols.map((c) => r[c]).join(' | ')} |`)].join('\n');
writeFileSync(path.join(outDir, 'summary.md'), md + '\n');
console.error(md);
const nFailed = Object.keys(failures).length;
console.error(`[eval:judge] judged ${judgedNow}, skipped (already judged) ${skipped}, failed ${nFailed} of ${jobs.length}${nFailed ? ` (see ${path.join(cand, 'judge-errors.json')}; rerun to retry them)` : ''}`);
if (nFailed) process.exitCode = 1;
