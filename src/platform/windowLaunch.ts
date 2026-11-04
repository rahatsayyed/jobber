// src/platform/windowLaunch.ts
// What scripts/claude-window.sh needs before it starts claude for a worker window: the per-window `--settings` file
// (hooks only: kill switch, tamper guard, block-outside-project, settings-guard, prompt-secret-guard; NO permissions,
// because the allow list of a window is the top-level permission set from .claude/settings.local.json) and the
// allowlisted environment. The settings come from renderSettings in runner.ts (a pseudo profile), minus its permissions
// block and with window-guard.cjs in place of tool-allowlist.cjs.
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
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
  writeFileSync(tmp, `${JSON.stringify(renderWindowSettings(window), null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
  chmodSync(p, 0o600);
  return { settingsPath: p, env };
}
