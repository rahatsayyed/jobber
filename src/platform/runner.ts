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
  // 'json' (default) or 'stream-json' (needed by the scheduler budget tracker).
  output_format?: 'json' | 'stream-json';
  // true: interactive session (no -p, no --output-format, no --max-turns); needs --interactive.
  interactive?: boolean;
  // 'required' (default) runs the classifier launch check. 'not_required' is valid only for a
  // profile with no MCP tools and the empty MCP config (validated in loadProfiles).
  classifier?: 'required' | 'not_required';
  // Exact command strings the Bash tool may run. Only valid with interactive: true.
  bash_exact?: string[];
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
    if (a.startsWith('--permission-mode=') && !['dontAsk', 'default', 'plan'].includes(a.slice('--permission-mode='.length))) {
      throw new Error(`refusing permission mode: ${a}`);
    }
    if (a.toLowerCase().includes('bypass')) {
      throw new Error(`refusing argument containing bypass: ${a}`);
    }
  }
  if (env.IS_SANDBOX) throw new Error('refusing to start claude with IS_SANDBOX set');
  for (const k of Object.keys(env)) {
    if (/^CLAUDE_CODE_.*(SKIP|BYPASS|DANGEROUS|PERMISSION)/i.test(k)) {
      throw new Error(`refusing to start claude with ${k} set`);
    }
  }
}

const BASH_EXACT_RE =
  /^(npm run [a-z0-9:-]+( -- [a-z0-9 :._=-]+)?|npx tsx scripts\/[A-Za-z0-9_./-]+\.ts( [a-z0-9 :._=-]+)?)$/;
const BASH_EXACT_BAD_RE = /[;&|<>`$()\\'"*?~\n\r]/;
const BASH_EXACT_MAX = 40;
const NO_MCP_CONFIG = 'config/runner/mcp.none.json';

function checkBashExact(name: string, p: RunProfile): void {
  if (p.bash_exact === undefined) return;
  if (!Array.isArray(p.bash_exact)) throw new Error(`profile ${name}: bash_exact must be an array`);
  if (p.interactive !== true) throw new Error(`profile ${name}: bash_exact needs interactive: true`);
  if (name === 'hunt' || name === 'outreach_wake') throw new Error(`profile ${name}: must not have bash_exact`);
  if (p.bash_exact.length > BASH_EXACT_MAX) throw new Error(`profile ${name}: bash_exact has more than ${BASH_EXACT_MAX} entries`);
  const seen = new Set<string>();
  for (const e of p.bash_exact) {
    if (typeof e !== 'string' || !BASH_EXACT_RE.test(e) || BASH_EXACT_BAD_RE.test(e) || e.includes('..')) {
      throw new Error(`profile ${name}: bash_exact entry not allowed: ${JSON.stringify(e)}`);
    }
    if (seen.has(e)) throw new Error(`profile ${name}: duplicate bash_exact entry: ${e}`);
    seen.add(e);
  }
}

const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const BAD_PATH_RE = /["$`\n\r\\]/;
function assertName(name: string): void {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error(`invalid profile name: ${JSON.stringify(name)}`);
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
    assertName(name);
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
    if (p.output_format !== undefined && p.output_format !== 'json' && p.output_format !== 'stream-json') {
      throw new Error(`profile ${name}: output_format must be json or stream-json`);
    }
    if (p.env_mode !== 'allowlist' && p.env_mode !== 'dotenv_all') {
      throw new Error(`profile ${name}: env_mode must be allowlist or dotenv_all`);
    }
    if (p.env_mode === 'allowlist' && p.env_keys === undefined && p.env_prefixes === undefined) {
      throw new Error(`profile ${name}: allowlist env needs env_keys or env_prefixes`);
    }
    if (p.interactive !== undefined && typeof p.interactive !== 'boolean') {
      throw new Error(`profile ${name}: interactive must be a boolean`);
    }
    if (p.interactive === true && p.env_mode !== 'allowlist') {
      throw new Error(`profile ${name}: interactive needs env_mode allowlist`);
    }
    if (p.classifier !== undefined && p.classifier !== 'required' && p.classifier !== 'not_required') {
      throw new Error(`profile ${name}: classifier must be required or not_required`);
    }
    if (p.classifier === 'not_required') {
      if (
        allow.length !== 0 ||
        p.allow_from_permission_set !== undefined ||
        p.allow_extra !== undefined ||
        p.mcp_config !== NO_MCP_CONFIG ||
        p.builtin_tools.some((b) => b !== 'Skill' && b !== 'Read')
      ) {
        throw new Error(`profile ${name}: classifier not_required needs no MCP tools and ${NO_MCP_CONFIG}`);
      }
    }
    checkBashExact(name, p);
    out[name] = { ...p, allow, name };
  }
  return out;
}

