// scripts/hook-probe-check.ts
import { existsSync, readFileSync } from 'node:fs';
import { evaluateProbeLog } from '../src/platform/hookProbe.js';

const path = 'debug/hook-probe.jsonl';
if (!existsSync(path)) {
  console.log('FAIL no probe log at debug/hook-probe.jsonl (no hook fired at all)');
  process.exit(1);
}
const r = evaluateProbeLog(readFileSync(path, 'utf8').split('\n').filter(Boolean));
console.log(r.ok ? 'PASS hooks fire and deny inside the subagent' : 'FAIL ' + r.findings.join('; '));
process.exit(r.ok ? 0 : 1);
