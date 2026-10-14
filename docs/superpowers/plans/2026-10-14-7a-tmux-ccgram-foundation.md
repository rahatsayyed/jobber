# Plan 7A: tmux, ccgram and doctor foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per project preference, dispatch subagents with `model: sonnet`.

**Goal:** Run every Claude session in tmux, managed from Telegram through `alexei-led/ccgram`, from inside this project, with named permission sets and a `doctor` command that verifies the setup. All credentials stay in the one project `.env`.

**Architecture:** ccgram runs as a long-lived process in its own tmux session. Its state lives in a project-local, fully gitignored `.ccgram/` directory. Its credentials come from the project `.env`, but through a small launcher that extracts only the keys ccgram needs and starts it with a stripped environment, so the other secrets (Gmail, search keys) never enter ccgram's process. Claude windows it creates launch through a wrapper that loads the project `.env` and never skips permissions. ccgram's Claude hooks are written into the project's `.claude/settings.local.json`. Small, injectable TypeScript modules (tmux helper, permission sets, hook merge, doctor) carry the logic and the tests.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), vitest, Node child_process (`execFile` only), bash scripts, `uv` and Python 3.14 for ccgram itself.

**Spec:** `docs/superpowers/specs/2026-10-14-platform-sessions-dashboard-setup-requirements.md`

## Global Constraints

- ccgram (`alexei-led/ccgram`) is the Telegram bridge. It is pinned to an exact reviewed version in `config/ccgram.pin.json`; never `uv tool upgrade`, never `/upgrade`, never `ccgram doctor --fix` (it installs hooks globally and kills windows).
- One credentials file: the project-root `.env` (mode 600, gitignored). It holds `TELEGRAM_BOT_TOKEN` and `ALLOWED_USERS` next to every other key. No second `.env` anywhere (`.ccgram/.env` must not exist).
- ccgram never reads the project `.env` itself. `scripts/ccgram/run.sh` extracts only `TELEGRAM_BOT_TOKEN` and `ALLOWED_USERS` and starts ccgram with `env -i` plus those two values, `HOME`, `PATH`, `CCGRAM_DIR` and `CCGRAM_CLAUDE_COMMAND`. Reason: ccgram is third-party code (13 dependencies, voice and upgrade features, a Telegram-facing process); if it or a dependency leaked its environment, it would expose only the bot token, not the Gmail app password or other keys. Telegram flag, then env, then `.env` is ccgram's precedence, so the env values win.
- ccgram's working directory is `<project>/.ccgram/` (state only, directory mode 700, entirely gitignored), never the project root.
- Nothing starts Claude with `--dangerously-skip-permissions` or `bypassPermissions`, and `CCGRAM_CLAUDE_COMMAND` never contains such a flag. The Shell provider, YOLO mode, voice, LLM, TTS and Mini App features stay off (their variables unset).
- `ALLOWED_USERS` is a non-empty comma-separated list of numeric Telegram user IDs.
- Permission-set entries are MCP tool names only (`mcp__<server>` or `mcp__<server>__<tool>`); never `Bash`, `Read`, `Write`, `Edit`, or any entry mentioning skip-permissions.
- All subprocess calls use `execFile` with an argument array (no shell strings), and tmux session and window names must match `^[A-Za-z0-9_.-]{1,64}$`.
- Imports use `.js` suffixes; tests live in `tests/*.test.ts`; run with `npx vitest run <file>`.
- Tests never touch real secrets, the real `~/.claude`, or a real tmux server; use injected fakes and temp directories.

## Review Focus

1. **Secrets reaching ccgram:** the launcher must pass only the two keys ccgram needs and must not source or print the whole `.env` (Task 3 lint test).
2. **Overwriting the user's `settings.local.json`:** a malformed file or user-added entries must never be lost; the writer backs up and refuses to overwrite invalid JSON (Task 2, Task 4).
3. **Switching permission sets** (full back to read-only) must remove only entries we manage and keep the user's own entries and any `deny` rules (Task 2).
4. **Hook merging** must be idempotent, keep other hooks (such as the existing `block-outside-project` hook), and replace a stale ccgram interpreter path (Task 4).
5. **tmux names with shell metacharacters or option-like values** (`-t`, `;`, spaces) must be rejected before any subprocess call (Task 1).
6. **`doctor` must never print the bot token or any secret value**, only whether it is present and well-formed (Task 5).
7. **A second credentials file** (`.ccgram/.env`) left behind by a manual ccgram setup must be reported (Task 5).

## Decisions to confirm (assumed here)

- ccgram hooks go in the project's `.claude/settings.local.json`, not the committed `.claude/settings.json` (the hook command contains a machine-specific Python path, so committing it would put per-user paths in git) and not the global file. This is not verified to work: Task 6 is a live check, with the fallback of `ccgram hook --install` globally (with a backup of `~/.claude/settings.json`) if project-level hooks do not fire. An alternative worth considering later: a committed, portable hook script that resolves the interpreter at run time, so the hooks could live in the shared `settings.json` for all users.
- The permission-set contents in Task 2 (what counts as read-only, send, full).
- Claude windows started by ccgram load the project `.env` through the wrapper, so MCP servers get their credentials. Future hardening: let each MCP server load the keys it needs itself, so Claude's own process environment stays clean.

## File Structure

| File | Responsibility |
|---|---|
| `src/platform/tmux.ts` | `tmux` helper: `hasSession`, `listWindows`, `ensureSession`, `capture`; injectable runner; name validation |
| `src/platform/permissions.ts` | Resolve named sets, validate entries, merge into `.claude/settings.local.json` safely |
| `config/permission-sets.json` | `read_only`, `outreach_send`, `full` definitions |
| `src/platform/ccgramHooks.ts` | Build, merge, remove and inspect ccgram hook entries; resolve ccgram's Python |
| `src/platform/envFile.ts` | Parse `.env` files (values never logged) |
| `src/platform/doctor.ts` | Check framework: run, report, exit code |
| `src/platform/checks.ts` | The individual checks (tmux, ccgram, env file, hooks, permissions, gitignore) |
| `scripts/doctor.ts` | CLI entry for `npm run doctor` |
| `scripts/ccgram/start.sh`, `run.sh`, `stop.sh`, `claude-session.sh` | Start the bridge's tmux session; launcher that passes only ccgram's keys; stop; Claude launch wrapper |
| `.env.example` (modify) | Adds the ccgram keys next to the project's other keys |
| `config/ccgram.pin.json` | Pinned ccgram version |
| `.gitignore` (modify) | `.ccgram/`, `.env` and `.claude/settings.local.json` |
| `docs/superpowers/specs/2026-10-14-ccgram-review.md` | Recorded security review of the unreviewed ccgram code |

---

### Task 1: ccgram review gate, pin and tmux helper

**Files:**
- Create: `docs/superpowers/specs/2026-10-14-ccgram-review.md`, `config/ccgram.pin.json`, `src/platform/tmux.ts`
- Test: `tests/platform-tmux.test.ts`

**Interfaces:**
- Produces:
  - `type Run = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; code: number }>`
  - `defaultRun: Run`
  - `assertName(name: string): void`
  - `hasSession(run, session): Promise<boolean>`
  - `listWindows(run, session): Promise<TmuxWindow[]>` where `TmuxWindow = { index: number; name: string; active: boolean; command: string }`
  - `ensureSession(run, session, cwd): Promise<boolean>` (true when created)
  - `capture(run, session, window, lines?): Promise<string>`

- [ ] **Step 1: Manual security review (gate; no code)**

