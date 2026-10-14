import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  renderLaunchdPlist,
  renderSystemdUnit,
  validateUnitInput,
  writeUnits,
  type UnitInput,
} from '../src/scheduler/units.js';

const base: UnitInput = {
  projectRoot: '/opt/jobber',
  nodePath: '/usr/local/bin/node',
  logDir: '/opt/jobber/.jobber/logs',
};

describe('scheduler units', () => {
  it('renders a golden plist', () => {
    expect(renderLaunchdPlist(base)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.jobber.scheduler</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/opt/jobber/node_modules/tsx/dist/cli.mjs</string>
    <string>scripts/scheduler.ts</string>
    <string>--daemon</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/opt/jobber</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>/opt/jobber/.jobber/logs/scheduler.log</string>
  <key>StandardErrorPath</key>
  <string>/opt/jobber/.jobber/logs/scheduler.log</string>
</dict>
</plist>
`);
  });

  it('renders a golden systemd unit', () => {
    expect(renderSystemdUnit(base)).toBe(`[Unit]
Description=Jobber scheduler daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/jobber
ExecStart="/usr/local/bin/node" "/opt/jobber/node_modules/tsx/dist/cli.mjs" "scripts/scheduler.ts" "--daemon"
Environment="PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
Restart=always
RestartSec=30
StandardOutput=append:/opt/jobber/.jobber/logs/scheduler.log
StandardError=append:/opt/jobber/.jobber/logs/scheduler.log

[Install]
WantedBy=default.target
`);
  });

  it('xml-escapes plist values', () => {
    const out = renderLaunchdPlist({ ...base, projectRoot: '/opt/a&b<c', logDir: '/opt/a&b<c/logs' });
    expect(out).toContain('/opt/a&amp;b&lt;c');
    expect(out).not.toContain('a&b<c');
  });

  it('rejects relative paths, newlines, NUL and control chars', () => {
    expect(() => validateUnitInput({ ...base, projectRoot: 'rel/path' })).toThrow();
    expect(() => validateUnitInput({ ...base, nodePath: 'node' })).toThrow();
    expect(() => validateUnitInput({ ...base, logDir: 'logs' })).toThrow();
    expect(() => validateUnitInput({ ...base, projectRoot: '/opt/a\nb' })).toThrow();
    expect(() => validateUnitInput({ ...base, projectRoot: '/opt/a\0b' })).toThrow();
    expect(() => validateUnitInput({ ...base, nodePath: '/opt/a\tb' })).toThrow();
    expect(() => validateUnitInput({ ...base, label: 'bad label\n' })).toThrow();
    expect(() => validateUnitInput(base)).not.toThrow();
  });

  it('rejects systemd-special characters in the systemd unit', () => {
    for (const bad of ['/opt/a"b', '/opt/a%b', '/opt/a$b', '/opt/a\\b']) {
      expect(() => renderSystemdUnit({ ...base, projectRoot: bad })).toThrow();
    }
    expect(() => renderSystemdUnit({ ...base, logDir: '/opt/a b/logs' })).toThrow();
  });

  it('puts no secrets or telegram strings in either unit', () => {
    const text = renderLaunchdPlist(base) + renderSystemdUnit(base);
    expect(text).not.toMatch(/TELEGRAM|TOKEN|SECRET|\.env/i);
    expect(renderLaunchdPlist(base).match(/<key>PATH<\/key>/g)).toHaveLength(1);
    expect(renderLaunchdPlist(base)).not.toMatch(/<key>(?!Label|ProgramArguments|WorkingDirectory|EnvironmentVariables|PATH|RunAtLoad|KeepAlive|ThrottleInterval|StandardOutPath|StandardErrorPath)/);
  });

  it('writes both files into an out dir inside the project, mode 0700 dirs', () => {
    const root = mkdtempSync(join(tmpdir(), 'units-'));
    try {
      const r = writeUnits({ projectRoot: root, nodePath: '/usr/local/bin/node' });
      expect(r.plistPath).toBe(join(root, '.jobber/units/dev.jobber.scheduler.plist'));
      expect(existsSync(r.servicePath)).toBe(true);
      expect(readFileSync(r.plistPath, 'utf8')).toContain('<string>dev.jobber.scheduler</string>');
      expect(statSync(join(root, '.jobber/units')).mode & 0o777).toBe(0o700);
      expect(r.commands.join('\n')).toContain('launchctl bootstrap gui/$(id -u)');
      expect(r.commands.join('\n')).toContain('systemctl --user link');
      expect(r.commands.join('\n')).toContain('systemctl --user enable --now jobber-scheduler.service');
      expect(() => writeUnits({ projectRoot: root, nodePath: '/usr/local/bin/node', outDir: '/etc' })).toThrow();
      expect(() => writeUnits({ projectRoot: root, nodePath: '/usr/local/bin/node', outDir: join(root, '..', 'x') })).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
