// Owner decision 2026-11-06: no `claude -p` / headless method anywhere, and windows are always the path (no WINDOW_LANES flag).
// Lint-style: reads source text only.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'debug' || name === 'dist' || name === 'worktrees' || name === '.worktrees') continue;
    const f = path.join(dir, name);
    if (statSync(f).isDirectory()) walk(f, out);
    else out.push(f);
  }
  return out;
};
const code = (f: string): string[] =>
  readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*|#)/.test(l));

// Owner-run, one-shot, tool-less helpers that are NOT the agent runtime. They are the only remaining uses; the owner decides whether they go too
// (see the report): the setup wizard's login probe and resume conversion, and the offline resume-tailoring eval harness.
const SETUP_AND_EVAL = ['src/setup/steps/claude.ts', 'src/setup/steps/resume.ts', 'scripts/eval/'];
const allowed = (f: string): boolean => SETUP_AND_EVAL.some((a) => path.relative(ROOT, f).startsWith(a));

describe('no headless claude', () => {
  const all = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))].filter((f) => /\.(ts|cjs|mjs|js|sh)$/.test(f));
  const files = all.filter((f) => !allowed(f));
  const spawnsClaude = (f: string): boolean => /(spawn|execFile|run)\(\s*['"`]claude['"`]/.test(readFileSync(f, 'utf8'));
  it('no file under src/ or scripts/ spawns claude with -p, --print or --output-format', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const l of code(f)) {
        // an argv element `'-p'`, `'--print'` (not `--print-args`), `'--output-format'`, or a shell line `claude -p`
        if (/['"`]-p['"`]/.test(l) && /claude|argv|args/i.test(l)) bad.push(`${path.relative(ROOT, f)}: ${l.trim().slice(0, 100)}`);
        else if ((/['"`]--print['"`]|['"`]--output-format['"`]/.test(l)) && spawnsClaude(f)) bad.push(`${path.relative(ROOT, f)}: ${l.trim().slice(0, 100)}`);
        else if (/\bclaude\s+(-p|--print)\b/.test(l)) bad.push(`${path.relative(ROOT, f)}: ${l.trim().slice(0, 100)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the allow-listed setup and eval helpers are exactly the known ones (a new one needs an owner decision)', () => {
    const users = all.filter((f) => allowed(f) && /['"`]-p['"`]/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f)).sort();
    expect(users).toEqual(['scripts/eval/claude.ts', 'src/setup/steps/claude.ts', 'src/setup/steps/resume.ts']);
  });

  it('the removed headless modules and names are gone', () => {
    const names = ['buildClaudeArgs', 'tmuxLauncher', 'runHeadless', 'BudgetTracker', 'StreamInspector', 'buildContinuationPrompt', 'laneUsesWindow', 'RUN_WINDOW_KEEP_MIN', 'TELEGRAM_CHAT_FALLBACK'];
    const hits: string[] = [];
    for (const f of files) {
      const text = code(f).join('\n');
      for (const n of names) if (text.includes(n)) hits.push(`${path.relative(ROOT, f)}: ${n}`);
    }
    expect(hits).toEqual([]);
  });

  it('config/run-profiles.json keeps only the interactive setup_guide profile', () => {
    const j = JSON.parse(readFileSync(path.join(ROOT, 'config', 'run-profiles.json'), 'utf8')) as { profiles: Record<string, { interactive?: boolean }> };
    expect(Object.keys(j.profiles)).toEqual(['setup_guide']);
    expect(j.profiles.setup_guide.interactive).toBe(true);
  });

  it('./run-hunt.sh is the request shim, not a run', () => {
    const t = readFileSync(path.join(ROOT, 'run-hunt.sh'), 'utf8');
    expect(t).toContain('--once --now');
  });
});

describe('WINDOW_LANES is gone', () => {
  const ALLOWED = new Set(['tests/no-headless-lint.test.ts', 'docs/reference/CLAUDE-full.md']);
  it('no source, script, config, test or current doc mentions WINDOW_LANES', () => {
    const roots = ['src', 'scripts', 'config', 'tests', '.claude', 'docs'].map((d) => path.join(ROOT, d));
    const files = [...roots.flatMap((d) => walk(d)), path.join(ROOT, '.env.example'), path.join(ROOT, 'CLAUDE.md'), path.join(ROOT, 'README.md')];
    const hits: string[] = [];
    for (const f of files) {
      const rel = path.relative(ROOT, f);
      if (ALLOWED.has(rel) || rel.startsWith('docs/superpowers')) continue;
      if (!/\.(ts|md|json|cjs|sh|example|txt)$/.test(f) && !f.endsWith('.env.example')) continue;
      if (readFileSync(f, 'utf8').includes('WINDOW_LANES')) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });
  it('the only helper that names window lanes is gone', () => {
    expect(() => readFileSync(path.join(ROOT, 'src', 'scheduler', 'windowLanes.ts'), 'utf8')).toThrow();
  });
});
