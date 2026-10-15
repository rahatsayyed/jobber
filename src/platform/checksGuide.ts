// src/platform/checksGuide.ts
// Doctor check setup_guide_ready: the setup_guide profile, its skill tool list, the hooks and the
// empty MCP config all agree. Read-only; output names files only, never values.
import { join } from 'node:path';
import type { Check, CheckResult, DoctorContext } from './doctor.js';

const HOOKS = ['tool-allowlist.cjs', 'prompt-secret-guard.cjs', 'kill-switch.cjs'];
const FIX = 'restore config/run-profiles.json, config/runner/mcp.none.json, .claude/hooks and .claude/skills/setup-guide from git';

/** Tool names from the `allowed-tools:` frontmatter line, split on commas outside parentheses. */
export function skillAllowedTools(text: string): string[] | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const line = /^allowed-tools:[ \t]*(.*)$/m.exec(m[1]);
  if (!line) return null;
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of line[1]) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

export function expectedSkillTools(bashExact: string[]): string[] {
  return ['Read', ...bashExact.map((b) => `Bash(${b})`)];
}

export function setupGuideChecks(): Check[] {
  return [
    {
      id: 'setup_guide_ready',
      title: 'setup guide profile, skill and hooks',
      async run(ctx: DoctorContext): Promise<CheckResult> {
        const bad = (detail: string): CheckResult => ({ status: 'fail', detail, fix: FIX });
        let profile: { interactive?: boolean; bash_exact?: unknown } | undefined;
        try {
          const raw = JSON.parse(ctx.fs.read(join(ctx.root, 'config', 'run-profiles.json'))) as {
            profiles?: Record<string, { interactive?: boolean; bash_exact?: unknown }>;
          };
          profile = raw.profiles?.setup_guide;
        } catch {
          return bad('config/run-profiles.json cannot be read');
        }
        if (!profile) return bad('profile setup_guide is missing');
        if (profile.interactive !== true) return bad('profile setup_guide is not interactive');
        if (!Array.isArray(profile.bash_exact) || profile.bash_exact.some((b) => typeof b !== 'string')) {
          return bad('profile setup_guide has no bash_exact list');
        }
        let tools: string[] | null;
        try {
          tools = skillAllowedTools(ctx.fs.read(join(ctx.root, '.claude', 'skills', 'setup-guide', 'SKILL.md')));
        } catch {
          return bad('.claude/skills/setup-guide/SKILL.md cannot be read');
        }
        if (!tools) return bad('setup-guide skill has no allowed-tools line');
        const want = expectedSkillTools(profile.bash_exact as string[]);
        if (tools.length !== want.length || want.some((w, i) => tools![i] !== w)) {
          return bad('setup-guide skill tool list differs from the profile bash_exact list');
        }
        for (const h of HOOKS) {
          if (!ctx.fs.exists(join(ctx.root, '.claude', 'hooks', h))) return bad(`.claude/hooks/${h} is missing`);
        }
        try {
          const mcp = JSON.parse(ctx.fs.read(join(ctx.root, 'config', 'runner', 'mcp.none.json'))) as {
            mcpServers?: Record<string, unknown>;
          };
          if (!mcp.mcpServers || Object.keys(mcp.mcpServers).length !== 0) return bad('config/runner/mcp.none.json lists servers');
        } catch {
          return bad('config/runner/mcp.none.json cannot be read');
        }
        return { status: 'pass', detail: `setup guide ready (${want.length - 1} commands allowed)` };
      },
    },
  ];
}