Read these ccgram files at the version you will pin, from the GitHub tag or a locally installed copy under `uv tool dir` (do not execute anything): the tmux send path (search the `src/ccgram` tree for `send_keys` and `paste`), `handlers/text*`, `handlers/shell*`, `handlers/voice*`, `handlers/upgrade.py`, `hook.py`, `config.py`, and every place `YOLO` is referenced. Record in `docs/superpowers/specs/2026-10-14-ccgram-review.md`: the pinned version, for each file whether `ALLOWED_USERS` is checked before any action, how text reaches a pane, what `/upgrade` does, what `YOLO` does and where it is switched on, any network call that is not Telegram, whether ccgram reads any `.env` besides `./.env` and `$CCGRAM_DIR/.env`, and whether variables passed in the environment take precedence over `.env` files. If any handler lacks the allowlist check, or `/upgrade` or YOLO cannot be kept off, stop and report to the owner instead of continuing.

- [ ] **Step 2: Install the pinned version and record it**

Run (replace `X.Y.Z` with the version you reviewed):

```bash
uv tool install --python 3.14 "ccgram==X.Y.Z"
ccgram --version
```

Create `config/ccgram.pin.json`:

```json
{ "package": "ccgram", "version": "X.Y.Z", "reviewed_at": "2026-10-14" }
```

- [ ] **Step 3: Write the failing tmux test**

```ts
// tests/platform-tmux.test.ts
import { describe, it, expect } from 'vitest';
import { assertName, capture, ensureSession, hasSession, listWindows, type Run } from '../src/platform/tmux.js';

function fakeRun(responses: Record<string, { stdout?: string; code?: number }> = {}) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Run = async (cmd, args) => {
    calls.push({ cmd, args });
    const r = responses[args[0]] ?? {};
    return { stdout: r.stdout ?? '', code: r.code ?? 0 };
  };
  return { run, calls };
}

describe('assertName', () => {
  it('accepts normal names and rejects metacharacters and option-like values', () => {
    expect(() => assertName('ccgram-daemon')).not.toThrow();
    for (const bad of ['', '-t', 'a b', 'a;b', 'a$(x)', 'a:b', 'x'.repeat(65)]) {
      expect(() => assertName(bad)).toThrow();
    }
  });
});

describe('tmux helper', () => {
  it('hasSession reflects the exit code', async () => {
    expect(await hasSession(fakeRun({ 'has-session': { code: 0 } }).run, 's')).toBe(true);
    expect(await hasSession(fakeRun({ 'has-session': { code: 1 } }).run, 's')).toBe(false);
  });

  it('listWindows parses the format string', async () => {
    const { run, calls } = fakeRun({ 'list-windows': { stdout: '0|bot|1|python\n1|hunt|0|claude\n' } });
    const windows = await listWindows(run, 'ccgram');
    expect(windows).toEqual([
      { index: 0, name: 'bot', active: true, command: 'python' },
      { index: 1, name: 'hunt', active: false, command: 'claude' },
    ]);
    expect(calls[0].args).toContain('#{window_index}|#{window_name}|#{window_active}|#{pane_current_command}');
  });

  it('listWindows returns an empty list when the session is missing', async () => {
    expect(await listWindows(fakeRun({ 'list-windows': { code: 1 } }).run, 'nope')).toEqual([]);
  });

  it('ensureSession creates only when missing', async () => {
    const missing = fakeRun({ 'has-session': { code: 1 } });
    expect(await ensureSession(missing.run, 's', '/tmp/x')).toBe(true);
    expect(missing.calls.map((c) => c.args[0])).toEqual(['has-session', 'new-session']);
    const present = fakeRun({ 'has-session': { code: 0 } });
    expect(await ensureSession(present.run, 's', '/tmp/x')).toBe(false);
    expect(present.calls).toHaveLength(1);
  });

  it('capture clamps the line count and targets session:window', async () => {
    const { run, calls } = fakeRun({ 'capture-pane': { stdout: 'hello' } });
    expect(await capture(run, 'ccgram', 'hunt', 100000)).toBe('hello');
    expect(calls[0].args).toEqual(['capture-pane', '-p', '-t', 'ccgram:hunt', '-S', '-500']);
  });

  it('rejects bad names before running anything', async () => {
    const { run, calls } = fakeRun();
    await expect(capture(run, 'ok', '-t', 10)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/platform-tmux.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 5: Write `tmux.ts`**

```ts
// src/platform/tmux.ts
import { execFile } from 'node:child_process';

export type Run = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string },
) => Promise<{ stdout: string; code: number }>;

export const defaultRun: Run = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts?.cwd, timeout: 10_000, maxBuffer: 1_000_000 }, (err, stdout) => {
      resolve({ stdout: String(stdout ?? ''), code: err ? 1 : 0 });
    });
  });

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function assertName(name: string): void {
  if (!NAME_RE.test(name) || name.startsWith('-')) throw new Error(`invalid tmux name: ${JSON.stringify(name)}`);
}

export interface TmuxWindow {
  index: number;
  name: string;
  active: boolean;
  command: string;
}

export async function hasSession(run: Run, session: string): Promise<boolean> {
  assertName(session);
  return (await run('tmux', ['has-session', '-t', session])).code === 0;
}

export async function listWindows(run: Run, session: string): Promise<TmuxWindow[]> {
  assertName(session);
  const r = await run('tmux', [
    'list-windows',
    '-t',
    session,
    '-F',
    '#{window_index}|#{window_name}|#{window_active}|#{pane_current_command}',
  ]);
  if (r.code !== 0) return [];
  return r.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [index, name, active, command] = line.split('|');
      return { index: Number(index), name, active: active === '1', command: command ?? '' };
    });
}

export async function ensureSession(run: Run, session: string, cwd: string): Promise<boolean> {
  assertName(session);
  if (await hasSession(run, session)) return false;
  await run('tmux', ['new-session', '-d', '-s', session, '-c', cwd]);
  return true;
}

