// src/platform/checksBootstrap.ts
// Doctor check bootstrap_complete: reuses the bootstrap catalog detections over the doctor's run and fs.
// Read-only: never installs, downloads or fetches. Output lists item ids only.
import { join } from 'node:path';
import { buildCatalog } from '../bootstrap/catalog.js';
import type { BootstrapDeps, CcgramPin, Detection, ItemId, Platform } from '../bootstrap/types.js';
import { parseEnv } from './envFile.js';
import { defaultFetchDeps } from '../safety/modelFetch.js';
import type { Check, CheckResult, DoctorContext } from './doctor.js';

const REQUIRED: ItemId[] = ['node', 'npm-deps', 'renderer-deps', 'tmux', 'uv', 'ccgram', 'claude-cli'];
const OPTIONAL: ItemId[] = ['chrome', 'classifier-model'];
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function hostPlatform(): Platform {
  return process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : 'unsupported';
}

export function bootstrapChecks(
  opts: { platform?: Platform; detectClassifier?: (d: BootstrapDeps, profile: string) => Promise<Detection> } = {},
): Check[] {
  return [
    {
      id: 'bootstrap_complete',
      title: 'Bootstrap prerequisites present',
      async run(ctx: DoctorContext): Promise<CheckResult> {
        const platform = opts.platform ?? hostPlatform();
        if (platform === 'unsupported') {
          return { status: 'warn', detail: 'unsupported platform: bootstrap cannot install prerequisites here', fix: 'install the prerequisites by hand, see README.md' };
        }
        let pin: CcgramPin;
        let engines = '>=20';
        try {
          pin = JSON.parse(ctx.fs.read(join(ctx.root, 'config', 'ccgram.pin.json'))) as CcgramPin;
          engines = (JSON.parse(ctx.fs.read(join(ctx.root, 'package.json'))) as { engines?: { node?: string } }).engines?.node ?? engines;
        } catch {
          return { status: 'fail', detail: 'cannot read config/ccgram.pin.json or package.json', fix: 'bash scripts/bootstrap.sh' };
        }
        const registryPath = join(ctx.root, 'config', 'classifier-models.json');
        let profile = 'unresolved';
        // process env wins; else the single key BOOTSTRAP_MODEL_PROFILE from <root>/.env (nothing else is used)
        let envP: string | undefined = ctx.env.BOOTSTRAP_MODEL_PROFILE;
        if (!envP) {
          try {
            envP = parseEnv(ctx.fs.read(join(ctx.root, '.env'))).BOOTSTRAP_MODEL_PROFILE;
          } catch {
            envP = undefined;
          }
        }
        if (envP && ID_RE.test(envP)) profile = envP;
        else {
          try {
            const d = (JSON.parse(ctx.fs.read(registryPath)) as { default_profile?: unknown }).default_profile;
            if (typeof d === 'string' && ID_RE.test(d)) profile = d;
          } catch {
            /* classifier-model then reads as absent */
          }
        }
        const items = buildCatalog({
          pin,
          engines,
          hasRenderer: ctx.fs.exists(join(ctx.root, 'renderer', 'package.json')),
          modelProfile: profile,
          // detect only runs a read-only registry verify; the fetch deps are never exercised
          modelCli: { registryPath, root: ctx.root, env: {}, fetchDeps: defaultFetchDeps(() => {}), out: () => {} },
          ...(opts.detectClassifier
            ? { detectClassifier: opts.detectClassifier }
            : profile === 'unresolved'
            ? {
                detectClassifier: async (): Promise<never> => {
                  throw new Error('no classifier profile');
                },
              }
            : {}),
        });
        const deps: BootstrapDeps = {
          platform,
          root: ctx.root,
          env: ctx.env,
          run: ctx.run,
          // scripts/doctor.ts supplies fs.list (readdirSync), so list-based detections work; [] only for a ctx without it
          fs: { exists: (p) => ctx.fs.exists(p), read: (p) => ctx.fs.read(p), list: (p) => ctx.fs.list?.(p) ?? [] },
          now: ctx.now ?? (() => new Date()),
        };
        const absentReq: string[] = [];
        const absentOpt: string[] = [];
        const present: string[] = [];
        for (const it of items) {
          const isReq = REQUIRED.includes(it.id);
          if (!isReq && !OPTIONAL.includes(it.id)) continue;
          let ok = false;
          try {
            ok = (await it.detect(deps)).present;
          } catch {
            ok = false;
          }
          if (ok) present.push(it.id);
          else (isReq ? absentReq : absentOpt).push(it.id);
        }
        if (absentReq.length) return { status: 'fail', detail: `missing required: ${absentReq.join(', ')}`, fix: 'bash scripts/bootstrap.sh' };
        if (absentOpt.length) return { status: 'warn', detail: `optional missing: ${absentOpt.join(', ')}`, fix: 'npm run bootstrap' };
        return { status: 'pass', detail: `present: ${present.join(', ')}` };
      },
    },
  ];
}
