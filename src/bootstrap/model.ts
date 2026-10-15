// src/bootstrap/model.ts
// Classifier model item: detect and plan over scripts/models.ts (runCli, describeProfile).
// Never pins, never fits, never writes .env or config; the owner steps are always printed.
import { describeProfile, runCli, type CliDeps } from '../../scripts/models.js';
import { loadRegistry, type ClassifierProfile } from '../safety/classifierRegistry.js';
import type { Action, Detection, Plan } from './types.js';

const mbOf = (p: ClassifierProfile): string => (p.files.reduce((n, f) => n + f.size, 0) / (1024 * 1024)).toFixed(1);

export function ownerNote(id: string): string {
  return `needs the owner: \`npm run models -- pin ${id}\`, \`npm run classifier:fit -- --profile ${id} --write\`, set \`CLASSIFIER_MODEL\` (the setup \`classifier\` step does this)`;
}

/** Which files are strongly pinned (sha256) and which only by git blob sha1, from the registry. */
export function pinnedLines(p: ClassifierProfile): string[] {
  const sha = p.files.filter((f) => f.sha256).map((f) => f.local);
  const blob = p.files.filter((f) => !f.sha256 && f.git_blob_sha1).map((f) => f.local);
  const none = p.files.filter((f) => !f.sha256 && !f.git_blob_sha1).map((f) => f.local);
  return [
    `pinned: ${sha.length ? sha.join(', ') + ' (sha256)' : 'none by sha256'}; ${blob.length ? blob.join(', ') + ' (git blob sha1)' : 'no git-blob-only files'}${none.length ? `; unpinned: ${none.join(', ')}` : ''}`,
  ];
}

async function capture(argv: string[], cli: CliDeps): Promise<{ code: number; lines: string[] }> {
  const lines: string[] = [];
  const code = await runCli(argv, { ...cli, out: (l) => lines.push(l) });
  return { code, lines };
}

export function createModelParts(cli: CliDeps, id: string): { detect(): Promise<Detection>; plan(): Plan } {
  let profile: ClassifierProfile | null = null;
  const load = (): ClassifierProfile => {
    if (profile) return profile;
    const reg = loadRegistry(cli.registryPath);
    if (!Object.prototype.hasOwnProperty.call(reg.profiles, id)) throw new Error(`unknown classifier profile "${id.slice(0, 64)}"`);
    profile = reg.profiles[id]!;
    return profile;
  };
  return {
    async detect() {
      const p = load();
      if (p.gated || !p.fetchable) {
        // A gated profile can still be present if the owner placed the files by hand.
        const v = await capture(['verify', id], cli);
        return v.code === 0
          ? { present: true, detail: `${id}: files verified; ${ownerNote(id)}` }
          : { present: false, detail: `${id}: gated, files not present` };
      }
      const v = await capture(['verify', id], cli);
      if (v.code === 0) return { present: true, detail: `${id}: files present and verified; ${ownerNote(id)}` };
      return { present: false, detail: `${id}: weights not downloaded or not verified (${mbOf(p)} MB)` };
    },
    plan() {
      const p = load();
      if (p.gated || !p.fetchable) {
        const steps = p.manual_steps?.length ? p.manual_steps : [`place the files in models/${id}/ yourself`];
        return { kind: 'owner', message: `${id} is gated and is never fetched here; manual steps: ${steps.map((s, i) => `${i + 1}. ${s}`).join(' ')} then verify with npm run models -- verify ${id}; ${ownerNote(id)}` };
      }
      const size = mbOf(p);
      const action: Action = {
        id: `classifier-model:${id}`,
        summary: `download ${id} weights (about ${size} MB) and hash-check each file`,
        argv: ['npm', 'run', 'models', '--', 'fetch', id, '--yes'],
        needsSudo: false,
        network: true,
        lines: [
          ...describeProfile(p),
          `Weights download from Hugging Face (about ${size} MB); each file is hash-checked after download`,
          ...pinnedLines(p),
          ownerNote(id),
        ],
        fn: async () => {
          await capture(['fetch', id, '--yes'], cli);
          const v = await capture(['verify', id], cli);
          // Hash verification is the arbiter: files that verify are good whatever the fetch loop reported.
          if (v.code === 0) return { ok: true, note: 'downloaded and verified' };
          const problems = v.lines.filter((l) => l.startsWith('problem:')).length;
          return { ok: false, note: `download or verification failed (${problems} problem${problems === 1 ? '' : 's'}); run npm run models -- verify ${id}` };
        },
      };
      return { kind: 'actions', actions: [action] };
    },
  };
}
