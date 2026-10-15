// src/setup/steps/classifier.ts
// Setup step: explain, ask consent, download (ungated profiles only), verify, smoke test, then
// write CLASSIFIER_MODEL=<profile id>. Resumable: a re-run reuses finished files and .partial
// state. Never reads a token variable; gated or owner-supplied profiles are never fetched.
import path from 'node:path';
import { loadClassifier } from '../../safety/classifierModel.js';
import { isFullyPinned, loadRegistry, type ClassifierProfile, type ClassifierRegistry } from '../../safety/classifierRegistry.js';
import { defaultFetchDeps, fetchProfile, GatedProfileError, verifyProfile, type FetchDeps } from '../../safety/modelFetch.js';
import { SMOKE_BENIGN, SMOKE_INJECTION } from '../../safety/smoke.js';
import { updateEnvText, writeEnvFile } from '../envWriter.js';
import { say } from '../coach.js';
import type { SetupContext, SetupStep } from '../runner.js';

export interface ClassifierStepDeps {
  registryPath?: string;
  fetchDeps?: FetchDeps;
  smoke?: (p: ClassifierProfile, root: string) => Promise<{ benign: number; injection: number }>;
}

const mb = (n: number): string => `${(n / (1024 * 1024)).toFixed(1)} MB`;
const totalBytes = (p: ClassifierProfile): number => p.files.reduce((n, f) => n + f.size, 0);
const oneLine = (e: unknown): string => String((e as Error)?.message ?? 'unknown error').split('\n')[0].slice(0, 300);

async function defaultSmoke(p: ClassifierProfile, root: string): Promise<{ benign: number; injection: number }> {
  const { classifier } = await loadClassifier({ profile: p, root, allowUnfitted: true });
  const benign = (await classifier.classify(SMOKE_BENIGN)).score;
  const injection = (await classifier.classify(SMOKE_INJECTION)).score;
  return { benign, injection };
}

function describe(ctx: SetupContext, p: ClassifierProfile): void {
  const { io } = ctx;
  io.say(`Model: ${p.title} (${p.id})`);
  io.say(`Licence: ${p.licence.id} (${p.licence.url})`);
  io.say(`Attribution: ${p.licence.attribution}`);
  if (p.limitations.length > 0) {
    io.say('Limitations:');
    for (const l of p.limitations) io.say(`  - ${l}`);
  }
  io.say(`Download size: ${mb(totalBytes(p))}`);
  io.say(
    'The classifier reads untrusted text (job posts, profiles, replies) before the agent sees it and blocks injected instructions. It runs locally; no text leaves this machine.',
  );
  io.say(
    'The default model is English-only and does not detect jailbreaks. Llama Prompt Guard 2 is an optional upgrade that needs your own gated Hugging Face access and an ONNX file you supply; it is never downloaded automatically.',
  );
  io.say(
    'The model files are downloaded from huggingface.co at a fixed, pinned version, checked against known hashes, and stored in models/ (not committed).',
  );
}

function writeEnv(ctx: SetupContext, id: string): void {
  let text = '';
  if (ctx.fs.exists(ctx.envPath)) text = ctx.fs.read(ctx.envPath);
  else {
    const example = path.join(ctx.root, '.env.example');
    if (ctx.fs.exists(example)) text = ctx.fs.read(example);
  }
  const upd = updateEnvText(text, { CLASSIFIER_MODEL: id });
  if (upd.changed.length > 0 || !ctx.fs.exists(ctx.envPath)) {
    writeEnvFile(ctx.envPath, upd.text, ctx.fs, ctx.now);
    ctx.io.say(`.env updated (${upd.changed.join(', ')})`);
  } else {
    ctx.io.say('.env already has CLASSIFIER_MODEL set to this profile');
  }
}

function fitNotice(ctx: SetupContext, p: ClassifierProfile): void {
  const model = p.files.find((f) => f.role === 'model');
  const fitted =
    typeof p.fit.threshold === 'number' && !!model?.sha256 && p.fit.model_sha256 === model.sha256;
  if (!fitted) {
    ctx.io.say(
      `Threshold is not fitted for this model: sends are refused until you run: npm run classifier:fit -- --profile ${p.id} --write (dry runs work now)`,
    );
    ctx.io.say(
      `Remaining steps: 1) npm run models -- pin ${p.id} (if files are unpinned), 2) npm run classifier:fit -- --profile ${p.id} --write, 3) CLASSIFIER_MODEL=${p.id} in .env (done above), 4) npm run doctor, then restart sessions.`,
    );
  }
}

