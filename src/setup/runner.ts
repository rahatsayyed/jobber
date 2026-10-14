// src/setup/runner.ts
// Step runner: doctor-gated skipping, retry on failure, state saved after every step.
import path from 'node:path';
import type { Check, CheckOutcome, DoctorContext } from '../platform/doctor.js';
import { formatReport, runChecks } from '../platform/doctor.js';
import type { Run } from '../platform/tmux.js';
import type { EnvFs } from './envWriter.js';
import type { SetupIO } from './io.js';
import type { SetupState } from './state.js';
import { saveState } from './state.js';

export interface SetupFs extends EnvFs {
  mkdirp(p: string, mode: number): void;
  copy(from: string, to: string, mode: number): void;
  list(p: string): string[];
}

export interface SetupContext {
  io: SetupIO & { registerSecret(v: string): void };
  root: string;
  env: NodeJS.ProcessEnv;
  fs: SetupFs;
  run: Run;
  spawnInteractive(
    cmd: string,
    args: string[],
    opts?: { env?: Record<string, string> },
  ): Promise<number>;
  fetch: NonNullable<DoctorContext['fetch']>;
  now: () => Date;
  doctor: DoctorContext;
  state: SetupState;
  statePath: string;
  envPath: string;
}

export interface SetupStep {
  id: string;
  title: string;
  checkIds: string[];
  run(ctx: SetupContext): Promise<'done' | 'skipped'>;
}

export interface RunOptions {
  only?: string;
  redo?: boolean;
  checks: Check[];
}

function record(ctx: SetupContext, id: string, status: 'done' | 'skipped'): void {
  ctx.state.steps[id] = { status, at: ctx.now().toISOString() };
  ctx.fs.mkdirp(path.dirname(ctx.statePath), 0o700);
  saveState(ctx.statePath, ctx.state, ctx.fs, ctx.now);
}

export async function runSetup(
  steps: SetupStep[],
  ctx: SetupContext,
  opts: RunOptions,
): Promise<number> {
  const { io } = ctx;
  if (opts.only !== undefined && !steps.some((s) => s.id === opts.only)) {
    io.say(`unknown step "${opts.only}". Known steps: ${steps.map((s) => s.id).join(', ')}`);
    return 2;
  }
  const checksFor = (s: SetupStep): Check[] =>
    opts.checks.filter((c) => s.checkIds.includes(c.id));
  const total = steps.length;
  let done = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < total; i++) {
    const step = steps[i];
    if (opts.only !== undefined && step.id !== opts.only) continue;
    io.say(`Step ${i + 1} of ${total}: ${step.title}`);
    const checks = checksFor(step);

    if (!opts.redo) {
      if (checks.length > 0) {
        const pre = await runChecks(checks, ctx.doctor);
        if (!pre.some((r) => r.result.status === 'fail' || r.result.status === 'warn')) {
          io.say('already done');
          record(ctx, step.id, 'done');
          done++;
          continue;
        }
      } else if (ctx.state.steps[step.id]?.status === 'done') {
        io.say('already done');
        done++;
        continue;
      }
    }

    let outcome: 'done' | 'skipped' | 'failed' = 'failed';
    for (;;) {
      let result: 'done' | 'skipped';
      try {
        result = await step.run(ctx);
      } catch (e) {
        // io.say redacts registered secrets from this message.
        io.say(`step failed: ${(e as Error).message}`);
        if (await io.confirm('Retry this step?', true)) continue;
        break;
      }
      if (result === 'skipped') {
        outcome = 'skipped';
        break;
      }
      let post: CheckOutcome[] = [];
      if (checks.length > 0) {
        post = await runChecks(checks, ctx.doctor);
        io.say(formatReport(post));
      }
      if (post.some((r) => r.result.status === 'fail')) {
        if (await io.confirm('Retry this step?', true)) continue;
        break;
      }
      outcome = 'done';
      break;
    }

    if (outcome === 'failed') {
      failed++;
    } else {
      record(ctx, step.id, outcome);
      if (outcome === 'done') done++;
      else skipped++;
    }
  }

  io.say(`${done} done, ${skipped} skipped, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}
