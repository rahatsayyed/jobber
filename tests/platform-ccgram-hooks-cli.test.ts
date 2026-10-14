import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runHooksCli, hooksSettingsPathFor, type HooksCliDeps } from '../src/platform/ccgramHooksCli.js';
import { CCGRAM_EVENTS } from '../src/platform/ccgramHooks.js';

const base = resolve(import.meta.dirname, '..', '.superpowers');
let root: string;
let settings: string;

function deps(over: Partial<HooksCliDeps> = {}, py = '/opt/ccgram/bin/python3'): HooksCliDeps {
  return {
    which: (n) => (n === 'ccgram' ? '/fake/bin/ccgram' : null),
    readFirstLine: () => `#!${py}`,
    ccgramVersion: () => 'ccgram 4.16.0\n',
    pinVersion: () => '4.16.0',
    ...over,
  };
}

beforeEach(() => {
  mkdirSync(base, { recursive: true });
  root = mkdtempSync(join(base, 'hooks-cli-'));
  mkdirSync(join(root, '.claude'));
  settings = hooksSettingsPathFor(root);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('ccgram hooks cli', () => {
  it('install then status shows all nine', () => {
    const r = runHooksCli(['install'], root, deps());
    expect(r.code).toBe(0);
    const s = runHooksCli([], root, deps());
    expect(s.lines[0]).toBe('ccgram hooks present: 9/9');
    for (const e of CCGRAM_EVENTS) expect(s.lines[1]).toContain(e);
  });

  it('install is idempotent', () => {
    runHooksCli(['install'], root, deps());
    const first = readFileSync(settings, 'utf8');
    runHooksCli(['install'], root, deps());
    expect(readFileSync(settings, 'utf8')).toBe(first);
  });

  it('replaces a stale interpreter path', () => {
    runHooksCli(['install'], root, deps({}, '/old/python3'));
    runHooksCli(['install'], root, deps({}, '/new/python3'));
    const text = readFileSync(settings, 'utf8');
    expect(text).toContain('/new/python3');
    expect(text).not.toContain('/old/python3');
  });

  it('warns on version mismatch and installs anyway', () => {
    const r = runHooksCli(['install'], root, deps({ ccgramVersion: () => 'ccgram 4.17.0' }));
    expect(r.code).toBe(0);
    expect(r.lines[0]).toBe('WARN: ccgram 4.17.0 differs from pinned 4.16.0; hooks installed anyway');
    expect(r.lines.join('\n')).toContain('ccgram hooks present: 9/9');
    expect(existsSync(settings)).toBe(true);
  });

  it('fails and writes nothing when the version cannot be read', () => {
    const r = runHooksCli(
      ['install'],
      root,
      deps({
        ccgramVersion: () => {
          throw new Error('boom');
        },
      }),
    );
    expect(r.code).toBe(1);
    expect(existsSync(settings)).toBe(false);
    expect(readdirSync(join(root, '.claude'))).toEqual([]);
  });

  it('remove keeps a user hook', () => {
    writeFileSync(
      settings,
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } }),
    );
    runHooksCli(['install'], root, deps());
    const r = runHooksCli(['remove'], root, deps());
    expect(r.code).toBe(0);
    const out = JSON.parse(readFileSync(settings, 'utf8'));
    expect(out.hooks.Stop[0].hooks[0].command).toBe('echo mine');
    expect(Object.keys(out.hooks)).toEqual(['Stop']);
    expect(r.lines.join('\n')).toContain('ccgram hooks present: 0/9');
  });

  it('unknown command prints usage', () => {
    expect(runHooksCli(['upgrade'], root, deps()).code).toBe(1);
  });
});
