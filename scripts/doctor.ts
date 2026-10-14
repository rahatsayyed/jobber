// scripts/doctor.ts
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ccgramChecks, restrictedChecks } from '../src/platform/checks.js';
import { exitCode, formatReport, runChecks, type DoctorContext } from '../src/platform/doctor.js';
import { linkedinBrowserChecks } from '../src/linkedin/chromeCheck.js';
import { defaultRun } from '../src/platform/tmux.js';

const ctx: DoctorContext = {
  root: resolve(import.meta.dirname, '..'),
  env: process.env,
  run: defaultRun,
  fs: {
    exists: (p) => existsSync(p),
    read: (p) => readFileSync(p, 'utf8'),
    list: (p) => (existsSync(p) ? readdirSync(p) : []),
    mode: (p) => (existsSync(p) ? statSync(p).mode & 0o777 : null),
  },
};

const results = await runChecks([...ccgramChecks, ...restrictedChecks(), ...linkedinBrowserChecks()], ctx);
console.log(formatReport(results));
process.exit(exitCode(results));
