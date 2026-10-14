// tests/setup-suspend.test.ts
// ttyIO suspend/resume around an interactive child (C1 of the final 7B review).
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { spawnSuspended } from '../src/setup/cli.js';
import { ttyIO } from '../src/setup/io.js';

const tick = (ms = 10): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('ttyIO suspend/resume around a child process', () => {
  it('releases the input during the child and drops type-ahead before later prompts', async () => {
    const input = new PassThrough();
    const io = ttyIO(input, new PassThrough());
    input.write('first\n');
    expect(await io.ask('one?')).toBe('first');
    // a line already buffered before the spawn must not survive either
    input.write('stale\n');
    await tick();
    let released = false;
    const code = await spawnSuspended(io, async () => {
      input.write('typed-during-child\n'); // the child owns the terminal now
      await tick();
      released = input.listenerCount('data') === 0 && input.listenerCount('keypress') === 0;
      return 7;
    });
    expect(code).toBe(7);
    expect(released).toBe(true);
    const p = io.ask('two?');
    setTimeout(() => input.write('real answer\n'), 10);
    expect(await p).toBe('real answer');
    io.close();
  });

  it('resumes even when the spawn throws', async () => {
    const input = new PassThrough();
    const io = ttyIO(input, new PassThrough());
    await expect(
      spawnSuspended(io, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const p = io.ask('q?');
    input.write('ok\n');
    expect(await p).toBe('ok');
    io.close();
  });
});
