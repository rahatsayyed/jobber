// Pure helpers for the resume-tailoring eval harness (no I/O except what callers pass in).
export interface EvalJob { id: string; title: string; company: string; description: string; mustHaveKeywords: string[] }
export interface JudgeScore { truthfulness: number; jobFit: number; bulletQuality: number; voice: number; skimmability: number; violations: string[]; send: boolean; note: string }
export interface Verdict { job: string; scores: Record<string, JudgeScore>; ranking: string[]; why: string }
export interface SystemSummary { n: number; truthfulness: number; jobFit: number; bulletQuality: number; voice: number; skimmability: number; sendCount: number; avgRank: number; violations: number }

export const safeId = (id: string) => id.replace(':', '_');

/** Model alias passed to `claude -p --model`; pinned so a prompt change is not confounded with a model change. Override with --model or EVAL_MODEL. */
export const EVAL_DEFAULT_MODEL = 'sonnet';

export function stripFrontmatter(md: string): string {
  return md.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

/** Frozen B/C prompts are "<!-- header -->\n<wrapper>\n---\n<rules>"; return <rules>. */
export function rulesFromFrozenPrompt(md: string): string {
  const afterHeader = md.indexOf('-->');
  const sep = md.indexOf('\n---\n', afterHeader);
  if (afterHeader < 0 || sep < 0) throw new Error('not a frozen eval prompt (missing --> header or --- separator)');
  return md.slice(sep + 5).trim();
}

export function buildPrompt(wrapper: string, rules: string, baseJson: string, job: EvalJob): string {
  return `${wrapper.trim()}\n\n---\n\n${rules.trim()}\n`
    .replace('{{BASE_RESUME_JSON}}', () => baseJson.trim())
    .replace('{{JOB_TITLE}}', () => job.title)
    .replace('{{COMPANY}}', () => job.company)
    .replace('{{JOB_DESCRIPTION}}', () => job.description);
}

export function parseLoose(raw: string): any {
  const unwrap = (o: any) => (o && typeof o === 'object' && o.resume_json && typeof o.resume_json === 'object' ? o.resume_json : o);
  try { return unwrap(JSON.parse(raw)); } catch { /* fall through */ }
  const s = raw.trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
  try { return unwrap(JSON.parse(s)); } catch { /* fall through */ }
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return unwrap(JSON.parse(s.slice(a, b + 1)));
  throw new Error('no JSON object found');
}

export function resumeAsText(r: any): string {
  const L: string[] = [];
  L.push(`Name: ${r?.name ?? ''} | Title: ${r?.jobTitle ?? ''}`);
  L.push(`Summary: ${r?.summary ?? ''}`);
  for (const e of r?.experience ?? []) {
    L.push(`\n[${e.title} @ ${e.company}, ${e.location ?? ''}, ${e.start} - ${e.end}]`);
    const d = Array.isArray(e.description) ? e.description : String(e.description ?? '').split('\n');
    for (const b of d) if (String(b).trim()) L.push(`  - ${String(b).trim()}`);
  }
  for (const ed of r?.education ?? []) L.push(`\nEducation: ${ed.degree}, ${ed.school}, ${ed.year}`);
  L.push('\nSkills:');
  for (const s of r?.skills ?? []) L.push(`  ${s.category}: ${(s.items ?? []).join(', ')}`);
  if ((r?.projects ?? []).length) L.push(`\nProjects: ${JSON.stringify(r.projects)}`);
  return L.join('\n');
}

export function seededShuffle<T>(xs: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const b = [...xs];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

export function summarizeVerdicts(verdicts: Verdict[], key: Record<string, Record<string, string>>): Record<string, SystemSummary> {
  const acc: Record<string, { rows: JudgeScore[]; ranks: number[] }> = {};
  for (const v of verdicts) {
    const map = key[v.job] ?? {};
    for (const [label, score] of Object.entries(v.scores)) {
      const sys = map[label];
      if (!sys) continue;
      acc[sys] ??= { rows: [], ranks: [] };
      acc[sys].rows.push(score);
      const r = v.ranking.indexOf(label);
      if (r >= 0) acc[sys].ranks.push(r + 1);
    }
  }
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : 0);
  const out: Record<string, SystemSummary> = {};
  for (const [sys, { rows, ranks }] of Object.entries(acc)) {
    out[sys] = {
      n: rows.length,
      truthfulness: mean(rows.map((r) => r.truthfulness)),
      jobFit: mean(rows.map((r) => r.jobFit)),
      bulletQuality: mean(rows.map((r) => r.bulletQuality)),
      voice: mean(rows.map((r) => r.voice)),
      skimmability: mean(rows.map((r) => r.skimmability)),
      sendCount: rows.filter((r) => r.send).length,
      avgRank: mean(ranks),
      violations: rows.reduce((a, r) => a + (r.violations?.length ?? 0), 0),
    };
  }
  return out;
}
