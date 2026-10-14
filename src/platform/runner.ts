// src/platform/runner.ts
// Pure builders for a fail-closed `claude -p` run: argv, scrubbed env, rendered settings and policy.
import { readFileSync } from 'node:fs';
import { resolveSet, validateSets, type RawSets } from './permissions.js';

export interface RunProfile {
  description?: string;
  mcp_config: string;
  builtin_tools: string[];
  allow?: string[];
  allow_from_permission_set?: string;
  allow_extra?: string[];
  path_rules?: Record<string, { prefixes: string[] }>;
  screen_args?: string[];
  env_mode: 'allowlist' | 'dotenv_all';
  env_keys?: string[];
  env_prefixes?: string[];
  env_files?: string[];
  max_turns: number;
}

export type ResolvedProfile = RunProfile & { allow: string[]; name?: string };

const DANGEROUS_BUILTINS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch'];
const TOOL_RE = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
const SECRET_KEY_RE = /KEY|SECRET|TOKEN|PASSWORD|PASS|COOKIE/i;
const SAFE_BASE_KEYS = ['HOME', 'PATH', 'LANG', 'LC_ALL', 'TZ', 'USER', 'TMPDIR'];
const ALWAYS_DROP = new Set(['ANTHROPIC_API_KEY', 'IS_SANDBOX']);

function isDroppedKey(k: string): boolean {
  return ALWAYS_DROP.has(k) || /^CLAUDE_CODE_.*(SKIP|BYPASS|DANGEROUS|PERMISSION)/i.test(k);
}

export function assertSafeArgs(args: string[], env: Record<string, string>): void {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/dangerously|skip-permissions/i.test(a) || /^bypassPermissions$/i.test(a)) {
      throw new Error(`refusing to start claude with a permission-skipping argument: ${a}`);
    }
    if (a === '--permission-mode' && !['dontAsk', 'default', 'plan'].includes(args[i + 1])) {
      throw new Error(`refusing permission mode: ${args[i + 1]}`);
    }
  }
  if (env.IS_SANDBOX) throw new Error('refusing to start claude with IS_SANDBOX set');
  for (const k of Object.keys(env)) {
    if (/^CLAUDE_CODE_.*(SKIP|BYPASS|DANGEROUS|PERMISSION)/i.test(k)) {
      throw new Error(`refusing to start claude with ${k} set`);
    }
  }
}

function checkMcpEntries(name: string, entries: string[]): void {
  for (const e of entries) {
    if (typeof e !== 'string' || e.includes('*') || !TOOL_RE.test(e)) {
      throw new Error(`profile ${name}: allow entry is not an MCP tool name (mcp__<server>__<tool>): ${String(e)}`);
    }
    if (e === 'mcp__db__raw_query') throw new Error(`profile ${name}: mcp__db__raw_query is never allowed`);
  }
}

