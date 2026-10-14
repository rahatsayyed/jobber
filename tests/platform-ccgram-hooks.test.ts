// tests/platform-ccgram-hooks.test.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CCGRAM_EVENTS,
  hookCommand,
  hooksStatus,
  installHooksToFile,
  mergeHooks,
  pythonFromShebang,
  removeHooks,
  removeHooksFromFile,
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
    expect(stop?.async).toBeUndefined();
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

  it('keeps a user hook that shares a group with a ccgram entry', () => {
    const mixed = {
      hooks: {
        Stop: [
          {
            hooks: [
              { type: 'command', command: `'/old/python' -m ccgram.main hook` },
              { type: 'command', command: 'echo mine' },
            ],
          },
        ],
      },
    };
    const out = mergeHooks(mixed, PY);
    const cmds = out.hooks?.Stop.flatMap((g) => g.hooks.map((h) => h.command));
    expect(cmds).toContain('echo mine');
    expect(cmds?.filter((c) => c.includes('ccgram.main hook'))).toHaveLength(1);
    expect(cmds?.some((c) => c.includes('/old/python'))).toBe(false);
  });

  it('refuses wrong-typed hooks shapes instead of crashing', () => {
    expect(() => mergeHooks({ hooks: 'x' as never }, PY)).toThrow(/hooks/);
    expect(() => mergeHooks({ hooks: { Stop: 'x' as never } }, PY)).toThrow(/Stop/);
    expect(() => mergeHooks({ hooks: { Stop: [{ hooks: 'x' as never }] } }, PY)).toThrow(/Stop/);
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

describe('settings file install/remove', () => {
  const dir = join(process.cwd(), '.superpowers', 'tmp-ccgram-hooks-test');
  const file = join(dir, 'settings.local.json');
  beforeEach(() => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the file 0600 and keeps user content, idempotently', () => {
    writeFileSync(file, JSON.stringify({ permissions: { allow: ['mcp__db__x'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo u' }] }] } }));
    installHooksToFile(file, PY);
    installHooksToFile(file, PY);
    const out = JSON.parse(readFileSync(file, 'utf8'));
    expect(out.permissions.allow).toEqual(['mcp__db__x']);
    expect(out.hooks.Stop).toHaveLength(2);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBe(false);
    removeHooksFromFile(file);
    const after = JSON.parse(readFileSync(file, 'utf8'));
    expect(after.hooks.Stop).toHaveLength(1);
    expect(after.hooks.SessionEnd).toBeUndefined();
  });

  it('works when the file does not exist yet', () => {
    installHooksToFile(file, PY);
    expect(hooksStatus(JSON.parse(readFileSync(file, 'utf8'))).Stop).toBe(true);
  });

  it('backs up and refuses invalid JSON without overwriting', () => {
    writeFileSync(file, '{ not json');
    expect(() => installHooksToFile(file, PY)).toThrow(/not valid JSON/);
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
    expect(readdirSync(dir).some((f) => f.endsWith('.invalid.bak'))).toBe(true);
  });

  it('backs up and refuses a wrong-typed hooks shape', () => {
    writeFileSync(file, JSON.stringify({ hooks: [] }));
    expect(() => installHooksToFile(file, PY)).toThrow(/hooks/);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ hooks: [] });
    expect(readdirSync(dir).some((f) => f.endsWith('.invalid.bak'))).toBe(true);
  });
});
