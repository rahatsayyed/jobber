// tests/setup-io.test.ts
// Prompt IO: scripted double, redaction wrapper and the readline implementation (PassThrough only).
import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { redactingIO, scriptedIO, ttyIO, type SetupIO } from '../src/setup/io.js';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

describe('scriptedIO', () => {
  it('consumes answers in order', async () => {
    const io = scriptedIO([{ ask: 'a' }, { secret: 's3cret-value' }, { confirm: true }, { choose: 'two' }, { pause: true }]);
    expect(await io.ask('q1')).toBe('a');
    expect(await io.askSecret('q2')).toBe('s3cret-value');
    expect(await io.confirm('q3')).toBe(true);
    expect(await io.choose('q4', [{ value: 'one', label: 'One' }, { value: 'two', label: 'Two' }])).toBe('two');
    await io.pause('q5');
    io.assertDone();
  });

  it('throws a readable error on the wrong prompt type', async () => {
    const io = scriptedIO([{ confirm: true }]);
    await expect(io.ask('Name?')).rejects.toThrow(/unexpected ask.*Name\?.*confirm/s);
  });

  it('throws when the script is exhausted', async () => {
    const io = scriptedIO([]);
    await expect(io.ask('Name?')).rejects.toThrow(/no scripted answer/);
  });

  it('assertDone throws on leftover answers', () => {
    const io = scriptedIO([{ ask: 'x' }]);
    expect(() => io.assertDone()).toThrow(/1 unused/);
  });

  it('never records a secret answer in the transcript', async () => {
    const io = scriptedIO([{ secret: 'hunter2-long-secret' }]);
    io.say('hello');
    await io.askSecret('Token?');
    const t = io.transcript.join('\n');
    expect(t).toContain('Token?');
    expect(t).toContain('hello');
    expect(t).not.toContain('hunter2-long-secret');
  });

  it('uses the default for an empty ask answer and rejects a choose outside the options', async () => {
    const io = scriptedIO([{ ask: '' }, { choose: 'zzz' }]);
    expect(await io.ask('q', { default: 'dflt' })).toBe('dflt');
    await expect(io.choose('c', [{ value: 'a', label: 'A' }])).rejects.toThrow(/not one of/);
  });

  it('runs the validation loop: reject twice then accept consumes three answers', async () => {
    const io = scriptedIO([{ ask: 'bad' }, { ask: 'bad' }, { ask: 'good' }]);
    const v = (s: string) => (s === 'good' ? null : 'nope');
    expect(await io.ask('q', { validate: v })).toBe('good');
    io.assertDone();
  });

  it('throws Too many invalid answers on a fourth failure', async () => {
    const io = scriptedIO([{ ask: 'b' }, { ask: 'b' }, { ask: 'b' }, { ask: 'b' }]);
    await expect(io.ask('q', { validate: () => 'nope' })).rejects.toThrow('Too many invalid answers');
  });

  it('secret validation failure never puts the value in the transcript or the error', async () => {
    const secret = 'sk-live-abcdef123456';
    const io = scriptedIO([{ secret }, { secret }, { secret }, { secret }]);
    let err: Error | undefined;
    try {
      await io.askSecret('Key?', { validate: (v) => `bad key ${v}` });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toBe('Too many invalid answers');
    expect(io.transcript.join('\n')).not.toContain(secret);
  });
});

describe('redactingIO', () => {
  function capture() {
    const lines: string[] = [];
    const inner: SetupIO = {
      say: (l) => void lines.push(l),
      ask: async () => '',
      askSecret: async () => '',
      confirm: async () => true,
      choose: async (_p, o) => o[0].value,
      pause: async () => undefined,
    };
    return { lines, inner };
  }

  it('redacts a registered secret and a token-shaped string in say', () => {
    const { lines, inner } = capture();
    const io = redactingIO(inner);
    io.registerSecret('tiny');
    io.say(`token ${TOKEN} and tiny value`);
    expect(lines[0]).not.toContain(TOKEN);
    expect(lines[0]).not.toContain('tiny');
    expect(lines[0]).toContain('[hidden]');
  });

  it('auto-registers an askSecret result', async () => {
    const { lines, inner } = capture();
    inner.askSecret = async () => 'abc-secret-xyz';
    const io = redactingIO(inner);
    expect(await io.askSecret('Key?')).toBe('abc-secret-xyz');
    io.say('saved abc-secret-xyz ok');
    expect(lines[0]).toBe('saved [hidden] ok');
  });

  it('redacts the trimmed form of a whitespace-padded secret', async () => {
    const { lines, inner } = capture();
    inner.askSecret = async () => '  padded-secret-42 \n';
    const io = redactingIO(inner);
    await io.askSecret('Key?');
    io.say('using padded-secret-42 now');
    io.registerSecret('  other-pad-secret ');
    io.say('and other-pad-secret');
    expect(lines).toEqual(['using [hidden] now', 'and [hidden]']);
  });

  it('honours extraSecrets', () => {
    const { lines, inner } = capture();
    const io = redactingIO(inner, () => ['from-env-value']);
    io.say('x from-env-value y');
    expect(lines[0]).toBe('x [hidden] y');
  });

  it('redacts the value from a re-prompt message of a secret validator', async () => {
    const seen: string[] = [];
    const { inner } = capture();
    inner.askSecret = async (_p, opts) => {
      const msg = opts?.validate?.('typed-secret-1');
      seen.push(msg ?? 'ok');
      return 'typed-secret-1';
    };
    const io = redactingIO(inner);
    await io.askSecret('Key?', { validate: (v) => `bad ${v}` });
    expect(seen[0]).toBe('bad [hidden]');
  });

  it('redacts through a scripted inner io transcript', async () => {
    const inner = scriptedIO([{ secret: 'zz-top-secret-9' }]);
    const io = redactingIO(inner);
    await io.askSecret('Key?');
    io.say('got zz-top-secret-9');
    expect(inner.transcript.join('\n')).not.toContain('zz-top-secret-9');
  });
});

describe('ttyIO', () => {
  function make(typed: string) {
    const input = new PassThrough();
    const output = new PassThrough();
    let out = '';
    output.on('data', (c: Buffer) => (out += c.toString()));
    const io = ttyIO(input, output);
    input.write(typed);
    return { io, input, output, get out() { return out; } };
  }

  it('ask echoes the prompt and returns the typed line', async () => {
    const t = make('Alice\n');
    expect(await t.io.ask('Name?')).toBe('Alice');
    expect(t.out).toContain('Name?');
  });

  it('ask returns the default on an empty line', async () => {
    const t = make('\n');
    expect(await t.io.ask('Name?', { default: 'Bob' })).toBe('Bob');
    expect(t.out).toContain('Bob');
  });

  it('askSecret writes no character of the answer to the output', async () => {
    const t = make('super-secret-answer\n');
    expect(await t.io.askSecret('Token?')).toBe('super-secret-answer');
    expect(t.out).toContain('Token?');
    expect(t.out).not.toContain('super');
    expect(t.out).not.toContain('answer');
  });

  it('secret re-prompt message does not contain the value', async () => {
    const t = make('first-secret-1\nsecond-secret-2\n');
    const r = await t.io.askSecret('Token?', {
      validate: (v) => (v.startsWith('second') ? null : `bad ${v}`),
    });
    expect(r).toBe('second-secret-2');
    expect(t.out).not.toContain('first-secret-1');
    expect(t.out).not.toContain('second-secret-2');
  });

  it('confirm accepts y, yes and empty (default) and re-prompts on other text', async () => {
    const t1 = make('y\n');
    expect(await t1.io.confirm('Go?')).toBe(true);
    const t2 = make('YES\n');
    expect(await t2.io.confirm('Go?', false)).toBe(true);
    const t3 = make('\n');
    expect(await t3.io.confirm('Go?', false)).toBe(false);
    const t4 = make('maybe\nn\n');
    expect(await t4.io.confirm('Go?', true)).toBe(false);
    expect(t4.out.match(/Go\?/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('choose accepts a number or a value and a default', async () => {
    const opts = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }] as const;
    const t1 = make('2\n');
    expect(await t1.io.choose('Pick', [...opts])).toBe('b');
    expect(t1.out).toContain('Alpha');
    const t2 = make('\n');
    expect(await t2.io.choose('Pick', [...opts], 'a')).toBe('a');
  });

  it('throws when the input closes', async () => {
    const input = new PassThrough();
    const io = ttyIO(input, new PassThrough());
    const p = io.ask('x');
    input.end();
    await expect(p).rejects.toThrow(/input closed/i);
  });

  it('gives up after repeated invalid answers', async () => {
    const t = make('a\nb\nc\nd\n');
    await expect(t.io.ask('q', { validate: () => 'no' })).rejects.toThrow('Too many invalid answers');
  });

  it('keeps secrets and typed lines out of readline history (terminal mode)', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = ttyIO(input, output, { terminal: true });
    input.write('hist-secret-77\n');
    expect(await io.askSecret('Token?')).toBe('hist-secret-77');
    input.write('plain\n');
    await io.ask('Name?');
    expect(io.history()).toEqual([]);
    io.close();
  });

  it('a throwing validator surfaces a fixed message without the candidate', async () => {
    const t = make('thrown-secret-5\nok\n');
    const r = await t.io.askSecret('Key?', {
      validate: (v) => {
        if (v === 'ok') return null;
        throw new Error(`boom ${v}`);
      },
    });
    expect(r).toBe('ok');
    expect(t.out).not.toContain('thrown-secret-5');
    expect(t.out).toContain('Invalid value');
  });

  it('close() ends the interface so later asks reject', async () => {
    const t = make('');
    t.io.close();
    await expect(t.io.ask('x')).rejects.toThrow(/input closed/i);
  });

  it('pause waits for one line', async () => {
    const t = make('\n');
    await t.io.pause('Press Enter');
    expect(t.out).toContain('Press Enter');
  });
});