export function loadProfiles(
  policyPath: string,
  setsPath = 'config/permission-sets.json',
): Record<string, ResolvedProfile> {
  const policy = JSON.parse(readFileSync(policyPath, 'utf8')) as { profiles?: Record<string, RunProfile> };
  if (!policy || typeof policy.profiles !== 'object' || policy.profiles === null) {
    throw new Error(`${policyPath}: missing profiles`);
  }
  const sets = JSON.parse(readFileSync(setsPath, 'utf8')) as RawSets;
  validateSets(sets);
  const out: Record<string, ResolvedProfile> = {};
  for (const [name, p] of Object.entries(policy.profiles)) {
    const hasAllow = Array.isArray(p.allow);
    if (!hasAllow && !p.allow_from_permission_set) {
      throw new Error(`profile ${name}: needs allow or allow_from_permission_set`);
    }
    if (name === 'hunt' && p.allow_from_permission_set !== undefined && p.allow_from_permission_set !== 'outreach_send') {
      throw new Error(`profile hunt: must use the outreach_send set, not ${p.allow_from_permission_set}`);
    }
    let allow: string[] = [];
    if (hasAllow) {
      checkMcpEntries(name, p.allow as string[]);
      allow = [...(p.allow as string[])];
    }
    if (p.allow_from_permission_set) {
      // Status Bash entries in a set are dropped: run profiles never contain Bash.
      const mcpOnly = resolveSet(sets, p.allow_from_permission_set).filter((e) => !e.startsWith('Bash('));
      checkMcpEntries(name, mcpOnly);
      for (const e of mcpOnly) if (!allow.includes(e)) allow.push(e);
    }
    if (p.allow_extra) {
      checkMcpEntries(name, p.allow_extra);
      for (const e of p.allow_extra) if (!allow.includes(e)) allow.push(e);
    }
    if (!Array.isArray(p.builtin_tools)) throw new Error(`profile ${name}: builtin_tools must be an array`);
    for (const b of p.builtin_tools) {
      if (DANGEROUS_BUILTINS.includes(b)) throw new Error(`profile ${name}: built-in tool not allowed: ${b}`);
    }
    if (!Number.isInteger(p.max_turns) || p.max_turns < 1 || p.max_turns > 1000) {
      throw new Error(`profile ${name}: max_turns must be an integer between 1 and 1000`);
    }
    if (p.env_mode !== 'allowlist' && p.env_mode !== 'dotenv_all') {
      throw new Error(`profile ${name}: env_mode must be allowlist or dotenv_all`);
    }
    if (p.env_mode === 'allowlist' && p.env_keys === undefined && p.env_prefixes === undefined) {
      throw new Error(`profile ${name}: allowlist env needs env_keys or env_prefixes`);
    }
    out[name] = { ...p, allow, name };
  }
  return out;
}

export function buildClaudeArgs(name: string, p: ResolvedProfile, paths: { settingsPath: string }): string[] {
  void name;
  const args = [
    '-p',
    '--output-format', 'json',
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--strict-mcp-config', '--mcp-config', p.mcp_config,
    '--settings', paths.settingsPath,
    '--setting-sources', 'project',
    '--tools', p.builtin_tools.join(','),
    '--allowedTools', [...p.allow, ...p.builtin_tools].join(','),
    '--disallowedTools', DANGEROUS_BUILTINS.join(','),
    '--max-turns', String(p.max_turns),
  ];
  assertSafeArgs(args, {});
  return args;
}

export function buildEnv(
  p: ResolvedProfile,
  base: Record<string, string | undefined>,
  dotenv: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SAFE_BASE_KEYS) if (base[k] !== undefined) out[k] = base[k] as string;
  if (p.env_mode === 'allowlist') {
    const keys = p.env_keys ?? [];
    const prefixes = p.env_prefixes ?? [];
    for (const [k, v] of Object.entries(base)) {
      if (v === undefined) continue;
      const listed = keys.includes(k);
      if (!listed && !prefixes.some((pre) => k.startsWith(pre))) continue;
      if (!listed && SECRET_KEY_RE.test(k)) continue;
      out[k] = v;
    }
  } else {
    for (const [k, v] of Object.entries(dotenv)) out[k] = v;
  }
  for (const k of Object.keys(out)) if (isDroppedKey(k)) delete out[k];
  // Set last so nothing in base or dotenv can spoof the profile name.
  if (p.name) out.JOBBER_RUN_PROFILE = p.name;
  return out;
}

export function renderSettings(
  name: string,
  p: ResolvedProfile,
  paths: { hookPath: string; policyPath: string },
): object {
  return {
    permissions: { allow: [...p.allow, ...p.builtin_tools], deny: DANGEROUS_BUILTINS },
    hooks: {
      PreToolUse: [
        {
          matcher: '.*',
          hooks: [
            { type: 'command', command: `node "${paths.hookPath}" ${name} "${paths.policyPath}"`, timeout: 10, onFailure: 'block' },
          ],
        },
        {
          matcher: 'Read|Write|Edit|NotebookEdit|Bash',
          hooks: [
            { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/block-outside-project.cjs"', timeout: 10, onFailure: 'block' },
          ],
        },
      ],
    },
  };
}

export function renderPolicy(name: string, p: ResolvedProfile): object {
  const { allow_from_permission_set: _set, allow_extra: _extra, name: _n, ...rest } = p;
  void _set;
  void _extra;
  void _n;
  return { version: 1, profiles: { [name]: { ...rest, allow: [...p.allow] } } };
}
