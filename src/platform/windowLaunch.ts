// src/platform/windowLaunch.ts
// What scripts/claude-window.sh needs before it starts claude for a worker window: the per-window `--settings` file
// (hooks only: kill switch, tamper guard, block-outside-project, settings-guard, prompt-secret-guard; NO permissions,
// because the allow list of a window is the top-level permission set from .claude/settings.local.json) and the
// allowlisted environment. The settings come from renderSettings in runner.ts (a pseudo profile), minus its permissions
// block and with window-guard.cjs in place of tool-allowlist.cjs.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderSettings, type ResolvedProfile } from './runner.js';
import { assertName } from './tmux.js';
import { buildWindowEnv, type WindowEnvSpec } from './windowEnv.js';

const FULL_BUILTINS = [
  'Skill', 'Agent', 'Task', 'Read', 'Grep', 'Glob', 'Bash', 'BashOutput', 'KillShell', 'Edit', 'Write', 'NotebookEdit',
  'WebFetch', 'WebSearch', 'TodoWrite',
];
export const WINDOW_GUARD_HOOK = '$CLAUDE_PROJECT_DIR/.claude/hooks/window-guard.cjs';
const SETTINGS_GUARD_HOOK = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/settings-guard.cjs"';

export function renderWindowSettings(window: string): object {
  assertName(window);
  const profile: ResolvedProfile = {
    name: window,
    mcp_config: '',
    builtin_tools: FULL_BUILTINS,
    allow: [],
    env_mode: 'allowlist',
    max_turns: 1,
    interactive: true, // adds the UserPromptSubmit secret guard; bash_exact stays empty
    unrestricted_builtins: true, // block-outside-project then covers Grep, Glob and WebFetch too
  };
  const s = renderSettings(window, profile, { hookPath: WINDOW_GUARD_HOOK, policyPath: '-' }) as {
    permissions?: unknown;
    hooks: { PreToolUse: unknown[] };
  };
  delete s.permissions; // the allow list is the top-level permission set, not this file
  s.hooks.PreToolUse.push({
    matcher: '.*',
    hooks: [{ type: 'command', command: SETTINGS_GUARD_HOOK, timeout: 10, onFailure: 'block' }],
  });
  return s;
}

// Per-window extra allow rules (config/windows/<window>.permissions.json). Today only the `fixer` window has a file. The grammar is closed so a
// careless edit cannot widen a window: Edit and Write only under .jobber/heal/wt/, Bash only for these prefixes. Anything else throws and the
// window does not start (fail closed). A missing file means no extra rule.
const EXTRA_BASH_PREFIXES = ['npx tsc', 'npx vitest', 'npm run heal:live', 'git status', 'git diff', 'git log'];
const WT_DIR = '.jobber/heal/wt/';

export function checkWindowRule(rule: unknown, root: string): string {
  if (typeof rule !== 'string' || rule.length > 200) throw new Error('window permission rule must be a short string');
  const noSlash = root.replace(/^\/+/, '');
  const s = rule.replaceAll('{rootnoslash}', noSlash);
  const fileRule = /^(Edit|Write)\((.+)\)$/.exec(s);
  if (fileRule) {
    const p = fileRule[2] ?? '';
    const ok = (p.startsWith(WT_DIR) || p.startsWith(`//${noSlash}/${WT_DIR}`)) && p.endsWith('/**') && !p.includes('..');
    if (!ok) throw new Error(`window permission rule outside the heal worktree: ${rule}`);
    return s;
  }
  const bash = /^Bash\((.+) \*\)$/.exec(s);
  if (bash && EXTRA_BASH_PREFIXES.includes(bash[1] ?? '')) return s;
  throw new Error(`window permission rule not in the closed grammar: ${rule}`);
}

export function loadWindowPermissions(root: string, window: string): string[] {
  assertName(window);
  let raw: string;
  try { raw = readFileSync(path.join(root, 'config', 'windows', `${window}.permissions.json`), 'utf8'); } catch { return []; }
  const j = JSON.parse(raw) as { allow?: unknown };
  if (!Array.isArray(j.allow) || j.allow.length > 20) throw new Error(`${window}.permissions.json: allow must be a list of at most 20 rules`);
  return j.allow.map((r) => checkWindowRule(r, root));
}

export const windowSettingsFile = (root: string, window: string): string => {
  assertName(window);
  return path.join(root, '.jobber', 'window-settings', `${window}.json`);
};

/** Writes the settings file (0600, atomic) and returns its path and the window environment. */
export function prepareWindowLaunch(
  root: string,
  window: string,
  spec: WindowEnvSpec,
  base: Record<string, string | undefined>,
  dotenv: Record<string, string>,
): { settingsPath: string; env: Record<string, string> } {
  const env = buildWindowEnv(window, spec, base, dotenv);
  const p = windowSettingsFile(root, window);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  const settings = renderWindowSettings(window) as { permissions?: { allow: string[] } };
  const extra = loadWindowPermissions(root, window);
  if (extra.length > 0) settings.permissions = { allow: extra }; // merged by Claude with the top-level allow list, this window only
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
  return { settingsPath: p, env };
}
