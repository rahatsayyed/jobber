// scripts/models.ts
// Usage: npm run models -- list | verify [<profile>] | fetch [<profile>] [--yes] | pin <profile>
// Never reads HF_TOKEN or any env value other than CLASSIFIER_MODEL, never writes .env.
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { loadRegistry, type ClassifierProfile, type ClassifierRegistry } from '../src/safety/classifierRegistry.js';
import {
  defaultFetchDeps,
  fetchProfile,
  GatedProfileError,
  listProfiles,
  pinProfile,
  verifyProfile,
  type FetchDeps,
} from '../src/safety/modelFetch.js';

export interface CliDeps {
  registryPath: string;
  root: string;
  env: NodeJS.ProcessEnv;
  out(line: string): void;
  confirm?(prompt: string): Promise<boolean>;
  fetchDeps: FetchDeps;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const USAGE = [
  'usage: npm run models -- list',
  '       npm run models -- verify [<profile>]',
  '       npm run models -- fetch [<profile>] [--yes]',
  '       npm run models -- pin <profile>',
];

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`;

export function describeProfile(p: ClassifierProfile): string[] {
  const total = p.files.reduce((n, f) => n + f.size, 0);
  return [
    `profile: ${p.id}`,
    `title: ${p.title}`,
    `licence: ${p.licence.id} (${p.licence.url})`,
    `attribution: ${p.licence.attribution}`,
    `approx size: ${mb(total)}`,
    ...(p.limitations.length ? ['limitations:', ...p.limitations.map((l) => `  - ${l}`)] : []),
  ];
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { out } = deps;
  const usage = (): number => {
    for (const l of USAGE) out(l);
    return 2;
  };
  const [cmd, ...rest] = argv;
  if (!cmd || !['list', 'verify', 'fetch', 'pin'].includes(cmd)) return usage();
  const yes = rest.includes('--yes');
  const positional = rest.filter((a) => !a.startsWith('--'));
  if (rest.some((a) => a.startsWith('--') && a !== '--yes') || positional.length > 1) return usage();
  if (cmd === 'list' && positional.length > 0) return usage();

  let reg: ClassifierRegistry;
  try {
    reg = loadRegistry(deps.registryPath);
  } catch (e) {
    out(`registry error: ${(e as Error).message}`);
    return 1;
  }

  if (cmd === 'list') {
    for (const r of await listProfiles(reg, deps.root, deps.env)) {
      out(
        `${r.id}${r.selected ? ' [selected]' : ''} | licence: ${r.licence} | gated: ${r.gated ? 'yes' : 'no'} | ` +
          `present: ${r.present ? 'yes' : 'no'} | verified: ${r.verified ? 'yes' : 'no'} | ` +
          `fitted: ${r.fitted ? 'yes' : 'no'} | ${mb(r.approx_bytes)}`,
      );
    }
    return 0;
  }

  let id = positional[0];
  if (id === undefined) {
    const envId = (deps.env.CLASSIFIER_MODEL ?? '').trim();
    id = envId || (cmd === 'pin' ? '' : reg.default_profile);
  }
  if (!id || !ID_RE.test(id) || !Object.prototype.hasOwnProperty.call(reg.profiles, id)) {
    out(`unknown profile${id ? ` "${id.slice(0, 64).replace(/[^\x20-\x7e]/g, '?')}"` : ''}; known: ${Object.keys(reg.profiles).join(', ')}`);
    return usage();
  }
  const p = reg.profiles[id];

  if (cmd === 'verify') {
    const v = await verifyProfile(p, deps.root);
    for (const f of Object.keys(v.observed_sha256)) out(`${f}: sha256 ${v.observed_sha256[f]}`);
    for (const pr of v.problems) out(`problem: ${pr}`);
    for (const u of v.unpinned) out(`warning: ${u} is not fully pinned (run: npm run models -- pin ${p.id})`);
    out(v.ok ? `${p.id}: ok` : `${p.id}: FAILED`);
    return v.ok ? 0 : 1;
  }

  if (cmd === 'pin') {
    try {
      const r = await pinProfile(p, deps.root, deps.registryPath);
      if (r.written.length === 0) out(`${p.id}: already pinned, nothing written`);
      else {
        for (const f of r.written) out(`pinned: ${f}`);
        out(`Read the diff of ${deps.registryPath} and commit it (config/classifier-models.json).`);
      }
      return 0;
    } catch (e) {
      out(`pin failed: ${(e as Error).message}`);
      return 1;
    }
  }

  // fetch
  for (const l of describeProfile(p)) out(l);
  if (p.gated || !p.fetchable) {
    out(`profile ${p.id} cannot be downloaded automatically. Manual steps:`);
    const steps = p.manual_steps && p.manual_steps.length ? p.manual_steps : [`Place the files in models/${p.id}/ yourself.`];
    steps.forEach((s, i) => out(`  ${i + 1}. ${s}`));
    return 3;
  }
  const ok = yes || (deps.confirm ? await deps.confirm(`Download ${p.id} (${mb(p.files.reduce((n, f) => n + f.size, 0))})?`) : false);
  if (!ok) {
    out('not confirmed: nothing downloaded (pass --yes to confirm)');
    return 4;
  }
  try {
    const s = await fetchProfile(p, deps.root, deps.fetchDeps);
    const v = await verifyProfile(p, deps.root);
    for (const f of s.files) out(`${f.status}: ${f.file.split('/').pop()} (${f.bytes} bytes)`);
    for (const pr of v.problems) out(`problem: ${pr}`);
    for (const u of v.unpinned) out(`unpinned: ${u} (run: npm run models -- pin ${p.id})`);
    out(v.ok ? `${p.id}: downloaded and verified` : `${p.id}: downloaded but verification FAILED`);
    return v.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof GatedProfileError) {
      e.manualSteps.forEach((s, i) => out(`  ${i + 1}. ${s}`));
      return 3;
    }
    out(`fetch failed: ${(e as Error).message}`);
    return 1;
  }
}

async function main(): Promise<void> {
  const fetchDeps: FetchDeps = defaultFetchDeps((l) => console.log(l));
  const deps: CliDeps = {
    registryPath: 'config/classifier-models.json',
    root: process.cwd(),
    env: { CLASSIFIER_MODEL: process.env.CLASSIFIER_MODEL },
    out: (l) => console.log(l),
    fetchDeps,
    confirm: async (prompt) => {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^y(es)?$/i.test((await rl.question(`${prompt} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
  };
  process.exitCode = await runCli(process.argv.slice(2), deps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  });
}
