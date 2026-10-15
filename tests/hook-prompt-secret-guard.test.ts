// tests/hook-prompt-secret-guard.test.ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const HOOK = resolve(__dirname, '..', '.claude', 'hooks', 'prompt-secret-guard.cjs');
const MSG = 'That looks like a secret. Do not paste secrets here. Rotate it if it was real, and enter it in the setup wizard instead.';
const run = (stdin: string) => spawnSync('node', [HOOK], { input: stdin, encoding: 'utf8' });
const prompt = (p: string) => run(JSON.stringify({ prompt: p, hook_event_name: 'UserPromptSubmit' }));

// invented values only
const SECRETS: Record<string, string> = {
  telegram: 'my token 1234567890:AAAbbbCCCdddEEEfffGGGhhhIIIjjjKKK12 ok',
  gocspx: 'GOCSPX-abcdefghijklmnopqrstuvwx',
  aiza: 'AIzaSyAbcdefghijklmnopqrstuvwxyz0123456',
  sk: 'sk-ant-abcdefghijklmnopqrstu',
  slack: 'xoxb-1234-5678',
  aws: 'AKIAABCDEFGHIJKLMNOP',
  pem: '-----BEGIN PRIVATE KEY-----',
  b64url43: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq',
  hex64: 'a'.repeat(32) + '0123456789abcdef0123456789abcdef',
  fragment: 'open http://127.0.0.1:8080/#token=abc',
  bearer: 'Authorization: Bearer abc.def',
  envKey: 'GMAIL_API_KEY=hunter2',
  envPass: 'DB_PASSWORD: hunter2',
  envCookie: 'SESSION_COOKIE = abc',
};

describe('prompt secret guard', () => {
  for (const [name, text] of Object.entries(SECRETS)) {
    it(`blocks ${name} without echoing it`, () => {
      const r = prompt(`here: ${text}`);
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({ decision: 'block', reason: MSG });
      for (const frag of text.split(/[\s=:]+/).filter((f) => f.length >= 8)) expect(r.stdout).not.toContain(frag);
    });
  }
  it('allows ordinary prose and look-alikes', () => {
    for (const p of [
      'How do I set up the Telegram bot?',
      'commit 3f2a9c1d4b5e6f708192a3b4c5d6e7f801234567',
      'npm run setup -- --step gmail',
      'my bot is @jobber_helper_bot',
      'faizan@example.com',
      'KEY is something I need to find',
      'I set the password in the wizard',
    ]) {
      const r = prompt(p);
      expect(r.status, p).toBe(0);
      expect(r.stdout, p).toBe('');
    }
  });
  it('accepted noise: a 43-character identifier-looking path is blocked', () => {
    const ident = 'src_platform_bootstrap_state_machine_runner_xx'.slice(0, 43);
    expect(ident).toHaveLength(43);
    expect(prompt(`see ${ident}`).stdout).toContain('block');
  });
  it('blocks zero-width-split and fullwidth variants', () => {
    const variants = [
      'GOCSPX-abcdefghij​klmnopqrstuvwx',
      'AK​IAABCDEFGHIJKLMNOP',
      'ＡＫＩＡABCDEFGHIJKLMNOP', // fullwidth AKIA
      'xo⁠xb-1234-5678',
      'GMAIL_API_KEY = hunter2',
    ];
    for (const v of variants) {
      const r = prompt(`here: ${v}`);
      expect(JSON.parse(r.stdout || '{}'), JSON.stringify(v)).toEqual({ decision: 'block', reason: MSG });
    }
  });
  it('blocks an oversized prompt and finishes quickly on a 90 KB one', () => {
    const t0 = Date.now();
    const r = prompt('a-'.repeat(45000));
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(JSON.parse(r.stdout)).toEqual({ decision: 'block', reason: MSG });
  });
  it('fails closed on malformed input', () => {
    for (const s of ['', 'not json', '{}', '{"prompt":5}', '[]', 'null']) {
      const r = run(s);
      expect(r.status, s).toBe(0);
      expect(JSON.parse(r.stdout).decision, s).toBe('block');
    }
  });
});
