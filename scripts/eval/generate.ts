// Generate tailored resumes for the 8 fixture jobs with `claude -p` (subscription auth, no API key).
//   npm run eval:gen -- <outDir> [--system A|B|C] [--jobs id1,id2] [--model <alias-or-id>]
// The model is pinned (default EVAL_DEFAULT_MODEL) and printed at start; record it in the run notes.
// System A uses the CURRENT .claude/skills/tailor-resume/SKILL.md, so a prompt change is measured as-is.
// B and C use the frozen rival prompts in fixtures/prompts/. Runs in a temp cwd with no MCP servers,
// so the generator cannot call tools or read project files; it sees only the prompt.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeClaudeRunner } from './claude.js';
import { parseModelArg } from './judgeLib.js';
import { buildPrompt, EVAL_DEFAULT_MODEL, rulesFromFrozenPrompt, safeId, stripFrontmatter, type EvalJob } from './lib.js';

const DIR = path.dirname(new URL(import.meta.url).pathname);
const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const outDir = args[0];
if (!outDir || outDir.startsWith('--')) {
  console.error('usage: npm run eval:gen -- <outDir> [--system A|B|C] [--jobs id1,id2] [--model <alias-or-id>]');
  process.exit(2);
}
const system = (opt('--system') ?? 'A').toUpperCase();
const only = opt('--jobs')?.split(',');
let model: string;
try { model = parseModelArg(args, process.env.EVAL_MODEL ?? EVAL_DEFAULT_MODEL); } catch (e) { console.error(`[eval:gen] ${(e as Error).message}`); process.exit(2); }
const jobs: EvalJob[] = JSON.parse(readFileSync(path.join(DIR, 'fixtures', 'jobs.json'), 'utf8')).filter((j: EvalJob) => !only || only.includes(j.id));
const wrapper = readFileSync(path.join(DIR, 'wrapper.md'), 'utf8');
const rules = system === 'A'
  ? stripFrontmatter(readFileSync('.claude/skills/tailor-resume/SKILL.md', 'utf8'))
  : rulesFromFrozenPrompt(readFileSync(path.join(DIR, 'fixtures', 'prompts', `system-${system}.md`), 'utf8'));
const base = readFileSync(path.join(DIR, 'fixtures', 'base-resume.json'), 'utf8');
mkdirSync(outDir, { recursive: true });
console.error(`[eval:gen] model=${model} system=${system} jobs=${jobs.length}`);

// The runner creates a temp cwd per call and removes it in a finally block (see claude.ts).
const runClaude = makeClaudeRunner(model, 'jobber-eval-', 'claude -p');

for (const job of jobs) {
  const text = await runClaude(buildPrompt(wrapper, rules, base, job));
  writeFileSync(path.join(outDir, `${system}-${safeId(job.id)}.json`), text);
  console.error(`[eval:gen] ${system} ${job.id} -> ${text.length} chars`);
}
