// src/scheduler/units.ts
// Generates launchd plist and systemd unit TEXT only. Nothing here installs or runs anything.
// No secrets: the daemon reads .env itself; units carry only a fixed PATH.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface UnitInput {
  projectRoot: string;
  nodePath: string;
  label?: string;
  logDir: string;
}

export const DEFAULT_LABEL = 'dev.jobber.scheduler';
export const SERVICE_NAME = 'jobber-scheduler.service';
const PATH_TAIL = '/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin';
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function checkPath(name: string, v: string): void {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${name} must be a non-empty string`);
  if (CONTROL.test(v)) throw new Error(`${name} contains a control character`);
  if (!v.startsWith('/')) throw new Error(`${name} must be an absolute path`);
}

export function validateUnitInput(i: UnitInput): void {
  checkPath('projectRoot', i.projectRoot);
  checkPath('nodePath', i.nodePath);
  checkPath('logDir', i.logDir);
  if (i.label !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(i.label)) {
    throw new Error('label must match [A-Za-z0-9._-]');
  }
}

function xml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function pathValue(i: UnitInput): string {
  return `${dirname(i.nodePath)}:${PATH_TAIL}`;
}

function args(i: UnitInput): string[] {
  return [i.nodePath, `${i.projectRoot}/node_modules/tsx/dist/cli.mjs`, 'scripts/scheduler.ts', '--daemon'];
}

export function renderLaunchdPlist(i: UnitInput): string {
  validateUnitInput(i);
  const label = i.label ?? DEFAULT_LABEL;
  const log = `${i.logDir}/scheduler.log`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${args(i).map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(i.projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(pathValue(i))}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

function sysd(name: string, v: string): string {
  if (/["%$\\\s]/.test(v)) throw new Error(`${name} contains a character not allowed in a systemd unit`);
  return v;
}

export function renderSystemdUnit(i: UnitInput): string {
  validateUnitInput(i);
  const root = sysd('projectRoot', i.projectRoot);
  sysd('nodePath', i.nodePath);
  const log = `${sysd('logDir', i.logDir)}/scheduler.log`;
  const a = args(i);
  return `[Unit]
Description=Jobber scheduler daemon
After=network-online.target

[Service]
Type=simple
WorkingDirectory=${root}
ExecStart=${a.map((x) => `"${x}"`).join(' ')}
Environment="PATH=${pathValue(i)}"
Restart=always
RestartSec=30
StandardOutput=append:${log}
StandardError=append:${log}

[Install]
WantedBy=default.target
`;
}

export interface WriteOpts {
  projectRoot: string;
  nodePath: string;
  outDir?: string;
}

export interface WriteResult {
  plistPath: string;
  servicePath: string;
  commands: string[];
}

/** Writes the two unit files under outDir (default <root>/.jobber/units, must be inside the root). Never installs. */
export function writeUnits(o: WriteOpts): WriteResult {
  const root = resolve(o.projectRoot);
  const out = resolve(o.outDir ?? join(root, '.jobber', 'units'));
  const rel = relative(root, out);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('--out must resolve inside the project root');
  }
  const input: UnitInput = {
    projectRoot: root,
    nodePath: o.nodePath,
    logDir: join(root, '.jobber', 'logs'),
  };
  const plist = renderLaunchdPlist(input);
  const service = renderSystemdUnit(input);
  mkdirSync(out, { recursive: true, mode: 0o700 });
  chmodSync(out, 0o700);
  const plistPath = join(out, `${DEFAULT_LABEL}.plist`);
  const servicePath = join(out, SERVICE_NAME);
  writeFileSync(plistPath, plist, { mode: 0o600 });
  writeFileSync(servicePath, service, { mode: 0o600 });
  return {
    plistPath,
    servicePath,
    commands: [
      `# macOS (launchd)`,
      `mkdir -p "${input.logDir}"`,
      `launchctl bootstrap gui/$(id -u) "${plistPath}"`,
      `# Linux (systemd --user)`,
      `systemctl --user link "${servicePath}"`,
      `systemctl --user enable --now ${SERVICE_NAME}`,
    ],
  };
}
