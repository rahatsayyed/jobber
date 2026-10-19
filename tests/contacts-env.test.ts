import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTACTS_ENV_KEYS, loadContactsEnv } from '../src/lib/contactsEnv.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-cenv-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const write = (text: string): string => { const p = path.join(dir, '.env'); fs.writeFileSync(p, text, { mode: 0o600 }); return p; };

describe('loadContactsEnv', () => {
  it('loads only the allowlisted Serper and Hunter keys and nothing else', () => {
    const file = write('SERPER_API_KEY=sk-test\nHUNTER_API_KEY="hk-test"\nGMAIL_PASS=leak\nANTHROPIC_API_KEY=leak2\nHUNTER_ENABLED=true\nDORK_ENABLED=false\n');
    const env: Record<string, string | undefined> = {};
    const loaded = loadContactsEnv(env, file);
    expect(env).toEqual({ SERPER_API_KEY: 'sk-test', HUNTER_API_KEY: 'hk-test', HUNTER_ENABLED: 'true' });
    expect(loaded.sort()).toEqual(['HUNTER_API_KEY', 'HUNTER_ENABLED', 'SERPER_API_KEY']);
    expect(CONTACTS_ENV_KEYS).not.toContain('GMAIL_PASS');
  });
  it('process env wins over the file, and an empty process value counts as unset', () => {
    const file = write('SERPER_API_KEY=from-file\nHUNTER_API_KEY=from-file\n');
    const env: Record<string, string | undefined> = { SERPER_API_KEY: 'from-process', HUNTER_API_KEY: '' };
    loadContactsEnv(env, file);
    expect(env.SERPER_API_KEY).toBe('from-process');
    expect(env.HUNTER_API_KEY).toBe('from-file');
  });
  it('a missing file changes nothing and never throws', () => {
    const env: Record<string, string | undefined> = {};
    expect(loadContactsEnv(env, path.join(dir, 'nope'))).toEqual([]);
    expect(env).toEqual({});
  });
});
