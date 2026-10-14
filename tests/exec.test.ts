import { describe, it, expect } from 'vitest';
import { defaultExec, pipeExec } from '../src/lib/exec.js';

const node = process.execPath;
const MISSING = 'definitely-not-a-binary-xyz';

describe('pipeExec', () => {
  it('pipes producer stdout into the consumer', async () => {
    const r = await pipeExec(
      { cmd: node, args: ['-e', 'process.stdout.write("hello")'] },
      { cmd: node, args: ['-e', 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(s==="hello"?0:5))'] },
    );
    expect(r.producerCode).toBe(0);
    expect(r.consumerCode).toBe(0);
  });
  it('returns 127 for a missing producer', async () => {
    const r = await pipeExec({ cmd: MISSING, args: [] }, { cmd: node, args: ['-e', 'process.stdin.resume()'] });
    expect(r.producerCode).toBe(127);
  });
  it('returns 127 for a missing consumer', async () => {
    const r = await pipeExec({ cmd: node, args: ['-e', 'setInterval(()=>{},100)'] }, { cmd: MISSING, args: [] });
    expect(r.consumerCode).toBe(127);
  });
  it('does not hang when the consumer exits first', async () => {
    const r = await pipeExec(
      { cmd: node, args: ['-e', 'setInterval(()=>process.stdout.write("x".repeat(1000)),10)'] },
      { cmd: node, args: ['-e', 'process.exit(0)'] },
      { timeoutMs: 10_000 },
    );
    expect(r.consumerCode).toBe(0);
  }, 15_000);
  it('kills both on timeout with nonzero codes', async () => {
    const r = await pipeExec(
      { cmd: node, args: ['-e', 'setTimeout(()=>{},20000)'] },
      { cmd: node, args: ['-e', 'setTimeout(()=>{},20000)'] },
      { timeoutMs: 300 },
    );
    expect(r.producerCode).not.toBe(0);
    expect(r.consumerCode).not.toBe(0);
  });
});

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
