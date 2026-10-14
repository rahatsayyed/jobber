import { describe, it, expect } from 'vitest';
import { defaultExec } from '../src/lib/exec.js';

describe('defaultExec', () => {
  it('returns stdout and code 0', async () => {
    const r = await defaultExec(process.execPath, ['-e', 'process.stdout.write("hi")']);
    expect(r).toMatchObject({ stdout: 'hi', code: 0 });
  });
  it('returns the real nonzero code and 127 for a missing binary, without throwing', async () => {
    expect((await defaultExec(process.execPath, ['-e', 'process.exit(3)'])).code).toBe(3);
    expect((await defaultExec('definitely-not-a-binary-xyz', [])).code).toBe(127);
  });
  it('kills on timeout', async () => {
    const r = await defaultExec(process.execPath, ['-e', 'setTimeout(()=>{},5000)'], { timeoutMs: 200 });
    expect(r.code).not.toBe(0);
  });
});