export async function capture(run: Run, session: string, window: string, lines = 40): Promise<string> {
  assertName(session);
  assertName(window);
  const n = Math.max(1, Math.min(500, Math.floor(lines)));
  const r = await run('tmux', ['capture-pane', '-p', '-t', `${session}:${window}`, '-S', `-${n}`]);
  return r.stdout;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/platform-tmux.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/superpowers/specs/2026-10-14-ccgram-review.md config/ccgram.pin.json src/platform/tmux.ts tests/platform-tmux.test.ts
git commit -m "feat(platform): ccgram review record, version pin and tmux helper"
```

---

### Task 2: Permission sets

**Files:**
- Create: `config/permission-sets.json`, `src/platform/permissions.ts`
- Test: `tests/platform-permissions.test.ts`

**Interfaces:**
- Produces:
  - `type SetName = 'read_only' | 'outreach_send' | 'full'`, `SET_NAMES`
  - `type RawSets = Record<string, { extends?: string; allow: string[] }>`
  - `validateSets(sets: RawSets): void` (throws on any non-MCP entry)
  - `resolveSet(sets, name): string[]`
  - `applySet(settings: LocalSettings, sets, name): LocalSettings`
  - `detectSet(settings, sets): SetName | 'custom'` (which set the `allow` list currently matches, ignoring user entries)
  - `applySetToFile(path: string, sets: RawSets, name: SetName): void`

- [ ] **Step 1: Write `config/permission-sets.json`**

```json
{
  "read_only": {
    "allow": [
      "mcp__db__get_job_stats",
      "mcp__db__get_outreach_stats",
      "mcp__db__get_funnel",
      "mcp__db__get_patterns",
      "mcp__db__calibration",
      "mcp__db__list_jobs",
      "mcp__db__list_outreach",
      "mcp__db__list_queued_outreach",
      "mcp__db__list_sent_emails",
      "mcp__db__list_skipped_outreach",
      "mcp__db__list_stale",
      "mcp__db__list_threads",
      "mcp__db__list_followup_candidates",
      "mcp__db__list_approved_followups",
      "mcp__job-fetch__board_status",
      "mcp__job-fetch__search_jobs",
      "mcp__resume__get_base_resume",
      "mcp__resume__check_text",
      "mcp__gates__check_liveness",
      "mcp__gates__apply_vetoes",
      "mcp__contacts__find_company_emails",
      "mcp__gmail__search_emails",
      "mcp__gmail__read_email",
      "mcp__naukri__naukri_state",
      "mcp__naukri__naukri_screenshot"
    ]
  },
  "outreach_send": {
    "extends": "read_only",
    "allow": [
      "mcp__job-fetch__list_new_jobs",
      "mcp__discover__linkedin_jobs",
      "mcp__discover__linkedin_posts",
      "mcp__resume__render_resume",
      "mcp__resume__apply_review_edits",
      "mcp__db__check_and_increment",
      "mcp__db__claim_followup_for_send",
      "mcp__db__enqueue_outreach",
      "mcp__db__mark_excluded",
      "mcp__db__mark_followup_failed",
      "mcp__db__mark_followup_sent",
      "mcp__db__record_email_sent",
      "mcp__db__record_outcome",
      "mcp__db__resolve_reply_proposals",
      "mcp__db__resolve_stale",
      "mcp__db__save_followup_draft",
      "mcp__db__save_match_result",
      "mcp__db__set_email_thread",
      "mcp__db__set_followup_approval",
      "mcp__db__sweep_deadlines",
      "mcp__db__triage_replies",
      "mcp__db__unexclude",
      "mcp__db__update_outreach_status",
      "mcp__connect__find_linkedin_profile",
      "mcp__connect__check_connection_status",
      "mcp__connect__record_connection_status",
      "mcp__connect__connect_send",
      "mcp__connect__send_linkedin_message",
      "mcp__apply__auto",
      "mcp__apply__linkedin",
      "mcp__apply__greenhouse",
      "mcp__apply__lever",
      "mcp__apply__workday",
      "mcp__apply__ashby",
      "mcp__naukri__naukri_open",
      "mcp__naukri__naukri_click",
      "mcp__naukri__naukri_type",
      "mcp__naukri__naukri_close",
      "mcp__gmail__send_email"
    ]
  },
  "full": {
    "extends": "outreach_send",
    "allow": [
      "mcp__db",
      "mcp__job-fetch",
      "mcp__resume",
      "mcp__contacts",
      "mcp__gates",
      "mcp__connect",
      "mcp__apply",
      "mcp__discover",
      "mcp__naukri",
      "mcp__gmail"
    ]
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/platform-permissions.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applySet,
  applySetToFile,
  detectSet,
  resolveSet,
  validateSets,
  type RawSets,
} from '../src/platform/permissions.js';

const real: RawSets = JSON.parse(readFileSync('config/permission-sets.json', 'utf8'));

const SEND_TOOLS = [
  'mcp__connect__connect_send',
  'mcp__connect__send_linkedin_message',
  'mcp__gmail__send_email',
  'mcp__apply__auto',
  'mcp__apply__linkedin',
  'mcp__apply__greenhouse',
  'mcp__apply__lever',
  'mcp__apply__workday',
  'mcp__apply__ashby',
  'mcp__naukri__naukri_click',
  'mcp__naukri__naukri_type',
];

describe('shipped permission sets', () => {
  it('are valid MCP-only entries', () => {
    expect(() => validateSets(real)).not.toThrow();
  });
  it('read_only contains no send, apply or write tool', () => {
    const ro = resolveSet(real, 'read_only');
    for (const t of SEND_TOOLS) expect(ro).not.toContain(t);
    expect(ro.some((e) => /__(save|record|enqueue|mark|set|update|resolve|claim|unexclude|sweep)_/.test(e))).toBe(false);
  });
  it('outreach_send includes read_only and every send tool', () => {
    const os = resolveSet(real, 'outreach_send');
    for (const t of resolveSet(real, 'read_only')) expect(os).toContain(t);
    for (const t of SEND_TOOLS) expect(os).toContain(t);
  });
  it('full adds whole-server entries and never an unscoped shell or file tool', () => {
    const full = resolveSet(real, 'full');
    for (const s of ['mcp__gmail', 'mcp__connect', 'mcp__apply', 'mcp__naukri', 'mcp__db']) expect(full).toContain(s);
    expect(full.some((e) => !e.startsWith('mcp__'))).toBe(false);
  });
});

describe('validateSets', () => {
  it('rejects non-MCP entries', () => {
    for (const bad of ['Bash', 'Bash(*)', 'Read', 'Write(*)', 'mcp__x__y --dangerously-skip-permissions']) {
      expect(() => validateSets({ s: { allow: [bad] } })).toThrow();
    }
  });
  it('rejects unknown parents and cycles', () => {
    expect(() => resolveSet({ a: { extends: 'zzz', allow: [] } }, 'a')).toThrow();
    expect(() => resolveSet({ a: { extends: 'b', allow: [] }, b: { extends: 'a', allow: [] } }, 'a')).toThrow();
  });
});

describe('applySet', () => {
  it('keeps user entries, deny and ask, and replaces managed entries', () => {
    const before = {
      model: 'sonnet',
      permissions: {
        allow: ['Bash(npx vitest run *)', 'mcp__gmail__send_email', 'mcp__connect__connect_send'],
        deny: ['Read(./.env)'],
        ask: ['Bash(git push *)'],
      },
    };
    const after = applySet(before, real, 'read_only');
    expect(after.model).toBe('sonnet');
    expect(after.permissions?.deny).toEqual(['Read(./.env)']);
    expect(after.permissions?.ask).toEqual(['Bash(git push *)']);
    expect(after.permissions?.allow).toContain('Bash(npx vitest run *)');
    expect(after.permissions?.allow).not.toContain('mcp__gmail__send_email');
    expect(after.permissions?.allow).toContain('mcp__db__get_funnel');
  });

  it('is idempotent', () => {
    const once = applySet({}, real, 'outreach_send');
    expect(applySet(once, real, 'outreach_send')).toEqual(once);
  });

  it('detects which set is active, or custom', () => {
    expect(detectSet(applySet({}, real, 'full'), real)).toBe('full');
    expect(detectSet(applySet({}, real, 'read_only'), real)).toBe('read_only');
    expect(detectSet({ permissions: { allow: ['mcp__gmail__send_email'] } }, real)).toBe('custom');
  });
});

describe('applySetToFile', () => {
  it('creates the file, backs up an existing one, and refuses to overwrite invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'perm-'));
    const path = join(dir, 'settings.local.json');
    applySetToFile(path, real, 'read_only');
    expect(JSON.parse(readFileSync(path, 'utf8')).permissions.allow).toContain('mcp__db__get_funnel');

    applySetToFile(path, real, 'outreach_send');
    expect(existsSync(`${path}.bak`)).toBe(true);

    writeFileSync(path, '{ not json');
    expect(() => applySetToFile(path, real, 'read_only')).toThrow();
    expect(readFileSync(path, 'utf8')).toBe('{ not json');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/platform-permissions.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Write `permissions.ts`**

```ts
// src/platform/permissions.ts
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export type SetName = 'read_only' | 'outreach_send' | 'full';
export const SET_NAMES: SetName[] = ['read_only', 'outreach_send', 'full'];

export type RawSets = Record<string, { extends?: string; allow: string[] }>;

export interface LocalSettings {
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[]; [k: string]: unknown };
  [k: string]: unknown;
}

const MCP_ENTRY = /^mcp__[A-Za-z0-9_-]+(__[A-Za-z0-9_-]+)?$/;

export function validateSets(sets: RawSets): void {
  for (const [name, set] of Object.entries(sets)) {
    for (const entry of set.allow) {
      if (!MCP_ENTRY.test(entry)) throw new Error(`permission set ${name}: entry is not an MCP tool name: ${entry}`);
    }
  }
}

export function resolveSet(sets: RawSets, name: string): string[] {
  const chain: string[][] = [];
  const seen = new Set<string>();
  let current: string | undefined = name;
  while (current) {
    if (seen.has(current)) throw new Error(`permission set cycle at ${current}`);
    seen.add(current);
    const set: RawSets[string] | undefined = sets[current];
    if (!set) throw new Error(`unknown permission set: ${current}`);
    chain.push(set.allow);
    current = set.extends;
  }
  const out: string[] = [];
  for (const allow of chain.reverse()) for (const entry of allow) if (!out.includes(entry)) out.push(entry);
  return out;
}

function managedEntries(sets: RawSets): Set<string> {
  const all = new Set<string>();
  for (const name of Object.keys(sets)) for (const e of resolveSet(sets, name)) all.add(e);
  return all;
}

export function applySet(settings: LocalSettings, sets: RawSets, name: string): LocalSettings {
  const managed = managedEntries(sets);
  const desired = resolveSet(sets, name);
  const existing = settings.permissions?.allow ?? [];
  const userEntries = existing.filter((e) => !managed.has(e));
  return { ...settings, permissions: { ...settings.permissions, allow: [...userEntries, ...desired] } };
}

export function detectSet(settings: LocalSettings, sets: RawSets): SetName | 'custom' {
  const managed = managedEntries(sets);
  const active = new Set((settings.permissions?.allow ?? []).filter((e) => managed.has(e)));
  for (const name of [...SET_NAMES].reverse()) {
    const wanted = new Set(resolveSet(sets, name));
    if (wanted.size === active.size && [...wanted].every((e) => active.has(e))) return name;
  }
  return 'custom';
}

export function applySetToFile(path: string, sets: RawSets, name: SetName): void {
  validateSets(sets);
  let current: LocalSettings = {};
  if (existsSync(path)) {
    const text = readFileSync(path, 'utf8');
    try {
      current = JSON.parse(text) as LocalSettings;
    } catch {
      throw new Error(`${path} is not valid JSON; refusing to overwrite it`);
    }
    copyFileSync(path, `${path}.bak`);
  }
  const next = applySet(current, sets, name);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  renameSync(tmp, path);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/platform-permissions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add config/permission-sets.json src/platform/permissions.ts tests/platform-permissions.test.ts
git commit -m "feat(platform): named permission sets written to settings.local.json"
```

---

### Task 3: ccgram runner scripts and ignore rules (single `.env`)

**Files:**
- Create: `scripts/ccgram/start.sh`, `scripts/ccgram/run.sh`, `scripts/ccgram/stop.sh`, `scripts/ccgram/claude-session.sh`
- Modify: `.env.example` (create it if it does not exist), `.gitignore`
- Test: `tests/platform-ccgram-files.test.ts`

**Interfaces:**
- Produces: `scripts/ccgram/start.sh` (idempotent: starts the `ccgram-daemon` tmux session running `run.sh`), `run.sh` (reads only `TELEGRAM_BOT_TOKEN` and `ALLOWED_USERS` from the project `.env`, then `exec`s ccgram with a stripped environment), `stop.sh`, `claude-session.sh` (the value of `CCGRAM_CLAUDE_COMMAND`).

- [ ] **Step 1: Write the failing lint test**

```ts
// tests/platform-ccgram-files.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string): string => readFileSync(p, 'utf8');

describe('ccgram runner files', () => {
  const start = read('scripts/ccgram/start.sh');
  const run = read('scripts/ccgram/run.sh');
  const stop = read('scripts/ccgram/stop.sh');
  const session = read('scripts/ccgram/claude-session.sh');
  const example = read('.env.example');
  const ignore = read('.gitignore');

  it('start.sh runs the launcher in the .ccgram state dir and locks down permissions', () => {
    expect(start).toMatch(/set -euo pipefail/);
    expect(start).toMatch(/-c "\$CCGRAM_HOME"/);
    expect(start).toMatch(/scripts\/ccgram\/run\.sh/);
    expect(start).toMatch(/chmod 700 "\$CCGRAM_HOME"/);
    expect(start).toMatch(/chmod 600 "\$ROOT\/\.env"/);
  });

  it('run.sh passes only ccgram\'s keys, with a stripped environment, and never sources the whole .env', () => {
    expect(run).toMatch(/set -euo pipefail/);
    expect(run).toMatch(/exec env -i /);
    expect(run).toMatch(/CCGRAM_DIR="\$CCGRAM_HOME"/);
    expect(run).toMatch(/get TELEGRAM_BOT_TOKEN/);
    expect(run).toMatch(/get ALLOWED_USERS/);
    expect(run).not.toMatch(/^\s*(source|\.)\s+"?\$(ENV_FILE|ROOT)/m);
    expect(run).not.toMatch(/GMAIL|SERPER|APP_PASSWORD/);
  });

  it('no script skips permissions or runs the upgrade or doctor --fix commands', () => {
    for (const text of [start, run, stop, session, example]) {
      expect(text).not.toMatch(/dangerously-skip-permissions|bypassPermissions/);
      expect(text).not.toMatch(/uv tool upgrade|doctor --fix/);
    }
  });

  it('claude-session.sh loads the project env and execs claude with the passed arguments', () => {
    expect(session).toMatch(/\. "\$ROOT\/\.env"/);
    expect(session).toMatch(/exec claude "\$@"/);
  });

  it('.env.example lists the ccgram keys with no real values and keeps optional features unset', () => {
    expect(example).toMatch(/^TELEGRAM_BOT_TOKEN=$/m);
    expect(example).toMatch(/^ALLOWED_USERS=$/m);
    expect(example).not.toMatch(/^CCGRAM_(WHISPER|LLM|TTS|MINIAPP)\w*=\S+/m);
  });

  it('.gitignore ignores ccgram state, .env and settings.local.json', () => {
    const lines = ignore.split('\n').map((l) => l.trim());
    expect(lines).toContain('.ccgram/');
    expect(lines).toContain('.env');
    expect(lines).toContain('.claude/settings.local.json');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/platform-ccgram-files.test.ts`
Expected: FAIL (files not found).

- [ ] **Step 3: Write `scripts/ccgram/start.sh`**

```bash
#!/usr/bin/env bash
# Start the ccgram Telegram bridge in its own tmux session, from this project.
# The bridge runs inside .ccgram/ (state only). Its credentials come from the single
# project .env through run.sh, which passes ccgram only the two keys it needs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CCGRAM_HOME="$ROOT/.ccgram"
SESSION="${CCGRAM_DAEMON_SESSION:-ccgram-daemon}"

if [ ! -f "$ROOT/.env" ]; then
  echo "Missing $ROOT/.env. Copy .env.example and fill in TELEGRAM_BOT_TOKEN and ALLOWED_USERS." >&2
  exit 1
fi

chmod 600 "$ROOT/.env"
mkdir -p "$CCGRAM_HOME"
chmod 700 "$CCGRAM_HOME"

if tmux has-session -t "$SESSION" >/dev/null 2>&1; then
  echo "ccgram is already running in tmux session $SESSION"
  exit 0
fi

tmux new-session -d -s "$SESSION" -c "$CCGRAM_HOME" bash "$ROOT/scripts/ccgram/run.sh"
echo "Started ccgram in tmux session $SESSION"
```

- [ ] **Step 4: Write `scripts/ccgram/run.sh`**

```bash
#!/usr/bin/env bash
# Runs inside the ccgram tmux window. Reads ONLY the keys ccgram needs from the single
# project .env and starts ccgram with a stripped environment, so the other credentials
# (Gmail, search keys, and so on) never enter ccgram's process.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="$ROOT/.env"
CCGRAM_HOME="$ROOT/.ccgram"

get() {
  grep -E "^$1=" "$ENV_FILE" | head -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//"
}

TOKEN="$(get TELEGRAM_BOT_TOKEN || true)"
USERS="$(get ALLOWED_USERS || true)"
if [ -z "$TOKEN" ] || [ -z "$USERS" ]; then
  echo "TELEGRAM_BOT_TOKEN and ALLOWED_USERS must both be set in $ENV_FILE" >&2
  exit 1
fi

exec env -i HOME="$HOME" PATH="$PATH" CCGRAM_DIR="$CCGRAM_HOME" \
  TELEGRAM_BOT_TOKEN="$TOKEN" ALLOWED_USERS="$USERS" \
  CCGRAM_CLAUDE_COMMAND="$ROOT/scripts/ccgram/claude-session.sh" \
  ccgram
```

- [ ] **Step 5: Write `scripts/ccgram/stop.sh`**

```bash
#!/usr/bin/env bash
# Stop the ccgram bridge (its tmux session). Claude windows it created are left running.
set -euo pipefail

SESSION="${CCGRAM_DAEMON_SESSION:-ccgram-daemon}"
if tmux has-session -t "$SESSION" >/dev/null 2>&1; then
  tmux kill-session -t "$SESSION"
  echo "Stopped $SESSION"
else
  echo "$SESSION is not running"
fi
```

- [ ] **Step 6: Write `scripts/ccgram/claude-session.sh`**

```bash
#!/usr/bin/env bash
# Launch Claude Code for a window created by ccgram.
# Loads the project env so MCP servers get their credentials, keeps the working
# directory the window was created with, and never skips permissions.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ -f "$ROOT/.env" ]; then
  set -a
  . "$ROOT/.env"
  set +a
fi
exec claude "$@"
```

- [ ] **Step 7: Update `.env.example` and `.gitignore`**

Append to `.env.example` (create the file if it is missing; do not remove existing lines):

```
# Telegram bridge (ccgram). One credentials file: keep these here with the other keys.
TELEGRAM_BOT_TOKEN=
# Comma-separated numeric Telegram user IDs, for example 123456789
ALLOWED_USERS=
# Leave CCGRAM_WHISPER_*, CCGRAM_LLM_*, CCGRAM_TTS_* and CCGRAM_MINIAPP_* unset (they stay off).
# Never add a skip-permissions flag anywhere in this project.
```

Append to `.gitignore` any of these lines that are missing:

```
.ccgram/
.env
.claude/settings.local.json
```

- [ ] **Step 8: Make scripts executable and run the test**

Run: `chmod +x scripts/ccgram/*.sh && npx vitest run tests/platform-ccgram-files.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add scripts/ccgram .env.example .gitignore tests/platform-ccgram-files.test.ts
git commit -m "feat(platform): project-local ccgram runner scripts using the single .env"
```

---

### Task 4: Project-scoped ccgram hooks

**Files:**
- Create: `src/platform/ccgramHooks.ts`
- Test: `tests/platform-ccgram-hooks.test.ts`

**Interfaces:**
- Produces:
  - `CCGRAM_EVENTS`: the nine event names
  - `hookCommand(pythonPath: string): string`
  - `mergeHooks(settings: HookSettings, pythonPath: string): HookSettings` (idempotent)
  - `removeHooks(settings: HookSettings): HookSettings`
  - `hooksStatus(settings: HookSettings): Record<string, boolean>`
  - `pythonFromShebang(line: string): string | null`
  - `resolveCcgramPython(deps: { which(name: string): string | null; readFirstLine(path: string): string }): string | null`
  - `type HookSettings = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/platform-ccgram-hooks.test.ts
import { describe, it, expect } from 'vitest';
import {
  CCGRAM_EVENTS,
  hookCommand,
  hooksStatus,
  mergeHooks,
  pythonFromShebang,
  removeHooks,
  resolveCcgramPython,
} from '../src/platform/ccgramHooks.js';

const PY = '/opt/uv/tools/ccgram/bin/python';

describe('hookCommand', () => {
  it('quotes the interpreter and calls ccgram.main hook', () => {
    expect(hookCommand(PY)).toBe(`'${PY}' -m ccgram.main hook`);
    expect(hookCommand("/a b/it's/python")).toBe(`'/a b/it'\\''s/python' -m ccgram.main hook`);
  });
});

describe('mergeHooks', () => {
  it('adds the nine events, async for the six non-blocking ones, with a 5 second timeout', () => {
    const out = mergeHooks({}, PY);
    expect(Object.keys(out.hooks ?? {}).sort()).toEqual([...CCGRAM_EVENTS].sort());
    const stop = out.hooks?.Stop[0].hooks[0];
    expect(stop).toMatchObject({ type: 'command', timeout: 5 });
    expect(stop.async).toBeUndefined();
    expect(out.hooks?.SessionEnd[0].hooks[0].async).toBe(true);
  });

  it('is idempotent and replaces a stale interpreter path', () => {
    const once = mergeHooks({}, '/old/python');
    const twice = mergeHooks(once, PY);
    expect(twice.hooks?.Stop).toHaveLength(1);
    expect(twice.hooks?.Stop[0].hooks[0].command).toContain(PY);
    expect(mergeHooks(twice, PY)).toEqual(twice);
  });

  it('keeps other hooks, such as the project block-outside-project hook', () => {
    const base = {
      hooks: {
        PreToolUse: [{ matcher: 'Read|Bash', hooks: [{ type: 'command', command: 'node block.cjs' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
      },
      permissions: { allow: ['mcp__db__get_funnel'] },
    };
    const out = mergeHooks(base, PY);
    expect(out.hooks?.PreToolUse).toEqual(base.hooks.PreToolUse);
    expect(out.hooks?.Stop).toHaveLength(2);
    expect(out.permissions).toEqual(base.permissions);
  });
});

describe('hooksStatus and removeHooks', () => {
  it('reports which events are installed', () => {
    const status = hooksStatus(mergeHooks({}, PY));
    expect(Object.values(status).every(Boolean)).toBe(true);
    expect(hooksStatus({}).Stop).toBe(false);
  });
  it('removes only ccgram hooks', () => {
    const base = mergeHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }] } }, PY);
    const out = removeHooks(base);
    expect(out.hooks?.Stop).toEqual([{ hooks: [{ type: 'command', command: 'echo done' }] }]);
    expect(out.hooks?.SessionEnd).toBeUndefined();
  });
});

