// scripts/classifier/bench.ts
// Latency and memory benchmark for the injection classifier. Prints one JSON document to stdout.
// Never prints corpus text; the input is a fixed benign sentence repeated.
import os from 'node:os';
import { join } from 'node:path';
import { loadClassifier } from '../../src/safety/classifierModel.js';
import { loadRegistry, modelDir, resolveProfile } from '../../src/safety/classifierRegistry.js';
import { percentile } from '../../src/safety/classifier.js';

const SENTENCE = 'The quarterly planning meeting covers roadmap priorities and staffing for the team. ';
const SIZES = [32, 128, 512, 1500];
const WARMUP = 3;
const RUNS = 30;
const mb = (n: number): number => Math.round((n / 1024 / 1024) * 10) / 10;

async function main(): Promise<void> {
  const rssBefore = process.memoryUsage().rss;
  const t0 = performance.now();
  const profile = resolveProfile(loadRegistry(), process.env);
  const loaded = await loadClassifier({ profile, allowUnfitted: true });
  const loadMs = performance.now() - t0;
  const rssAfterLoad = process.memoryUsage().rss;

  const textFor = (size: number): string => {
    let text = '';
    while (loaded.tokenizer.encode(text).length < size) text += SENTENCE;
    return text;
  };

  for (let i = 0; i < WARMUP; i++) await loaded.classifier.classify(textFor(32));

  const latency: Record<string, { p50: number; p95: number }> = {};
  for (const size of SIZES) {
    const text = textFor(size);
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const s = performance.now();
      await loaded.classifier.classify(text);
      times.push(performance.now() - s);
    }
    latency[String(size)] = {
      p50: Math.round(percentile(times, 50) * 10) / 10,
      p95: Math.round(percentile(times, 95) * 10) / 10,
    };
  }
  const rssAfterRuns = process.memoryUsage().rss;

  const modelFile = profile.files.find((f) => f.role === 'model');
  const cpus = os.cpus();
  const doc = {
    when: new Date().toISOString(),
    host: {
      platform: process.platform,
      arch: process.arch,
      cpus: cpus.length,
      model: cpus[0]?.model ?? 'unknown',
      totalMemGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      node: process.version,
    },
    model: {
      profile: profile.id,
      file: modelFile ? join(modelDir(profile), modelFile.local) : null,
      sha256: modelFile?.sha256 ?? null,
    },
    load_ms: Math.round(loadMs),
    rss_mb: { before: mb(rssBefore), after_load: mb(rssAfterLoad), after_runs: mb(rssAfterRuns) },
    latency_ms: latency,
  };
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  process.stderr.write(`classifier bench failed: ${msg}\n`);
  process.exit(1);
});
