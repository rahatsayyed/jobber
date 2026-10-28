// src/bootstrap/catalog.ts
// Pure catalog: what "present" means per item and what an install would run. Nothing executes here.
import { join } from 'node:path';
import { ccgramInstallArgv } from '../platform/checks.js';
import type { CliDeps } from '../../scripts/models.js';
import { createModelParts } from './model.js';
import type { Action,BootstrapDeps, CcgramPin, Detection, Item, Plan } from './types.js';

// Upstream URLs: check upstream before relying on them (plan U1, U5, U6).
const UV_URL = 'https://astral.sh/uv/install.sh';
const NODE_URL = 'https://github.com/nvm-sh/nvm#installing-and-updating';
const CHROME_URL = 'https://www.google.com/chrome/';
const CLAUDE_URL = 'https://docs.claude.com/en/docs/claude-code/setup';

/** Offered by the executor for `uv` on Linux after show-and-ask; the script path is filled in at run time. */
export const UV_INSTALLER_ACTION: Action = {
  id: 'uv:installer',
  summary: 'download the official uv installer, show url/size/sha256, then run it',
  argv: ['sh', '{script}'],
  needsSudo: false,
  network: true,
  url: UV_URL,
  downloadsScript: true,
};

function majorOf(v: string): number | null {
  const m = /^v?(\d+)\./.exec(v.trim());
  return m ? Number(m[1]) : null;
}

function engineMajor(engines: string): number {
  const m = /(\d+)/.exec(engines);
  return m ? Number(m[1]) : 0;
}

function firstLine(s: string): string {
  return (s.split('\n')[0] ?? '').trim();
}

async function probe(d: BootstrapDeps, cmd: string, args: string[], label: string): Promise<Detection> {
  const r = await d.run(cmd, args);
  if (r.code !== 0) return { present: false, detail: `${label} not found` };
  const line = firstLine(r.stdout);
  return { present: true, version: line, detail: line || `${label} found` };
}

const unsupported = (what: string): Plan => ({
  kind: 'owner',
  message: `unsupported platform: install ${what} yourself, then re-run the bootstrap`,
});
const done = (det: Detection): Plan => ({ kind: 'none', why: det.detail || 'already present' });

function act(a: Action): Plan {
  return { kind: 'actions', actions: [a] };
}

function brewOrApt(
  id: string,
  title: string,
  brew: string[],
  apt: string[] | null,
  aptOwner?: Plan,
): Pick<Item, 'plan'> {
  return {
    plan(d, det) {
      if (det.present) return done(det);
      if (d.platform === 'darwin') {
        return act({
          id: `${id}:brew`,
          summary: `brew install ${brew.join(' ')}`,
          argv: ['brew', 'install', ...brew],
          needsSudo: false,
          network: true,
        });
      }
      if (d.platform === 'linux') {
        if (apt === null) return aptOwner ?? unsupported(title);
        return act({
          id: `${id}:apt`,
          summary: `apt-get install -y ${apt.join(' ')}`,
          argv: ['apt-get', 'install', '-y', ...apt],
          needsSudo: true,
          network: true,
        });
      }
      return unsupported(title);
    },
  };
}

