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

  it('claude-session.sh parses the env line by line, never sources it, and withholds the bridge keys', () => {
    expect(session).not.toMatch(/^\s*(source|\.)\s+/m);
    expect(session).not.toMatch(/\beval\b/);
    expect(session).toMatch(/while IFS= read -r line \|\| \[ -n "\$line" \]/);
    expect(session).toMatch(/\^\[A-Za-z_\]\[A-Za-z0-9_\]\*=/);
    expect(session).toMatch(/TELEGRAM_BOT_TOKEN\|ALLOWED_USERS\) continue/);
    expect(session).toMatch(/export "\$k=\$v"/);
    expect(session).toMatch(/exec claude "\$@"/);
  });

  it('run.sh env -i passes exactly the allowed variables', () => {
    const m = run.match(/exec env -i((?:[ \t]*\\?\n?[ \t]*[A-Z_]+="[^"]*")+)/);
    expect(m).not.toBeNull();
    const names = [...(m as RegExpMatchArray)[1].matchAll(/([A-Z_]+)=/g)].map((x) => x[1]).sort();
    expect(names).toEqual(
      ['ALLOWED_USERS', 'CCGRAM_CLAUDE_COMMAND', 'CCGRAM_DIR', 'HOME', 'PATH', 'TELEGRAM_BOT_TOKEN'].sort(),
    );
    expect(run).toMatch(/\n  ccgram\n?$/);
  });

  it('uses exact tmux targets and validates the session name', () => {
    expect(start).toMatch(/has-session -t "=\$SESSION"/);
    expect(stop).toMatch(/has-session -t "=\$SESSION"/);
    expect(stop).toMatch(/kill-session -t "=\$SESSION"/);
    for (const t of [start, stop]) {
      expect(t).toContain('^[A-Za-z0-9_-]+$');
      expect(t).not.toMatch(/-t "\$SESSION"/);
    }
  });

  it('run.sh validates ALLOWED_USERS and the token without printing them', () => {
    expect(run).toContain('^[0-9]+(,[0-9]+)*$');
    expect(run).toMatch(/\[\[:space:\]\]/);
    expect(run).toMatch(/\$\{TOKEN%\$'\\r'\}/);
    expect(run).not.toMatch(/echo[^\n]*\$(TOKEN|USERS)/);
    expect(run).toMatch(/chmod 700 "\$CCGRAM_HOME"/);
  });

  it('version check uses the last token of the first output line', () => {
    expect(check).toMatch(/awk '\{print \$NF\}'/);
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
