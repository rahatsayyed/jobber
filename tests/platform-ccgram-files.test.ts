import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (p: string): string => readFileSync(p, 'utf8');

describe('ccgram runner files', () => {
  const start = read('scripts/ccgram/start.sh');
  const run = read('scripts/ccgram/run.sh');
  const stop = read('scripts/ccgram/stop.sh');
  const session = read('scripts/ccgram/claude-session.sh');
  const check = read('scripts/ccgram/check-version.sh');
  const example = read('.env.example');
  const ignore = read('.gitignore');

  it('start.sh runs the launcher in the .ccgram state dir and locks down permissions', () => {
    expect(start).toMatch(/set -euo pipefail/);
    expect(start).toMatch(/-c "\$CCGRAM_HOME"/);
    expect(start).toMatch(/scripts\/ccgram\/run\.sh/);
    expect(start).toMatch(/chmod 700 "\$CCGRAM_HOME"/);
    expect(start).toMatch(/chmod 600 "\$ROOT\/\.env"/);
    expect(start).toMatch(/check-version\.sh/);
  });

  it("run.sh passes only ccgram's keys, with a stripped environment, and never sources the whole .env", () => {
    expect(run).toMatch(/set -euo pipefail/);
    expect(run).toMatch(/exec env -i /);
    expect(run).toMatch(/CCGRAM_DIR="\$CCGRAM_HOME"/);
    expect(run).toMatch(/get TELEGRAM_BOT_TOKEN/);
    expect(run).toMatch(/get ALLOWED_USERS/);
    expect(run).toMatch(/^cd "\$CCGRAM_HOME"$/m);
    expect(run).toMatch(/check-version\.sh/);
    expect(run).not.toMatch(/^\s*(source|\.)\s+/m);
    expect(run).not.toMatch(/set -[a-z]*x/);
    expect(run).not.toMatch(/GMAIL|SERPER|APP_PASSWORD/);
    const gets = [...run.matchAll(/\$\(get (\w+)/g)].map((m) => m[1]);
    expect(gets.sort()).toEqual(['ALLOWED_USERS', 'TELEGRAM_BOT_TOKEN']);
  });

  it('no script skips permissions or runs the upgrade or doctor --fix commands', () => {
    for (const text of [start, run, stop, session, check, example]) {
      expect(text).not.toMatch(/dangerously-skip-permissions|bypassPermissions/);
      expect(text).not.toMatch(/uv tool upgrade|doctor --fix|ccgram upgrade|\bupgrade\b/i);
    }
  });

  it('version check compares the pin to the installed version and fails when missing', () => {
    expect(check).toMatch(/ccgram\.pin\.json/);
    expect(check).toMatch(/ccgram --version/);
    expect(check).toMatch(/"\$INSTALLED" != "\$PIN"/);
    expect(check).toMatch(/not installed/);
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

  it('.gitignore ignores ccgram state, .env and settings.local files, without duplicates', () => {
    const lines = ignore.split('\n').map((l) => l.trim());
    for (const l of ['.ccgram/', '.claude/settings.local.json', '.claude/settings.local.managed.json']) {
      expect(lines.filter((x) => x === l)).toHaveLength(1);
    }
    expect(lines).toContain('.env');
  });
});
