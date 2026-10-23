// src/platform/checksApiKeys.ts
// Warn-only check for the optional API keys (plan 8F). Names variables, never values or lengths.
import { join } from 'node:path';
import type { Check, CheckResult, DoctorContext } from './doctor.js';
import { parseEnv } from './envFile.js';

const VARS = ['SERPER_API_KEY', 'HUNTER_API_KEY'];

export const apiKeysChecks: Check[] = [
  {
    id: 'api-keys',
    title: 'optional API keys',
    async run(ctx: DoctorContext): Promise<CheckResult> {
      let fileEnv: Record<string, string> = {};
      try {
        const p = join(ctx.root, '.env');
        if (ctx.fs.exists(p)) fileEnv = parseEnv(ctx.fs.read(p));
      } catch {
        fileEnv = {};
      }
      const env: Record<string, string | undefined> = { ...fileEnv, ...ctx.env };
      const unset = VARS.filter((v) => (env[v] ?? '').trim() === '');
      if (unset.length === 0) return { status: 'pass', detail: 'Serper and Hunter (contact finding) keys are set' };
      return { status: 'warn', detail: `not set: ${unset.join(', ')}`, fix: 'npm run setup -- --step apikeys' };
    },
  },
];
