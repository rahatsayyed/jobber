// scripts/doctor.ts
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ccgramChecks } from '../src/platform/checks.js';
import { exitCode, formatReport, runChecks, type DoctorContext } from '../src/platform/doctor.js';
import { defaultRun } from '../src/platform/tmux.js';

const ctx: DoctorContext = {
  root: resolve(import.meta.dirname, '..'),
  env: process.env,
  run: defaultRun,
  fs: {
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, 'utf8'),
    mode: (p) => (existsSync(p) ? statSync(p).mode & 0o777 : null),
  },
};

const results = await runChecks(ccgramChecks, ctx);
console.log(formatReport(results));
process.exit(exitCode(results));
