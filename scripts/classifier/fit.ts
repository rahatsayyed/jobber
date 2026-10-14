// scripts/classifier/fit.ts  (owner-run: needs the pinned model files on disk)
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadClassifier, loadPin, safeFile, sha256File, type PinEntry } from '../../src/safety/classifierModel.js';
import { evaluate, fitThreshold, splitCorpus, type Scored } from '../../src/safety/thresholdFit.js';

const PIN_PATH = 'config/classifier.pin.json';
const flag = (n: string): boolean => process.argv.includes(n);
const opt = (n: string, d: string): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const modelDir = process.env.CLASSIFIER_MODEL_DIR ?? 'models/prompt-guard-2-22m';

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

async function writePin(): Promise<void> {
  const pin = loadPin(PIN_PATH);
  const cfg = JSON.parse(readFileSync(join(modelDir, 'config.json'), 'utf8')) as { id2label?: Record<string, string> };
  const hits = Object.entries(cfg.id2label ?? {}).filter(([, v]) => String(v).toLowerCase() === 'malicious');
  if (hits.length !== 1) throw new Error(`config.json id2label: expected exactly one "malicious" label, found ${hits.length}`);
  const idx = Number(hits[0][0]);
  if (idx !== 0 && idx !== 1) throw new Error(`malicious index ${idx} is not 0 or 1`);
  const main = new Set([pin.model.file, pin.tokenizer.file, pin.config.file]);
  const entry = async (file: string): Promise<PinEntry> => ({ file, sha256: await sha256File(join(modelDir, file)) });
  const extra: PinEntry[] = [];
  for (const name of readdirSync(modelDir).sort()) {
    if (main.has(name) || !statSync(join(modelDir, name)).isFile()) continue;
    if (!safeFile(name)) {
      console.log(`skipped (unsafe file name): ${JSON.stringify(name)}`);
      continue;
    }
    extra.push(await entry(name));
  }
  const next = {
    source: pin.source,
    model: await entry(pin.model.file),
    tokenizer: await entry(pin.tokenizer.file),
    config: await entry(pin.config.file),
    extra,
    malicious_index: idx,
  };
  writeFileSync(PIN_PATH, JSON.stringify(next, null, 2) + '\n');
  console.log(`pinned ${3 + extra.length} files, malicious_index=${idx}`);
}

async function main(): Promise<void> {
  if (flag('--pin')) await writePin();
  const maxFpr = Number(opt('--max-fpr', '0.01'));
  const seed = opt('--seed', 'jobber-2026-10');
  const heldFrac = Number(opt('--held-out', '0.3'));
  const { classifier, outputName } = await loadClassifier({ configPath: '/dev/null/none' });
  void outputName;
  const attacks = readJsonl('config/injection-corpus/attacks.jsonl');
  const benign = readJsonl('config/injection-corpus/benign.jsonl');
  const ownerPath = 'user-data/injection-benign.jsonl';
  const owner = existsSync(ownerPath) ? readJsonl(ownerPath, 'benign', 'owner') : [];
  const items = [...attacks, ...benign, ...owner];
  const scored: Scored[] = [];
  for (const it of items) {
    const v = await classifier.classify(it.text);
    scored.push({ id: it.id, label: it.label, category: it.category, score: v.score });
  }
  const { fit, heldOut } = splitCorpus(scored, seed, heldFrac);
  const count = (xs: Scored[], l: Scored['label']): number => xs.filter((x) => x.label === l).length;
  const fitted = fitThreshold(fit, { maxBenignFpr: maxFpr });
  const held = evaluate(heldOut, fitted.threshold);
  const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
  const small = count(heldOut, 'benign') < 100 || count(heldOut, 'attack') < 50;
  console.log(`fit: ${count(fit, 'attack')} attack / ${count(fit, 'benign')} benign; held-out: ${count(heldOut, 'attack')} attack / ${count(heldOut, 'benign')} benign${small ? ' (small sample)' : ''}`);
  console.log(`threshold ${fitted.threshold.toFixed(6)}  fit tpr ${pct(fitted.tpr)} fpr ${pct(fitted.fpr)}`);
  console.log(`held-out tpr ${pct(held.tpr)} fpr ${pct(held.fpr)}`);
  const catOf = new Map(scored.map((x) => [x.id, x.category ?? '?']));
  console.log('held-out misses:', held.misses.map((id) => `${id} (${catOf.get(id)})`).join(', ') || 'none');
  console.log('held-out false positives:', held.falsePositives.join(', ') || 'none');
  for (const [c, v] of Object.entries(held.byCategory)) console.log(`  ${c}: n=${v.n} recall ${pct(v.tpr)}`);

  if (flag('--write')) {
    const pin = loadPin(PIN_PATH);
    const out = {
      threshold: fitted.threshold,
      windowTokens: 510,
      stride: 64,
      maxChunks: 16,
      maliciousIndex: pin.malicious_index,
      fitted_at: new Date().toISOString(),
      model_sha256: pin.model.sha256,
      corpus: { attacks: attacks.length, benign: benign.length + owner.length, seed, held_out_fraction: heldFrac },
      held_out: { tpr: held.tpr, fpr: held.fpr, n: held.n },
    };
    writeFileSync('config/classifier.json', JSON.stringify(out, null, 2) + '\n');
    console.log('wrote config/classifier.json');
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
