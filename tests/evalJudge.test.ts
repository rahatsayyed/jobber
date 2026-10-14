import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { judgeJob, parseModelArg, recordJudgeErrors } from '../scripts/eval/judgeLib.js';

const good = JSON.stringify({ scores: { 'Resume 1': { truthfulness: 5 } }, ranking: ['Resume 1'], why: 'ok' });

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'evaljudge-test-'));
  return { dir, rawPath: path.join(dir, 'judge-raw', 'j_1.txt'), verdictPath: path.join(dir, 'verdict-j_1.json') };
}

describe('parseModelArg', () => {
  it('returns the fallback when absent and the value when present', () => {
    expect(parseModelArg(['dir'], 'sonnet')).toBe('sonnet');
    expect(parseModelArg(['dir', '--model', 'opus'], 'sonnet')).toBe('opus');
  });
  it('rejects a missing value or a following flag', () => {
    expect(() => parseModelArg(['dir', '--model'], 'sonnet')).toThrow(/--model requires a value/);
    expect(() => parseModelArg(['dir', '--model', '--force'], 'sonnet')).toThrow(/--model requires a value/);
    expect(() => parseModelArg(['dir', '--model', ' '], 'sonnet')).toThrow(/--model requires a value/);
  });
});

describe('judgeJob', () => {
  it('saves the raw reply before parsing and writes the verdict with job id', async () => {
    const s = setup();
    try {
      const r = await judgeJob({ jobId: 'j:1', prompt: 'p', runner: async () => '```json\n' + good + '\n```', rawPath: s.rawPath, verdictPath: s.verdictPath });
      expect(r.status).toBe('judged');
      expect(readFileSync(s.rawPath, 'utf8')).toContain('```json');
      expect(JSON.parse(readFileSync(s.verdictPath, 'utf8')).job).toBe('j:1');
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });

  it('retries once after a malformed reply, keeping the raw reply', async () => {
    const s = setup();
    try {
      let n = 0;
      const r = await judgeJob({ jobId: 'j:1', prompt: 'p', runner: async () => (++n === 1 ? 'sorry, no JSON here' : good), rawPath: s.rawPath, verdictPath: s.verdictPath });
      expect(n).toBe(2);
      expect(r.status).toBe('judged');
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });

  it('records a failure (no throw, no verdict) after two bad replies, raw output kept', async () => {
    const s = setup();
    try {
      let n = 0;
      const r = await judgeJob({ jobId: 'j:1', prompt: 'p', runner: async () => { n++; return 'garbage'; }, rawPath: s.rawPath, verdictPath: s.verdictPath });
      expect(n).toBe(2);
      expect(r.status).toBe('failed');
      expect(existsSync(s.verdictPath)).toBe(false);
      expect(readFileSync(s.rawPath, 'utf8')).toBe('garbage');
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });

  it('treats a runner rejection (timeout) as a failure, and a JSON reply missing scores as failed', async () => {
    const s = setup();
    try {
      const a = await judgeJob({ jobId: 'j:1', prompt: 'p', runner: async () => { throw new Error('judge timed out'); }, rawPath: s.rawPath, verdictPath: s.verdictPath });
      expect(a).toMatchObject({ status: 'failed' });
      const b = await judgeJob({ jobId: 'j:1', prompt: 'p', runner: async () => '{"hello":1}', rawPath: s.rawPath, verdictPath: s.verdictPath });
      expect(b).toMatchObject({ status: 'failed' });
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });

  it('skips a job whose verdict exists unless force is set', async () => {
    const s = setup();
    try {
      writeFileSync(s.verdictPath, JSON.stringify({ job: 'j:1', scores: {}, ranking: [], why: 'old' }));
      let n = 0;
      const runner = async () => { n++; return good; };
      const skipped = await judgeJob({ jobId: 'j:1', prompt: 'p', runner, rawPath: s.rawPath, verdictPath: s.verdictPath });
      expect(skipped.status).toBe('skipped');
      expect(n).toBe(0);
      const forced = await judgeJob({ jobId: 'j:1', prompt: 'p', runner, rawPath: s.rawPath, verdictPath: s.verdictPath, force: true });
      expect(forced.status).toBe('judged');
      expect(n).toBe(1);
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  });
});

describe('recordJudgeErrors', () => {
  it('writes failures and clears entries for jobs judged on a later run', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'evaljudge-test-'));
    const f = path.join(dir, 'judge-errors.json');
    try {
      recordJudgeErrors(f, {}, []);
      expect(existsSync(f)).toBe(false);
      recordJudgeErrors(f, { 'a:1': 'boom', 'b:2': 'bang' }, []);
      expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ 'a:1': 'boom', 'b:2': 'bang' });
      recordJudgeErrors(f, {}, ['a:1']);
      expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ 'b:2': 'bang' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