export function buildCatalog(input: {
  pin: CcgramPin;
  engines: string;
  hasRenderer: boolean;
  modelProfile: string;
  /** Real model machinery (src/bootstrap/model.ts); absent means the item reports it is unavailable. */
  modelCli?: CliDeps;
  /** Overrides detect (used to surface a bad profile id as a failure). */
  detectClassifier?: (d: BootstrapDeps, profile: string) => Promise<Detection>;
}): Item[] {
  const needMajor = engineMajor(input.engines);
  const xcode: Plan = { kind: 'owner', message: 'run: xcode-select --install (also provides git and build tools)' };

  const git: Item = {
    id: 'git',
    title: 'git',
    required: true,
    detect: (d) => probe(d, 'git', ['--version'], 'git'),
    plan(d, det) {
      if (det.present) return done(det);
      if (d.platform === 'darwin') return xcode;
      if (d.platform === 'linux') {
        return act({ id: 'git:apt', summary: 'apt-get install -y git', argv: ['apt-get', 'install', '-y', 'git'], needsSudo: true, network: true });
      }
      return unsupported('git');
    },
  };

  const buildTools: Item = {
    id: 'build-tools',
    title: 'C build tools',
    required: true,
    async detect(d) {
      if (d.platform === 'darwin') {
        const r = await d.run('xcode-select', ['-p']);
        return r.code === 0
          ? { present: true, detail: firstLine(r.stdout) || 'command line tools found' }
          : { present: false, detail: 'command line tools not found' };
      }
      return probe(d, 'cc', ['--version'], 'cc');
    },
    plan(d, det) {
      if (det.present) return done(det);
      if (d.platform === 'darwin') return { kind: 'owner', message: 'run: xcode-select --install' };
      if (d.platform === 'linux') {
        return act({ id: 'build-tools:apt', summary: 'apt-get install -y build-essential', argv: ['apt-get', 'install', '-y', 'build-essential'], needsSudo: true, network: true });
      }
      return unsupported('build tools');
    },
  };

  const node: Item = {
    id: 'node',
    title: `Node.js ${input.engines}`,
    required: true,
    async detect(d) {
      const r = await d.run('node', ['-v']);
      const v = r.stdout.trim();
      const major = majorOf(v);
      let det: Detection;
      if (r.code !== 0 || major === null) det = { present: false, detail: 'node not found' };
      else if (major < needMajor) det = { present: false, version: v, detail: `node ${v} is older than ${needMajor}` };
      else det = { present: true, version: v, detail: `node ${v}` };
      if (!det.present && d.platform === 'linux') {
        const p = await d.run('apt-cache', ['policy', 'nodejs']);
        const m = /Candidate:\s*(?:\d+:)?(\d+)\./.exec(p.stdout);
        if (p.code === 0 && m) det.candidateMajor = Number(m[1]);
      }
      return det;
    },
    plan(d, det) {
      if (det.present) return done(det);
      if (d.platform === 'darwin') {
        return act({ id: 'node:brew', summary: 'brew install node', argv: ['brew', 'install', 'node'], needsSudo: false, network: true });
      }
      if (d.platform === 'linux') {
        if (det.candidateMajor !== undefined && det.candidateMajor >= needMajor) {
          return act({ id: 'node:apt', summary: 'apt-get install -y nodejs', argv: ['apt-get', 'install', '-y', 'nodejs'], needsSudo: true, network: true });
        }
        return {
          kind: 'owner',
          message: `the apt nodejs package is older than ${needMajor}: install Node.js ${input.engines} with nvm or NodeSource (check upstream)`,
          url: NODE_URL,
        };
      }
      return unsupported('Node.js');
    },
  };

  const npmDeps: Item = {
    id: 'npm-deps',
    title: 'npm dependencies and Next.js dashboard build',
    required: true,
    async detect(d) {
      const nm = join(d.root, 'node_modules');
      const need = ['.package-lock.json', 'tsx', 'better-sqlite3', 'patchright'];
      const missing = need.filter((n) => !d.fs.exists(join(nm, n)));
      if (!d.fs.exists(join(d.root, 'apps', 'dashboard', 'node_modules', 'next'))) missing.push('apps/dashboard/node_modules/next');
      if (!d.fs.exists(join(d.root, 'apps', 'dashboard', '.next', 'BUILD_ID'))) missing.push('apps/dashboard/.next/BUILD_ID');
      return missing.length
        ? { present: false, detail: `missing in node_modules: ${missing.join(', ')}` }
        : { present: true, detail: 'node_modules and Next.js dashboard build complete' };
    },
    plan(d, det) {
      if (det.present) return done(det);
      if (d.platform === 'unsupported') return unsupported('npm dependencies');
      return { kind: 'actions', actions: [
        { id: 'npm-deps:ci', summary: 'npm ci', argv: ['npm', 'ci'], cwd: d.root, needsSudo: false, network: true },
        { id: 'npm-deps:dashboard-ci', summary: 'npm ci --prefix apps/dashboard', argv: ['npm', 'ci', '--prefix', 'apps/dashboard'], cwd: d.root, needsSudo: false, network: true },
        { id: 'npm-deps:dashboard-build', summary: 'npm run web:next:build', argv: ['npm', 'run', 'web:next:build'], cwd: d.root, needsSudo: false, network: false },
      ] };
    },
  };

  const rendererDeps: Item = {
    id: 'renderer-deps',
    title: 'renderer dependencies',
    required: true,
    async detect(d) {
      return d.fs.exists(join(d.root, 'renderer', 'node_modules', 'handlebars'))
        ? { present: true, detail: 'renderer/node_modules present' }
        : { present: false, detail: 'renderer/node_modules/handlebars missing' };
    },
    plan(d, det) {
      if (det.present) return done(det);
      if (d.platform === 'unsupported') return unsupported('renderer dependencies');
      return act({ id: 'renderer-deps:ci', summary: 'npm ci --prefix renderer', argv: ['npm', 'ci', '--prefix', 'renderer'], cwd: d.root, needsSudo: false, network: true });
    },
  };

  const chrome: Item = {
    id: 'chrome',
    title: 'Google Chrome',
    required: false,
    optionalKind: 'consent',
    async detect(d) {
      if (d.fs.exists('/Applications/Google Chrome.app')) return { present: true, detail: 'Google Chrome found' };
      const r = await d.run('google-chrome', ['--version']);
      return r.code === 0
        ? { present: true, version: firstLine(r.stdout), detail: 'Google Chrome found' }
        : { present: false, detail: 'Google Chrome not found' };
    },
    plan(d, det) {
      if (det.present) return done(det);
      if (d.platform === 'darwin') {
        return act({ id: 'chrome:brew', summary: 'brew install --cask google-chrome', argv: ['brew', 'install', '--cask', 'google-chrome'], needsSudo: false, network: true });
      }
      return { kind: 'owner', message: 'install Google Chrome from the download page (check upstream)', url: CHROME_URL };
    },
  };

  const tmux: Item = {
    id: 'tmux',
    title: 'tmux',
    required: true,
    detect: (d) => probe(d, 'tmux', ['-V'], 'tmux'),
    ...brewOrApt('tmux', 'tmux', ['tmux'], ['tmux']),
  };

  const uv: Item = {
    id: 'uv',
    title: 'uv',
    required: true,
    detect: (d) => probe(d, 'uv', ['--version'], 'uv'),
    ...brewOrApt('uv', 'uv', ['uv'], null, {
      kind: 'owner',
      message: 'install uv with the official installer (check upstream); the bootstrap can download it, show url/size/sha256 and ask again',
      url: UV_URL,
    }),
  };

  const ccgram: Item = {
    id: 'ccgram',
    title: `ccgram ${input.pin.version}`,
    required: true,
    async detect(d) {
      const r = await d.run('ccgram', ['--version']);
      if (r.code !== 0) return { present: false, detail: 'ccgram not installed' };
      const tokens = firstLine(r.stdout).split(/\s+/);
      const v = tokens[tokens.length - 1] ?? '';
      return v === input.pin.version
        ? { present: true, version: v, detail: `pinned ${v}` }
        : { present: false, version: v, detail: `installed ${v || 'unknown'} differs from pin ${input.pin.version}` };
    },
    plan(d, det) {
      if (det.present) return done(det);
      if (d.platform === 'unsupported') return unsupported('ccgram');
      const argv = ccgramInstallArgv(input.pin);
      return act({ id: 'ccgram:uv', summary: argv.join(' '), argv, needsSudo: false, network: true });
    },
  };

  const claude: Item = {
    id: 'claude-cli',
    title: 'Claude Code CLI',
    required: true,
    detect: (d) => probe(d, 'claude', ['--version'], 'claude'),
    plan(d, det) {
      if (det.present) return done(det);
      return {
        kind: 'owner',
        message: 'install Claude Code, then run: claude (check upstream for the install steps)',
        url: CLAUDE_URL,
      };
    },
    async offer(d, det) {
      if (det.present || d.platform === 'unsupported') return [];
      const p = await d.run('npm', ['prefix', '-g']);
      const prefix = p.stdout.trim();
      if (p.code !== 0 || !prefix) return [];
      const w = await d.run('test', ['-w', prefix]);
      if (w.code !== 0) return [];
      return [
        { id: 'claude-cli:npm', summary: 'npm install -g @anthropic-ai/claude-code', argv: ['npm', 'install', '-g', '@anthropic-ai/claude-code'], needsSudo: false, network: true },
      ];
    },
  };

  const reportOnly = (id: 'age' | 'rclone', cmd: string, args: string[]): Item => ({
    id,
    title: id,
    required: false,
    optionalKind: 'report_only',
    detect: (d) => probe(d, cmd, args, id),
    plan(d, det) {
      if (det.present) return done(det);
      const how = d.platform === 'darwin' ? 'brew install' : d.platform === 'linux' ? 'apt install' : null;
      return how ? { kind: 'owner', message: `optional, for backups: ${how} ${id}` } : unsupported(id);
    },
  });

  const modelParts = input.modelCli ? createModelParts(input.modelCli, input.modelProfile) : null;
  const classifier: Item = {
    id: 'classifier-model',
    title: `classifier model (${input.modelProfile})`,
    required: false,
    optionalKind: 'consent',
    detect: (d) =>
      input.detectClassifier
        ? input.detectClassifier(d, input.modelProfile)
        : modelParts
          ? modelParts.detect()
          : Promise.resolve({ present: false, detail: 'classifier model machinery not available' }),
    plan(_d, det) {
      if (det.present) return done(det);
      return modelParts ? modelParts.plan() : { kind: 'owner', message: 'run: npm run models -- fetch <profile>' };
    },
  };

  const items: Item[] = [git, buildTools, node, npmDeps];
  if (input.hasRenderer) items.push(rendererDeps);
  items.push(
    chrome,
    tmux,
    uv,
    ccgram,
    claude,
    reportOnly('age', 'age', ['--version']),
    reportOnly('rclone', 'rclone', ['version']),
    classifier,
  );

  // An unsupported platform never gets an install action: every missing item is an owner message.
  return items.map((it) => ({
    ...it,
    plan(d: BootstrapDeps, det: Detection): Plan {
      const p = it.plan(d, det);
      if (d.platform === 'unsupported' && p.kind === 'actions') return unsupported(it.title);
      return p;
    },
  }));
}