export function buildClaudeArgs(name: string, p: ResolvedProfile, paths: { settingsPath: string }): string[] {
  void name;
  const args = [
    '-p',
    '--output-format', p.output_format === 'stream-json' ? 'stream-json' : 'json',
    ...(p.output_format === 'stream-json' ? ['--verbose'] : []),
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

// Interactive argv: no -p, no --output-format, no --max-turns. Bash enters only as exact
// Bash(<command>) entries from bash_exact; builtin_tools still may not list it.
export function buildInteractiveArgs(
  name: string,
  p: ResolvedProfile,
  paths: { settingsPath: string },
  initialPrompt: string,
): string[] {
  void name;
  if (p.interactive !== true) throw new Error('buildInteractiveArgs: profile is not interactive');
  if (initialPrompt.startsWith('-')) throw new Error('initial prompt must not start with a dash');
  const bash = p.bash_exact ?? [];
  const tools = [...p.builtin_tools, ...(bash.length > 0 ? ['Bash'] : [])];
  // The initial prompt is the FIRST argument: --allowedTools/--disallowedTools are variadic and
  // would swallow a trailing positional. UNVERIFIED against a real claude binary (plan U2,
  // owner check L3).
  const args = [
    ...(initialPrompt !== '' ? [initialPrompt] : []),
    '--permission-mode', 'dontAsk',
    '--setting-sources', 'project',
    '--strict-mcp-config', '--mcp-config', p.mcp_config,
    '--settings', paths.settingsPath,
    '--tools', tools.join(','),
    '--allowedTools', [...p.allow, ...p.builtin_tools, ...bash.map((c) => `Bash(${c})`)].join(','),
    '--disallowedTools', DANGEROUS_BUILTINS.filter((b) => !(b === 'Bash' && bash.length > 0)).join(','),
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
  if (!p.name) throw new Error('buildEnv: profile has no name (use loadProfiles output)');
  assertName(p.name);
  out.JOBBER_RUN_PROFILE = p.name;
  return out;
}

export function renderSettings(
  name: string,
  p: ResolvedProfile,
  paths: { hookPath: string; policyPath: string },
): object {
  assertName(name);
  for (const v of [paths.hookPath, paths.policyPath]) {
    if (BAD_PATH_RE.test(v.replace(/^\$CLAUDE_PROJECT_DIR(?=\/)/, ''))) throw new Error('unsafe character in hook or policy path');
  }
  const bash = p.interactive === true ? (p.bash_exact ?? []) : [];
  const settings: Record<string, any> = {
    permissions: {
      allow: [...p.allow, ...p.builtin_tools, ...bash.map((c) => `Bash(${c})`)],
      deny: DANGEROUS_BUILTINS.filter((b) => !(b === 'Bash' && bash.length > 0)),
    },
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
  if (p.interactive === true) {
    // The guard file itself ships in Task 7; settings only reference it by path.
    settings.hooks.UserPromptSubmit = [
      {
        hooks: [
          { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/prompt-secret-guard.cjs"', timeout: 10, onFailure: 'block' },
        ],
      },
    ];
  }
  return settings;
}

export function renderPolicy(name: string, p: ResolvedProfile): object {
  assertName(name);
  const { allow_from_permission_set: _set, allow_extra: _extra, name: _n, ...rest } = p;
  void _set;
  void _extra;
  void _n;
  return { version: 1, profiles: { [name]: { ...rest, allow: [...p.allow] } } };
}