describe('resolveCcgramPython', () => {
  it('reads the interpreter from the ccgram script shebang', () => {
    expect(pythonFromShebang(`#!${PY}`)).toBe(PY);
    expect(pythonFromShebang('#!/usr/bin/env python3')).toBeNull();
    expect(pythonFromShebang('not a shebang')).toBeNull();
    const deps = { which: () => '/opt/bin/ccgram', readFirstLine: () => `#!${PY}` };
    expect(resolveCcgramPython(deps)).toBe(PY);
    expect(resolveCcgramPython({ ...deps, which: () => null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/platform-ccgram-hooks.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `ccgramHooks.ts`**

```ts
// src/platform/ccgramHooks.ts
export const CCGRAM_EVENTS = [
  'SessionStart',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'TaskCompleted',
] as const;

const ASYNC_EVENTS = new Set<string>([
  'StopFailure',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'TaskCompleted',
]);

const CCGRAM_MARKER = /ccgram\.main hook\b/;

export interface HookEntry {
  type: string;
  command: string;
  timeout?: number;
  async?: boolean;
}
export interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
export interface HookSettings {
  hooks?: Record<string, HookGroup[]>;
  [k: string]: unknown;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function hookCommand(pythonPath: string): string {
  return `${shellQuote(pythonPath)} -m ccgram.main hook`;
}

const isCcgramGroup = (group: HookGroup): boolean => group.hooks.some((h) => CCGRAM_MARKER.test(h.command));

export function removeHooks(settings: HookSettings): HookSettings {
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = groups.filter((g) => !isCcgramGroup(g));
    if (kept.length > 0) hooks[event] = kept;
  }
  return { ...settings, hooks };
}

export function mergeHooks(settings: HookSettings, pythonPath: string): HookSettings {
  const cleaned = removeHooks(settings);
  const hooks = { ...(cleaned.hooks ?? {}) };
  for (const event of CCGRAM_EVENTS) {
    const entry: HookEntry = { type: 'command', command: hookCommand(pythonPath), timeout: 5 };
    if (ASYNC_EVENTS.has(event)) entry.async = true;
    hooks[event] = [...(hooks[event] ?? []), { hooks: [entry] }];
  }
  return { ...cleaned, hooks };
}

export function hooksStatus(settings: HookSettings): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const event of CCGRAM_EVENTS) {
    out[event] = (settings.hooks?.[event] ?? []).some(isCcgramGroup);
  }
  return out;
}

export function pythonFromShebang(line: string): string | null {
  const m = /^#!\s*(\/\S*python[\d.]*)\s*$/.exec(line.trim());
  return m ? m[1] : null;
}

export function resolveCcgramPython(deps: {
  which(name: string): string | null;
  readFirstLine(path: string): string;
}): string | null {
  const exe = deps.which('ccgram');
  if (!exe) return null;
  return pythonFromShebang(deps.readFirstLine(exe));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/platform-ccgram-hooks.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/platform/ccgramHooks.ts tests/platform-ccgram-hooks.test.ts
git commit -m "feat(platform): project-scoped ccgram hook merge, status and interpreter resolution"
```

---

### Task 5: Doctor framework and checks

**Files:**
- Create: `src/platform/envFile.ts`, `src/platform/doctor.ts`, `src/platform/checks.ts`, `scripts/doctor.ts`
- Modify: `package.json` (scripts)
- Test: `tests/platform-doctor.test.ts`

**Interfaces:**
- Consumes: `Run`, `hasSession` from Task 1; `detectSet`, `RawSets` from Task 2; `hooksStatus` from Task 4.
- Produces:
  - `parseEnv(text: string): Record<string, string>`
  - `type Status = 'pass' | 'warn' | 'fail'`, `CheckResult = { status: Status; detail: string; fix?: string }`
  - `DoctorContext = { root: string; env: NodeJS.ProcessEnv; run: Run; fs: { exists(p: string): boolean; read(p: string): string; mode(p: string): number | null } }`
  - `Check = { id: string; title: string; run(ctx: DoctorContext): Promise<CheckResult> }`
  - `runChecks(checks: Check[], ctx): Promise<{ id: string; title: string; result: CheckResult }[]>`, `exitCode(results): number`, `formatReport(results): string`
  - `ccgramChecks: Check[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/platform-doctor.test.ts
import { describe, it, expect } from 'vitest';
import { exitCode, formatReport, runChecks, type DoctorContext } from '../src/platform/doctor.js';
import { ccgramChecks } from '../src/platform/checks.js';
import { parseEnv } from '../src/platform/envFile.js';
import { applySet } from '../src/platform/permissions.js';
import { mergeHooks } from '../src/platform/ccgramHooks.js';
import type { RawSets } from '../src/platform/permissions.js';

const sets: RawSets = {
  read_only: { allow: ['mcp__db__get_funnel'] },
  outreach_send: { extends: 'read_only', allow: ['mcp__gmail__send_email'] },
  full: { extends: 'outreach_send', allow: ['mcp__gmail'] },
};

interface Files {
  [path: string]: { text: string; mode?: number };
}

function ctxWith(
  files: Files,
  opts: { tmux?: boolean; session?: boolean; version?: string; env?: NodeJS.ProcessEnv } = {},
): DoctorContext {
  return {
    root: '/p',
    env: opts.env ?? {},
    run: async (cmd, args) => {
      if (cmd === 'tmux' && args[0] === '-V') return { stdout: 'tmux 3.4', code: opts.tmux === false ? 1 : 0 };
      if (cmd === 'tmux' && args[0] === 'has-session') return { stdout: '', code: opts.session ? 0 : 1 };
      if (cmd === 'ccgram') return { stdout: `ccgram ${opts.version ?? '1.2.3'}`, code: 0 };
      return { stdout: '', code: 1 };
    },
    fs: {
      exists: (p) => p in files,
      read: (p) => files[p].text,
      mode: (p) => (p in files ? (files[p].mode ?? 0o600) : null),
    },
  };
}

const GOOD_ENV = 'TELEGRAM_BOT_TOKEN=123456:SECRET-TOKEN-VALUE\nALLOWED_USERS=111,222\nGMAIL_APP_PASSWORD=OTHER-SECRET-VALUE\n';
const goodFiles = (): Files => ({
  '/p/.env': { text: GOOD_ENV, mode: 0o600 },
  '/p/config/ccgram.pin.json': { text: JSON.stringify({ version: '1.2.3' }) },
  '/p/config/permission-sets.json': { text: JSON.stringify(sets) },
  '/p/.claude/settings.local.json': {
    text: JSON.stringify(mergeHooks(applySet({}, sets, 'read_only'), '/py/python')),
  },
  '/p/.gitignore': { text: '.ccgram/\n.env\n.claude/settings.local.json\n' },
  '/p/scripts/ccgram/claude-session.sh': { text: '#!/usr/bin/env bash\nexec claude "$@"\n' },
});

const byId = async (ctx: DoctorContext) => {
  const results = await runChecks(ccgramChecks, ctx);
  return Object.fromEntries(results.map((r) => [r.id, r.result]));
};

describe('parseEnv', () => {
  it('parses keys, quotes and comments', () => {
    expect(parseEnv('# c\nA=1\nB="two words"\n\nC=\n')).toEqual({ A: '1', B: 'two words', C: '' });
  });
});

describe('ccgram checks', () => {
  it('passes a correct setup', async () => {
    const r = await byId(ctxWith(goodFiles(), { session: true }));
    for (const [id, result] of Object.entries(r)) expect(result.status, id).not.toBe('fail');
    expect(r['ccgram-env'].status).toBe('pass');
    expect(r['permission-set'].detail).toContain('read_only');
  });

  it('fails when tmux is missing', async () => {
    expect((await byId(ctxWith(goodFiles(), { tmux: false })))['tmux'].status).toBe('fail');
  });

  it('fails when the installed ccgram does not match the pin', async () => {
    expect((await byId(ctxWith(goodFiles(), { version: '9.9.9' })))['ccgram-version'].status).toBe('fail');
  });

  it('fails when .env is group or world readable, or the token or allowlist is bad', async () => {
    const loose = goodFiles();
    loose['/p/.env'] = { text: GOOD_ENV, mode: 0o644 };
    expect((await byId(ctxWith(loose)))['ccgram-env'].status).toBe('fail');
    const bad = goodFiles();
    bad['/p/.env'] = { text: 'TELEGRAM_BOT_TOKEN=abc\nALLOWED_USERS=bob\n', mode: 0o600 };
    expect((await byId(ctxWith(bad)))['ccgram-env'].status).toBe('fail');
    const empty = goodFiles();
    empty['/p/.env'] = { text: 'TELEGRAM_BOT_TOKEN=abc\nALLOWED_USERS=\n', mode: 0o600 };
    expect((await byId(ctxWith(empty)))['ccgram-env'].status).toBe('fail');
    const noToken = goodFiles();
    noToken['/p/.env'] = { text: 'ALLOWED_USERS=111\n', mode: 0o600 };
    expect((await byId(ctxWith(noToken)))['ccgram-env'].status).toBe('fail');
  });

  it('reports a second credentials file left in the ccgram state dir', async () => {
    const files = goodFiles();
    files['/p/.ccgram/.env'] = { text: 'TELEGRAM_BOT_TOKEN=x\n', mode: 0o600 };
    expect((await byId(ctxWith(files)))['single-credentials-file'].status).toBe('fail');
    expect((await byId(ctxWith(goodFiles())))['single-credentials-file'].status).toBe('pass');
  });

  it('fails on skip-permissions anywhere and on enabled optional features', async () => {
    const yolo = goodFiles();
    yolo['/p/.env'] = {
      text: GOOD_ENV + 'CCGRAM_CLAUDE_COMMAND=claude --dangerously-skip-permissions\n',
      mode: 0o600,
    };
    expect((await byId(ctxWith(yolo)))['no-skip-permissions'].status).toBe('fail');
    const voice = goodFiles();
    voice['/p/.env'] = { text: GOOD_ENV + 'CCGRAM_WHISPER_PROVIDER=openai\n', mode: 0o600 };
    expect((await byId(ctxWith(voice)))['optional-features-off'].status).toBe('fail');
  });

  it('warns when hooks are missing, the set is custom or full, or the daemon is stopped', async () => {
    const files = goodFiles();
    files['/p/.claude/settings.local.json'] = { text: JSON.stringify(applySet({}, sets, 'full')) };
    const r = await byId(ctxWith(files, { session: false }));
    expect(r['project-hooks'].status).toBe('warn');
    expect(r['permission-set'].status).toBe('warn');
    expect(r['daemon'].status).toBe('warn');
  });

  it('fails when .gitignore lacks the required rules', async () => {
    const files = goodFiles();
    files['/p/.gitignore'] = { text: 'node_modules\n' };
    expect((await byId(ctxWith(files)))['gitignore'].status).toBe('fail');
  });

  it('never prints the token or any other secret value', async () => {
    const results = await runChecks(ccgramChecks, ctxWith(goodFiles(), { session: true }));
    for (const secret of ['SECRET-TOKEN-VALUE', 'OTHER-SECRET-VALUE']) {
      expect(formatReport(results)).not.toContain(secret);
      expect(JSON.stringify(results)).not.toContain(secret);
    }
  });

  it('turns a thrown error into a failed check, and exit code reflects failures', async () => {
    const ctx = ctxWith({});
    const results = await runChecks(ccgramChecks, ctx);
    expect(results.every((r) => r.result.status)).toBe(true);
    expect(exitCode(results)).toBe(1);
    expect(exitCode(await runChecks(ccgramChecks, ctxWith(goodFiles(), { session: true })))).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/platform-doctor.test.ts`
Expected: FAIL (modules not found).

- [ ] **Step 3: Write `envFile.ts`**

```ts
// src/platform/envFile.ts
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
```

- [ ] **Step 4: Write `doctor.ts`**

```ts
// src/platform/doctor.ts
import type { Run } from './tmux.js';

export type Status = 'pass' | 'warn' | 'fail';
export interface CheckResult {
  status: Status;
  detail: string;
  fix?: string;
}
export interface DoctorContext {
  root: string;
  env: NodeJS.ProcessEnv;
  run: Run;
  fs: {
    exists(path: string): boolean;
    read(path: string): string;
    mode(path: string): number | null;
  };
}
export interface Check {
  id: string;
  title: string;
  run(ctx: DoctorContext): Promise<CheckResult>;
}
export interface CheckOutcome {
  id: string;
  title: string;
  result: CheckResult;
}

export async function runChecks(checks: Check[], ctx: DoctorContext): Promise<CheckOutcome[]> {
  const out: CheckOutcome[] = [];
  for (const check of checks) {
    try {
      out.push({ id: check.id, title: check.title, result: await check.run(ctx) });
    } catch (err) {
      out.push({
        id: check.id,
        title: check.title,
        result: { status: 'fail', detail: `check crashed: ${err instanceof Error ? err.message : String(err)}` },
      });
    }
  }
  return out;
}

export function exitCode(results: CheckOutcome[]): number {
  return results.some((r) => r.result.status === 'fail') ? 1 : 0;
}

const ICON: Record<Status, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };

export function formatReport(results: CheckOutcome[]): string {
  return results
    .map((r) => {
      const fix = r.result.fix ? `\n       fix: ${r.result.fix}` : '';
      return `${ICON[r.result.status]}  ${r.title}: ${r.result.detail}${fix}`;
    })
    .join('\n');
}
```

- [ ] **Step 5: Write `checks.ts`**

```ts
// src/platform/checks.ts
import { join } from 'node:path';
import type { Check, CheckResult, DoctorContext } from './doctor.js';
import { parseEnv } from './envFile.js';
import { hooksStatus, type HookSettings } from './ccgramHooks.js';
import { detectSet, type RawSets } from './permissions.js';
import { hasSession } from './tmux.js';

const pass = (detail: string): CheckResult => ({ status: 'pass', detail });
const warn = (detail: string, fix?: string): CheckResult => ({ status: 'warn', detail, fix });
const fail = (detail: string, fix?: string): CheckResult => ({ status: 'fail', detail, fix });

const envPath = (ctx: DoctorContext): string => join(ctx.root, '.env');
const settingsPath = (ctx: DoctorContext): string => join(ctx.root, '.claude', 'settings.local.json');

function readEnv(ctx: DoctorContext): Record<string, string> | null {
  return ctx.fs.exists(envPath(ctx)) ? parseEnv(ctx.fs.read(envPath(ctx))) : null;
}

const SKIP_FLAG = /dangerously-skip-permissions|bypassPermissions/;

export const ccgramChecks: Check[] = [
  {
    id: 'tmux',
    title: 'tmux installed',
    async run(ctx) {
      const r = await ctx.run('tmux', ['-V']);
      return r.code === 0 ? pass(r.stdout.trim()) : fail('tmux not found', 'brew install tmux');
    },
  },
  {
    id: 'ccgram-version',
    title: 'ccgram matches the pinned version',
    async run(ctx) {
      const pinPath = join(ctx.root, 'config', 'ccgram.pin.json');
      if (!ctx.fs.exists(pinPath)) return fail('config/ccgram.pin.json is missing');
      const pin = JSON.parse(ctx.fs.read(pinPath)) as { version: string };
      const r = await ctx.run('ccgram', ['--version']);
      if (r.code !== 0) return fail('ccgram is not installed', `uv tool install --python 3.14 "ccgram==${pin.version}"`);
      return r.stdout.includes(pin.version)
        ? pass(`pinned ${pin.version}`)
        : fail(`installed version differs from pin ${pin.version}`, `uv tool install --python 3.14 "ccgram==${pin.version}"`);
    },
  },
  {
    id: 'ccgram-env',
    title: 'bridge credentials in the project .env',
    async run(ctx) {
      const env = readEnv(ctx);
      if (!env) return fail('.env is missing', 'copy .env.example to .env and fill it in');
      const mode = ctx.fs.mode(envPath(ctx));
      if (mode !== null && (mode & 0o077) !== 0) return fail('.env is readable by others', 'chmod 600 .env');
      if (!env.TELEGRAM_BOT_TOKEN) return fail('TELEGRAM_BOT_TOKEN is not set in .env');
      const ids = (env.ALLOWED_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) return fail('ALLOWED_USERS is empty', 'set your numeric Telegram user ID');
      if (!ids.every((id) => /^\d+$/.test(id))) return fail('ALLOWED_USERS must be numeric IDs only');
      return pass(`token present, ${ids.length} allowed user(s)`);
    },
  },
  {
    id: 'single-credentials-file',
    title: 'credentials live only in the project .env',
    async run(ctx) {
      return ctx.fs.exists(join(ctx.root, '.ccgram', '.env'))
        ? fail('.ccgram/.env exists', 'move its keys into the project .env and delete it')
        : pass('no second .env');
    },
  },
  {
    id: 'no-skip-permissions',
    title: 'no skip-permissions flag anywhere',
    async run(ctx) {
      const env = readEnv(ctx) ?? {};
      const wrapper = join(ctx.root, 'scripts', 'ccgram', 'claude-session.sh');
      const texts = [
        env.CCGRAM_CLAUDE_COMMAND ?? '',
        ctx.env.CCGRAM_CLAUDE_COMMAND ?? '',
        ctx.fs.exists(wrapper) ? ctx.fs.read(wrapper) : '',
      ];
      return texts.some((t) => SKIP_FLAG.test(t))
        ? fail('a skip-permissions flag is configured', 'remove it from CCGRAM_CLAUDE_COMMAND and the wrapper')
        : pass('none found');
    },
  },
  {
    id: 'optional-features-off',
    title: 'voice, LLM, TTS and Mini App are off',
    async run(ctx) {
      const env = readEnv(ctx) ?? {};
      const on = ['CCGRAM_WHISPER_PROVIDER', 'CCGRAM_LLM_PROVIDER', 'CCGRAM_TTS_PROVIDER', 'CCGRAM_MINIAPP_BASE_URL'].filter(
        (k) => (env[k] ?? '').trim() !== '',
      );
      return on.length ? fail(`enabled: ${on.join(', ')}`, 'unset these in .env') : pass('all unset');
    },
  },
  {
    id: 'project-hooks',
    title: 'ccgram hooks installed in the project',
    async run(ctx) {
      if (!ctx.fs.exists(settingsPath(ctx))) return warn('.claude/settings.local.json does not exist', 'run setup to install hooks');
      const status = hooksStatus(JSON.parse(ctx.fs.read(settingsPath(ctx))) as HookSettings);
      const missing = Object.entries(status).filter(([, ok]) => !ok).map(([e]) => e);
      return missing.length ? warn(`missing events: ${missing.join(', ')}`, 'run setup to install hooks') : pass('all nine events');
    },
  },
  {
    id: 'permission-set',
    title: 'permission set',
    async run(ctx) {
      const setsPath = join(ctx.root, 'config', 'permission-sets.json');
      if (!ctx.fs.exists(setsPath)) return fail('config/permission-sets.json is missing');
      if (!ctx.fs.exists(settingsPath(ctx))) return warn('no .claude/settings.local.json yet', 'run setup to choose a permission set');
      const set = detectSet(JSON.parse(ctx.fs.read(settingsPath(ctx))), JSON.parse(ctx.fs.read(setsPath)) as RawSets);
      if (set === 'custom') return warn('allow list matches no named set (custom)');
      if (set === 'full') return warn('full: every tool, including Gmail and LinkedIn send, is allowed');
      return pass(set);
    },
  },
  {
    id: 'gitignore',
    title: '.gitignore protects local files',
    async run(ctx) {
      const path = join(ctx.root, '.gitignore');
      const text = ctx.fs.exists(path) ? ctx.fs.read(path) : '';
      const need = ['.ccgram/', '.env', '.claude/settings.local.json'];
      const lines = text.split('\n').map((l) => l.trim());
      const missing = need.filter((rule) => !lines.includes(rule));
      return missing.length ? fail(`missing rules: ${missing.join(', ')}`, 'add them to .gitignore') : pass('rules present');
    },
  },
  {
    id: 'daemon',
    title: 'ccgram is running',
    async run(ctx) {
      return (await hasSession(ctx.run, 'ccgram-daemon'))
        ? pass('tmux session ccgram-daemon is up')
        : warn('not running', 'bash scripts/ccgram/start.sh');
    },
  },
];
```

- [ ] **Step 6: Write the CLI and the npm script**

```ts
// scripts/doctor.ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ccgramChecks } from '../src/platform/checks.js';
import { exitCode, formatReport, runChecks, type DoctorContext } from '../src/platform/doctor.js';
import { defaultRun } from '../src/platform/tmux.js';

const ctx: DoctorContext = {
  root: resolve(import.meta.dirname, '..'),
  env: process.env,
  run: defaultRun,
  fs: {
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, 'utf8'),
    mode: (p) => (existsSync(p) ? statSync(p).mode & 0o777 : null),
  },
};

const results = await runChecks(ccgramChecks, ctx);
console.log(formatReport(results));
process.exit(exitCode(results));
```

In `package.json`, add to `scripts`:

```json
"doctor": "tsx scripts/doctor.ts"
```

- [ ] **Step 7: Run tests, the type check and the CLI**

Run: `npx vitest run tests/platform-doctor.test.ts && npx tsc -p . --noEmit && npm run doctor`
Expected: tests PASS, no type errors. The CLI prints a report; failing lines are expected until ccgram is installed, the Telegram keys are in `.env` and hooks are installed (Task 6).

- [ ] **Step 8: Commit**

```bash
git add src/platform/envFile.ts src/platform/doctor.ts src/platform/checks.ts scripts/doctor.ts package.json tests/platform-doctor.test.ts
git commit -m "feat(platform): doctor framework with ccgram, tmux, hooks and permission checks"
```

---

### Task 6: Live wiring check (manual, owner present)

**Files:** none created; records the result in `docs/superpowers/specs/2026-10-14-ccgram-review.md` (append a "Live check" section).

This task needs the owner (a real Telegram bot and a real Telegram account). Do not run it unattended.

- [ ] **Step 1: Create the bot and add the keys**

Follow the BotFather steps: `/newbot`, then `/mybots`, Bot Settings: enable Topics (private chat), disable Group Privacy. Get your numeric user ID from @userinfobot. Add `TELEGRAM_BOT_TOKEN` and `ALLOWED_USERS` to the project `.env`. Do not paste the token into the chat.

- [ ] **Step 2: Install the project-scoped hooks**

In a Node REPL or a one-off `npx tsx -e` script, resolve the interpreter with `resolveCcgramPython`, merge with `mergeHooks`, and write the result into `.claude/settings.local.json` (back it up first). Then apply the owner's chosen permission set with `applySetToFile('.claude/settings.local.json', sets, 'read_only')`.

- [ ] **Step 3: Start ccgram and open a session from Telegram**

Run `bash scripts/ccgram/start.sh`, then in Telegram create a topic and send a message, pick the project directory in the browser, choose the Claude provider and Standard mode. Confirm a tmux window appears (`tmux list-windows -t ccgram`).

- [ ] **Step 4: Verify the hooks fire at project level**

Check that `.ccgram/session_map.json` has an entry for the new session and `.ccgram/events.jsonl` receives events. If nothing is written, project-level hooks do not work: restore `.claude/settings.local.json` from its backup, back up `~/.claude/settings.json`, and run `ccgram hook --install` once (global), then record that decision. If events arrive, record "project-level hooks verified".

- [ ] **Step 5: Verify the safety properties**

Confirm: a Telegram message from a second, non-allowlisted account gets no response; the Claude window started without any skip-permissions flag (`tmux capture-pane`, `ps`); MCP tools from the project load in the window (the wrapper sourced `.env`); ccgram's process environment contains only the bridge keys (check `ps eww` for the ccgram process, and confirm no Gmail or search keys appear); `ccgram` accepts the absolute wrapper path as its Claude command (its own doctor check "provider command on PATH" may complain; that is expected and is not a reason to add it to PATH); `npm run doctor` shows no FAIL.

- [ ] **Step 6: Commit the result**

```bash
git add docs/superpowers/specs/2026-10-14-ccgram-review.md
git commit -m "docs: ccgram live wiring check result"
```

---

## Self-review

- **Spec coverage:** ccgram from the start, pinned and reviewed (T1); everything in tmux with a helper the manager and dashboard can reuse (T1); named permission sets written to `settings.local.json`, default read-only, never Bash (T2); ccgram running inside the project with a stripped environment, state only in `.ccgram/`, and the single `.env` as the one credentials file (T3); project-scoped hooks (T4); `doctor` with the ccgram, tmux, hooks, permission and gitignore checks plus a second-credentials-file check (T5); live verification including the non-allowlisted-user test and the process-environment check (T6). Not in this plan, by design: the setup wizard, dashboard, `AUTO_UPDATE`, backup, and the manager skill (later plans).
- **Placeholder scan:** the only placeholder is the version `X.Y.Z` in T1, which is produced by the review step; every code step is complete.
- **Type consistency:** `Run` is defined in T1 and used in T5; `RawSets` and `detectSet` come from T2; `hooksStatus` and `HookSettings` come from T4; the doctor check ids used in tests match `checks.ts`.
- **Review Focus coverage:** 1 to T3 (lint test) and T6; 2 and 3 to T2; 4 to T4; 5 to T1; 6 and 7 to T5.

## Subsequent plans

- **7B, setup wizard and manager skill:** the `setup` command and the conversational Claude skill (resume import, job and salary questions, limits), using the permission-set and hook writers from this plan; a tmux-manager skill built from the tmux helper (candidate reference: `mitsuhiko/agent-stuff` `skills/tmux`, read before use).
- **7C, read-only dashboard:** local web server on a read-only SQLite handle, login with password and TOTP, tmux session panel from the tmux helper.
- **7D, `AUTO_UPDATE` and backup:** the guarded daily updater and the backup of the SQLite database, `settings.local.json`, user config and preferences, encrypted before it leaves the machine.
