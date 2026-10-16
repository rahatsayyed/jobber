// scripts/classifier/fit.ts  (owner-run: needs the profile's pinned model files on disk)
// Usage: npm run classifier:fit -- [--profile <id>] [--write] [--force-small] [--max-fpr 0.01] [--seed s] [--held-out 0.3]
import { existsSync, readFileSync } from 'node:fs';
import { loadClassifier } from '../../src/safety/classifierModel.js';
import { loadRegistry, pinFromProfile, writeFit } from '../../src/safety/classifierRegistry.js';
import { buildFitRecord, heldOutTooSmall, parseFitArgs } from '../../src/safety/fitRecord.js';
import { evaluate, fitThreshold, splitCorpus, type Scored } from '../../src/safety/thresholdFit.js';

const REGISTRY_PATH = 'config/classifier-models.json';

interface Item {
  id: string;
  label: 'attack' | 'benign';
  category?: string;
  text: string;
}
const readJsonl = (path: string, label?: 'benign', category?: string): Item[] =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l, i) => {
      const o = JSON.parse(l) as Partial<Item>;
      return {
        id: o.id ?? `${category ?? 'row'}-${i}`,
        label: label ?? (o.label as Item['label']),
        category: category ?? o.category,
        text: String(o.text ?? ''),
      };
    });

async function main(): Promise<void> {
  const reg = loadRegistry(REGISTRY_PATH);
  let args;
  try {
    args = parseFitArgs(process.argv.slice(2), process.env, reg);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(2);
  }
  const { profileId, maxFpr, seed, heldFrac } = args;
  const profile = reg.profiles[profileId];
  const modelSha256 = pinFromProfile(profile).model.sha256;
  // allowUnfitted: an unfitted or re-digested profile must be fittable; only verdict.score is used here.
  const { classifier } = await loadClassifier({ profile, allowUnfitted: true });
  const attacks = readJsonl('config/injection-corpus/attacks.jsonl');
  const benign = readJsonl('config/injection-corpus/benign.jsonl');
  const ownerPath = 'user-data/injection-benign.jsonl';
  const owner = existsSync(ownerPath) ? readJsonl(ownerPath, 'benign', 'owner') : [];
  const scored: Scored[] = [];
  for (const it of [...attacks, ...benign, ...owner]) {
    const v = await classifier.classify(it.text);
    scored.push({ id: it.id, label: it.label, category: it.category, score: v.score });
  }
  const { fit, heldOut } = splitCorpus(scored, seed, heldFrac);
  const count = (xs: Scored[], l: Scored['label']): number => xs.filter((x) => x.label === l).length;
  const fitted = fitThreshold(fit, { maxBenignFpr: maxFpr });
  const held = evaluate(heldOut, fitted.threshold);
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const hb = count(heldOut, 'benign');
  const ha = count(heldOut, 'attack');
  const small = hb < 100 || ha < 50;
  console.log(`profile ${profileId}`);
  console.log(`fit: ${count(fit, 'attack')} attack / ${count(fit, 'benign')} benign; held-out: ${ha} attack / ${hb} benign${small ? ' (small sample)' : ''}`);
  console.log(`threshold ${fitted.threshold.toFixed(6)}  fit tpr ${pct(fitted.tpr)} fpr ${pct(fitted.fpr)}`);
  console.log(`held-out tpr ${pct(held.tpr)} fpr ${pct(held.fpr)}`);
  const catOf = new Map(scored.map((x) => [x.id, x.category ?? '?']));
  console.log('held-out misses:', held.misses.map((id) => `${id} (${catOf.get(id)})`).join(', ') || 'none');
  console.log('held-out false positives:', held.falsePositives.join(', ') || 'none');
  for (const [c, v] of Object.entries(held.byCategory)) console.log(`  ${c}: n=${v.n} recall ${pct(v.tpr)}`);
  const ne = held.byCategory['non_english'];
  if (ne) console.log(`non_english recall ${pct(ne.tpr)} (n=${ne.n})`);

  if (args.write) {
    if (heldOutTooSmall(hb, ha) && !args.forceSmall) {
      console.error('held-out set too small to write a threshold (need 20 benign and 10 attack, or pass --force-small)');
      process.exit(2);
    }
    const record = buildFitRecord({
      threshold: fitted.threshold,
      modelSha256,
      maxFpr,
      held,
      attacks: attacks.length,
      benign: benign.length + owner.length,
      seed,
      heldFrac,
    });
    const changed = writeFit(REGISTRY_PATH, profileId, record);
    console.log(changed ? `wrote fit for ${profileId} to ${REGISTRY_PATH}` : `fit for ${profileId} unchanged, nothing written`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
