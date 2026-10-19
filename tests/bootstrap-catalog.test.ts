// tests/bootstrap-catalog.test.ts
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../src/bootstrap/catalog.js';
import type { BootstrapDeps, Item, ItemId, Platform, Plan } from '../src/bootstrap/types.js';
import { ccgramInstallHint } from '../src/platform/checks.js';

const PIN = { version: '4.16.0' };
const ROOT = '/proj';

type Out = { code: number; stdout: string };
function deps(opts: { platform?: Platform; runs?: Record<string, Out>; files?: Record<string, string[] | true>; env?: NodeJS.ProcessEnv } = {}): BootstrapDeps {
  const runs = opts.runs ?? {};
  const files = opts.files ?? {};
  return {
    platform: opts.platform ?? 'darwin',
    root: ROOT,
    env: opts.env ?? { HOME: '/home/u' },
    run: async (cmd, args) => runs[[cmd, ...args].join(' ')] ?? { code: 127, stdout: '' },
    fs: {
      exists: (p) => p in files,
      read: () => '',
      list: (p) => (Array.isArray(files[p]) ? (files[p] as string[]) : []),
    },
    now: () => new Date(0),
  };
}

function catalog(hasRenderer = true): Map<ItemId, Item> {
  const items = buildCatalog({ pin: PIN, engines: '>=20', hasRenderer, modelProfile: 'default' });
  return new Map(items.map((i) => [i.id, i]));
}
const item = (id: ItemId, hasRenderer = true): Item => {
  const it = catalog(hasRenderer).get(id);
  if (!it) throw new Error(`no item ${id}`);
  return it;
};
async function planFor(id: ItemId, d: BootstrapDeps): Promise<Plan> {
  const it = item(id);
  return it.plan(d, await it.detect(d));
}
const actions = (p: Plan) => {
  if (p.kind !== 'actions') throw new Error(`expected actions, got ${p.kind}`);
  return p.actions;
};
const ok = (stdout: string): Out => ({ code: 0, stdout });

describe('detect', () => {
  const simple: Array<[ItemId, string, string]> = [
    ['git', 'git --version', 'git version 2.40.0'],
    ['tmux', 'tmux -V', 'tmux 3.4'],
    ['uv', 'uv --version', 'uv 0.5.0'],
    ['claude-cli', 'claude --version', '2.0.0 (Claude Code)'],
    ['age', 'age --version', 'v1.2.0'],
    ['rclone', 'rclone version', 'rclone v1.66'],
  ];
  for (const [id, cmd, out] of simple) {
    it(`${id} present and absent`, async () => {
      expect((await item(id).detect(deps({ runs: { [cmd]: ok(out) } }))).present).toBe(true);
      expect((await item(id).detect(deps())).present).toBe(false);
    });
  }

  it('build-tools: macOS xcode-select -p, Linux cc --version', async () => {
    expect((await item('build-tools').detect(deps({ runs: { 'xcode-select -p': ok('/Library/Developer/CommandLineTools') } }))).present).toBe(true);
    expect((await item('build-tools').detect(deps())).present).toBe(false);
    expect((await item('build-tools').detect(deps({ platform: 'linux', runs: { 'cc --version': ok('cc 12') } }))).present).toBe(true);
    expect((await item('build-tools').detect(deps({ platform: 'linux' }))).present).toBe(false);
  });

  it('node: present, absent, wrong version', async () => {
    expect((await item('node').detect(deps({ runs: { 'node -v': ok('v22.1.0\n') } }))).present).toBe(true);
    expect((await item('node').detect(deps({ runs: { 'node -v': ok('v18.9.0\n') } }))).present).toBe(false);
    expect((await item('node').detect(deps())).present).toBe(false);
  });

  it('npm-deps needs the lock marker and three packages', async () => {
    const nm = `${ROOT}/node_modules`;
    const all: Record<string, true> = {};
    for (const n of ['.package-lock.json', 'tsx', 'better-sqlite3', 'patchright']) all[`${nm}/${n}`] = true;
    expect((await item('npm-deps').detect(deps({ files: all }))).present).toBe(true);
    const partial = { ...all };
    delete partial[`${nm}/tsx`];
    const det = await item('npm-deps').detect(deps({ files: partial }));
    expect(det.present).toBe(false);
    expect(det.detail).toContain('tsx');
  });

  it('renderer-deps probes handlebars', async () => {
    expect((await item('renderer-deps').detect(deps({ files: { [`${ROOT}/renderer/node_modules/handlebars`]: true } }))).present).toBe(true);
    expect((await item('renderer-deps').detect(deps())).present).toBe(false);
  });

  it('there is no Playwright browser item: every browser runs on the installed Chrome', () => {
    expect(catalog().has('playwright-chromium' as ItemId)).toBe(false);
  });

  it('chrome: app bundle or google-chrome', async () => {
    expect((await item('chrome').detect(deps({ files: { '/Applications/Google Chrome.app': true } }))).present).toBe(true);
    expect((await item('chrome').detect(deps({ runs: { 'google-chrome --version': ok('Google Chrome 120') } }))).present).toBe(true);
    expect((await item('chrome').detect(deps())).present).toBe(false);
  });

  it('ccgram: pinned, wrong version, absent', async () => {
    expect((await item('ccgram').detect(deps({ runs: { 'ccgram --version': ok('ccgram 4.16.0\n') } }))).present).toBe(true);
    const wrong = await item('ccgram').detect(deps({ runs: { 'ccgram --version': ok('ccgram 4.15.0') } }));
    expect(wrong.present).toBe(false);
    expect(wrong.version).toBe('4.15.0');
    expect((await item('ccgram').detect(deps())).present).toBe(false);
  });

  it('classifier-model reports absent by default and uses an injected hook', async () => {
    expect((await item('classifier-model').detect(deps())).detail).toBe('classifier model machinery not available');
    const it2 = buildCatalog({
      pin: PIN, engines: '>=20', hasRenderer: true, modelProfile: 'p1',
      detectClassifier: async (_d, profile) => ({ present: true, detail: `ok ${profile}` }),
    }).find((i) => i.id === 'classifier-model')!;
    expect(await it2.detect(deps())).toEqual({ present: true, detail: 'ok p1' });
  });
});