export function createClassifierStep(deps: ClassifierStepDeps = {}): SetupStep {
  return {
    id: 'classifier',
    title: 'Prompt-injection classifier model',
    checkIds: ['classifier_model', 'classifier_smoke'],
    async run(ctx) {
      const { io, root } = ctx;
      let blobOnly = false;
      const registryPath = deps.registryPath ?? path.join(root, 'config', 'classifier-models.json');
      let reg: ClassifierRegistry;
      try {
        reg = loadRegistry(registryPath);
      } catch (e) {
        throw new Error(`classifier registry error: ${oneLine(e)}`);
      }
      const all = Object.values(reg.profiles);
      const ordered = [...all.filter((p) => p.fetchable && !p.gated), ...all.filter((p) => !(p.fetchable && !p.gated))];
      const dflt = Object.prototype.hasOwnProperty.call(reg.profiles, reg.default_profile)
        ? reg.default_profile
        : ordered[0].id;
      const id = await io.choose(
        'Which classifier model?',
        ordered.map((p) => ({
          value: p.id,
          label: `${p.title} (${p.licence.id}, ${p.fetchable && !p.gated ? 'downloaded for you' : 'you supply the files'})`,
        })),
        dflt,
      );
      const p = reg.profiles[id];
      describe(ctx, p);
      say(ctx, 'classifier.intro');
      say(ctx, 'classifier.required');
      say(ctx, 'classifier.commands');

      if (p.gated || !p.fetchable) {
        io.say('This profile is not downloaded automatically. Manual steps:');
        const steps = p.manual_steps && p.manual_steps.length > 0 ? p.manual_steps : [`Place the files in models/${p.id}/ yourself.`];
        steps.forEach((s, i) => io.say(`  ${i + 1}. ${s}`));
        await io.pause('Place the files, then press Enter');
        const v = await verifyProfile(p, root);
        if (v.problems.some((x) => x.endsWith(': missing'))) {
          io.say(`Files are not all present in models/${p.id}/. Nothing was changed; rerun this step when they are in place.`);
          return 'skipped';
        }
        const onlyUnpinned = v.problems.every((x) => x.endsWith(': size not pinned') || x.endsWith(': no digest pinned'));
        if (!v.ok && !onlyUnpinned) throw new Error(`model files do not verify: ${v.problems.join('; ')}`);
        if (v.unpinned.length > 0) {
          io.say(
            `${v.unpinned.length} file(s) are not sha256-pinned. Review and record them with: npm run models -- pin ${p.id}, then rerun this step.`,
          );
          return 'skipped';
        }
      } else {
        const size = mb(totalBytes(p));
        if (!(await io.confirm(`Download ${size} now?`, false))) {
          io.say(`Not downloaded. Fetch later with: npm run models -- fetch ${p.id}`);
          say(ctx, 'classifier.skip');
          return 'skipped';
        }
        const fetchDeps = deps.fetchDeps ?? defaultFetchDeps((l) => io.say(l));
        try {
          await fetchProfile(p, root, fetchDeps);
        } catch (e) {
          if (e instanceof GatedProfileError) {
            io.say(`profile ${p.id} cannot be downloaded automatically`);
            e.manualSteps.forEach((s, i) => io.say(`  ${i + 1}. ${s}`));
          } else {
            io.say(`download failed: ${oneLine(e)} (finished files are kept; rerun resumes)`);
          }
          throw e;
        }
        const v = await verifyProfile(p, root);
        if (!v.ok) throw new Error(`model files do not verify: ${v.problems.join('; ')}`);
        if (v.unpinned.length > 0 || !isFullyPinned(p)) blobOnly = true;
        if (v.unpinned.length > 0) {
          io.say(
            `${v.unpinned.length} file(s) are verified only by git blob id (${Object.keys(v.observed_sha256).length} sha256 values observed). Record them yourself with: npm run models -- pin ${p.id} (review the registry diff first).`,
          );
        }
      }

      if (blobOnly) {
        io.say(
          `smoke test skipped: files are verified by git blob id only; run npm run models -- pin ${p.id} then npm run doctor`,
        );
      } else {
        const smoke = deps.smoke ?? defaultSmoke;
        let s: { benign: number; injection: number };
        try {
          s = await smoke(p, root);
        } catch (e) {
          io.say(`smoke test could not run: ${oneLine(e)}`);
          throw e;
        }
        io.say(`smoke: benign ${s.benign.toFixed(3)}, injection ${s.injection.toFixed(3)}`);
        if (!(s.benign < 0.5 && s.injection >= 0.5)) {
          throw new Error(`smoke test failed: benign ${s.benign.toFixed(3)}, injection ${s.injection.toFixed(3)}`);
        }
      }

      writeEnv(ctx, p.id);
      fitNotice(ctx, p);
      return 'done';
    },
  };
}

export const classifierStep: SetupStep = createClassifierStep();
