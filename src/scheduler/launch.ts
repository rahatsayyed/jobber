// src/scheduler/launch.ts
// Starts a wake run in a detached tmux window via an sh wrapper around scripts/run-claude.ts.
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSession, killWindow, newWindow, type Run } from '../platform/tmux.js';

export interface LaunchHandle { runId: string; window: string; logPath: string; exitPath: string; promptPath: string }
export interface PollResult { exited: boolean; exitCode: number | null; newOutput: string }
export interface LaunchPlan {
  runId: string;
  dryRun: boolean;
  prompt: string;
  session: string;
  runDir: string;
  projectRoot: string;
  /** Pass --no-classifier (driver sets this only for dry runs). Default false. */
  noClassifier?: boolean;
  /** Small explicit env for the runner. Never put secrets here by default. */
  env?: Record<string, string>;
}
export interface Launcher {
  start(plan: LaunchPlan): Promise<LaunchHandle>;
  poll(h: LaunchHandle): Promise<PollResult>;
  kill(h: LaunchHandle): Promise<void>;
}

export interface FsOps {
  writeFile(path: string, data: string, mode: number): void;
  /** Bytes appended at or after `offset`; returns decoded text and the new byte offset. */
  readFromOffset(path: string, offset: number): { text: string; offset: number };
  exists(path: string): boolean;
  readText(path: string): string;
}

export const defaultFsOps: FsOps = {
  writeFile: (path, data, mode) => writeFileSync(path, data, { mode }),
  readFromOffset(path, offset) {
    if (!existsSync(path)) return { text: '', offset };
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return { text: '', offset };
      const buf = Buffer.alloc(size - offset);
      const n = readSync(fd, buf, 0, buf.length, offset);
      return { text: buf.subarray(0, n).toString('utf8'), offset: offset + n };
    } finally {
      closeSync(fd);
    }
  },
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, 'utf8'),
};

const RUN_ID_RE = /^[a-z0-9]{8,20}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

export const RUNNER_PROFILE = 'outreach_wake';

export function buildRunnerArgv(p: {
  runId: string;
  dryRun: boolean;
  promptPath: string;
  logPath: string;
  exitPath: string;
  env?: Record<string, string>;
  noClassifier?: boolean;
}): string[] {
  if (!RUN_ID_RE.test(p.runId)) throw new Error('invalid run id');
  for (const [k, v] of Object.entries(p.env ?? {})) {
    if (!ENV_KEY_RE.test(k)) throw new Error(`invalid env key: ${JSON.stringify(k)}`);
    if (typeof v !== 'string' || v.includes('\n') || v.includes('\r') || v.includes('\0')) {
      throw new Error(`invalid env value for ${k}`);
    }
  }
  return [
    '/bin/sh',
    '-c',
    'p=$1; l=$2; e=$3; shift 3; "$@" <"$p" >>"$l" 2>&1; echo $? >"$e"',
    'sh',
    p.promptPath,
    p.logPath,
    p.exitPath,
    'env',
    `JOBBER_RUN_ID=${p.runId}`,
    `JOBBER_DRY_RUN=${p.dryRun ? '1' : '0'}`,
    ...Object.entries(p.env ?? {}).map(([k, v]) => `${k}=${v}`),
    'npx',
    'tsx',
    'scripts/run-claude.ts',
    RUNNER_PROFILE,
    ...(p.noClassifier ? ['--no-classifier'] : []),
  ];
}

export function tmuxLauncher(run: Run, fsOps: FsOps = defaultFsOps): Launcher {
  const offsets = new Map<string, number>();
  const sessions = new Map<string, string>();
  return {
    async start(plan) {
      if (!RUN_ID_RE.test(plan.runId)) throw new Error('invalid run id');
      const window = `wake-${plan.runId}`;
      const promptPath = join(plan.runDir, `${plan.runId}.prompt.txt`);
      const logPath = join(plan.runDir, `${plan.runId}.log`);
      const exitPath = join(plan.runDir, `${plan.runId}.exit`);
      fsOps.writeFile(promptPath, plan.prompt, 0o600);
      const argv = buildRunnerArgv({
        runId: plan.runId,
        dryRun: plan.dryRun,
        promptPath,
        logPath,
        exitPath,
        env: plan.env,
        noClassifier: plan.noClassifier,
      });
      await ensureSession(run, plan.session, plan.projectRoot);
      await newWindow(run, plan.session, window, argv, plan.projectRoot);
      offsets.set(plan.runId, 0);
      // session is kept on the handle's window name only; kill needs it, so remember it.
      sessions.set(plan.runId, plan.session);
      return { runId: plan.runId, window, logPath, exitPath, promptPath };
    },

    async poll(h) {
      const prev = offsets.get(h.runId) ?? 0;
      const r = fsOps.readFromOffset(h.logPath, prev);
      offsets.set(h.runId, r.offset);
      if (!fsOps.exists(h.exitPath)) return { exited: false, exitCode: null, newOutput: r.text };
      const raw = fsOps.readText(h.exitPath).trim();
      // Non-numeric exit file content: exited with exitCode -1 (unknown failure).
      const code = /^-?\d{1,4}$/.test(raw) ? Number(raw) : -1;
      return { exited: true, exitCode: code, newOutput: r.text };
    },

    async kill(h) {
      const session = sessions.get(h.runId);
      if (!session) return;
      try {
        await killWindow(run, session, h.window);
      } catch {
        // best effort
      }
    },
  };
}