describe('plan, macOS', () => {
  it('git and build-tools: owner xcode-select --install', async () => {
    for (const id of ['git', 'build-tools'] as ItemId[]) {
      const p = await planFor(id, deps());
      expect(p.kind).toBe('owner');
      expect(p.kind === 'owner' && p.message).toContain('xcode-select --install');
    }
  });
  it('node: brew node', async () => {
    expect(actions(await planFor('node', deps()))[0].argv).toEqual(['brew', 'install', 'node']);
  });
  it('npm-deps and renderer-deps', async () => {
    expect(actions(await planFor('npm-deps', deps()))[0]).toMatchObject({ argv: ['npm', 'ci'], network: true, needsSudo: false });
    expect(actions(await planFor('renderer-deps', deps()))[0].argv).toEqual(['npm', 'ci', '--prefix', 'renderer']);
  });
  it('chrome: brew cask', async () => {
    expect(actions(await planFor('chrome', deps()))[0].argv).toEqual(['brew', 'install', '--cask', 'google-chrome']);
  });
  it('tmux and uv: brew', async () => {
    expect(actions(await planFor('tmux', deps()))[0].argv).toEqual(['brew', 'install', 'tmux']);
    expect(actions(await planFor('uv', deps()))[0].argv).toEqual(['brew', 'install', 'uv']);
  });
  it('ccgram: argv equals the doctor hint command', async () => {
    const a = actions(await planFor('ccgram', deps()))[0];
    expect(a.argv.join(' ')).toBe(ccgramInstallHint(PIN).replace(/"/g, ''));
  });
  it('claude-cli: owner message; npm action only when prefix is writable', async () => {
    const p = await planFor('claude-cli', deps());
    expect(p.kind).toBe('owner');
    const it = item('claude-cli');
    const none = await it.detect(deps());
    expect(await it.offer!(deps(), none)).toEqual([]);
    const w = deps({ runs: { 'npm prefix -g': ok('/home/u/.npm-global\n'), 'test -w /home/u/.npm-global': ok('') } });
    const offered = await it.offer!(w, none);
    expect(offered[0].argv).toEqual(['npm', 'install', '-g', '@anthropic-ai/claude-code']);
    expect(offered[0].needsSudo).toBe(false);
  });
  it('age and rclone: report line, never actions', async () => {
    for (const id of ['age', 'rclone'] as ItemId[]) {
      const p = await planFor(id, deps());
      expect(p.kind).toBe('owner');
      expect(p.kind === 'owner' && p.message).toContain(`brew install ${id}`);
    }
  });
  it('present items plan none', async () => {
    expect((await planFor('tmux', deps({ runs: { 'tmux -V': ok('tmux 3.4') } }))).kind).toBe('none');
  });
});

describe('plan, Linux', () => {
  const L = (extra: Parameters<typeof deps>[0] = {}) => deps({ platform: 'linux', ...extra });
  it('git, build-tools, tmux: apt with sudo flag', async () => {
    expect(actions(await planFor('git', L()))[0]).toMatchObject({ argv: ['apt-get', 'install', '-y', 'git'], needsSudo: true });
    expect(actions(await planFor('build-tools', L()))[0]).toMatchObject({ argv: ['apt-get', 'install', '-y', 'build-essential'], needsSudo: true });
    expect(actions(await planFor('tmux', L()))[0]).toMatchObject({ argv: ['apt-get', 'install', '-y', 'tmux'], needsSudo: true });
  });
  it('node: apt when the candidate satisfies engines', async () => {
    const d = L({ runs: { 'apt-cache policy nodejs': ok('nodejs:\n  Installed: (none)\n  Candidate: 20.11.0-1\n') } });
    expect(actions(await planFor('node', d))[0].argv).toEqual(['apt-get', 'install', '-y', 'nodejs']);
  });
  it('node: owner message with a URL when the candidate is old', async () => {
    const d = L({ runs: { 'apt-cache policy nodejs': ok('nodejs:\n  Candidate: 12.22.9~dfsg-1\n') } });
    const p = await planFor('node', d);
    expect(p.kind).toBe('owner');
    expect(p.kind === 'owner' && p.url).toBeTruthy();
  });
  it('node: owner when apt-cache is unavailable', async () => {
    expect((await planFor('node', L())).kind).toBe('owner');
  });
  it('chrome: owner message only', async () => {
    const p = await planFor('chrome', L());
    expect(p.kind).toBe('owner');
    expect(p.kind === 'owner' && p.url).toBeTruthy();
  });
  it('uv: owner message with the installer URL', async () => {
    const p = await planFor('uv', L());
    expect(p.kind).toBe('owner');
    expect(p.kind === 'owner' && p.url).toContain('astral.sh');
  });
  it('ccgram matches the doctor hint on Linux too', async () => {
    expect(actions(await planFor('ccgram', L()))[0].argv.join(' ')).toBe(ccgramInstallHint(PIN).replace(/"/g, ''));
  });
  it('age and rclone report apt install', async () => {
    const p = await planFor('age', L());
    expect(p.kind === 'owner' && p.message).toContain('apt install age');
  });
});

describe('invariants', () => {
  it('unsupported platform returns owner for every missing item', async () => {
    const d = deps({ platform: 'unsupported' });
    for (const it of catalog().values()) {
      const det = await it.detect(d);
      if (det.present) continue;
      expect(it.plan(d, det).kind, it.id).toBe('owner');
    }
  });

  it('no argv contains sudo or a shell metacharacter, on any platform', async () => {
    for (const platform of ['darwin', 'linux'] as Platform[]) {
      const d = deps({ platform });
      for (const it of catalog().values()) {
        const p = it.plan(d, { present: false, detail: 'x', candidateMajor: 22 });
        if (p.kind !== 'actions') continue;
        for (const a of p.actions) {
          for (const arg of a.argv) {
            expect(arg, `${it.id}:${arg}`).not.toBe('sudo');
            expect(arg, `${it.id}:${arg}`).not.toMatch(/[;&|$`<>\\\n'"(){}*?]/);
          }
        }
      }
    }
  });

  it('renderer-deps is absent when hasRenderer is false', () => {
    expect(catalog(false).has('renderer-deps')).toBe(false);
    expect(catalog(true).has('renderer-deps')).toBe(true);
  });

  it('required flags and optional kinds', () => {
    const c = catalog();
    for (const id of ['git', 'build-tools', 'node', 'npm-deps', 'renderer-deps', 'tmux', 'uv', 'ccgram', 'claude-cli'] as ItemId[]) {
      expect(c.get(id)!.required, id).toBe(true);
    }
    expect(c.get('chrome')!.optionalKind).toBe('consent');
    expect(c.get('age')!.optionalKind).toBe('report_only');
    expect(c.get('rclone')!.optionalKind).toBe('report_only');
  });
});

describe('ccgramInstallHint', () => {
  it('prints the exact existing doctor hint', () => {
    expect(ccgramInstallHint({ version: '1.2.3' })).toBe('uv tool install --python 3.14 "ccgram==1.2.3"');
  });
});
