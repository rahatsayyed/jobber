// src/scheduler/launch.ts
// Starts a wake run in a detached tmux window via an sh wrapper around scripts/run-claude.ts.
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureSession, killWindow, newWindow, type Run } from '../platform/tmux.js';

export interface LaunchHandle {
  runId: string;
  session: string;
  window: string;
  logPath: string;
  exitPath: string;
  promptPath: string;
}
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
  /** Raw bytes at or after `offset`, and the new byte offset. */
  readFromOffset(path: string, offset: number): { data: Buffer; offset: number };
  mkdir(path: string): void;
  exists(path: string): boolean;
  readText(path: string): string;
}

export const defaultFsOps: FsOps = {
  writeFile: (path, data, mode) => writeFileSync(path, data, { mode }),
  mkdir: (path) => {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  },
  readFromOffset(path, offset) {
    if (!existsSync(path)) return { data: Buffer.alloc(0), offset };
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size <= offset) return { data: Buffer.alloc(0), offset };
      const buf = Buffer.alloc(size - offset);
      const n = readSync(fd, buf, 0, buf.length, offset);
      return { data: buf.subarray(0, n), offset: offset + n };
    } finally {
      closeSync(fd);
    }
  },
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, 'utf8'),
};

const RUN_ID_RE = /^[a-z0-9]{8,20}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const RESERVED_ENV = new Set([
  'PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'HOME',
]);

export const RUNNER_PROFILE = 'outreach_wake';

/** Length of the prefix of buf that does not end in an incomplete UTF-8 sequence. */
function completeUtf8Length(buf: Buffer): number {
  const n = buf.length;
  for (let back = 1; back <= Math.min(3, n); back++) {
    const b = buf[n - back];
    if ((b & 0xc0) === 0x80) continue; // continuation byte, keep looking for the lead
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? n - back : n;
  }
  return n;
}

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
    if (k.startsWith('JOBBER_') || k.startsWith('SCHEDULER_') || RESERVED_ENV.has(k)) {
      throw new Error(`reserved env key: ${k}`);
    }
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
    ...Object.entries(p.env ?? {}).map(([k, v]) => `${k}=${v}`),
    // Emitted last so nothing earlier can override them.
    `JOBBER_RUN_ID=${p.runId}`,
    `JOBBER_DRY_RUN=${p.dryRun ? '1' : '0'}`,
    'npx',
    'tsx',
    'scripts/run-claude.ts',
    RUNNER_PROFILE,
    ...(p.noClassifier ? ['--no-classifier'] : []),
  ];
}

export function tmuxLauncher(run: Run, fsOps: FsOps = defaultFsOps): Launcher {
  const offsets = new Map<string, number>(); // cache only; a fresh launcher starts at 0
  return {
    async start(plan) {
      if (!RUN_ID_RE.test(plan.runId)) throw new Error('invalid run id');
      const window = `wake-${plan.runId}`;
      const promptPath = join(plan.runDir, `${plan.runId}.prompt.txt`);
      const logPath = join(plan.runDir, `${plan.runId}.log`);
      const exitPath = join(plan.runDir, `${plan.runId}.exit`);
      const argv = buildRunnerArgv({
        runId: plan.runId,
        dryRun: plan.dryRun,
        promptPath,
        logPath,
        exitPath,
        env: plan.env,
        noClassifier: plan.noClassifier,
      });
      fsOps.mkdir(plan.runDir);
      fsOps.writeFile(promptPath, plan.prompt, 0o600);
      await ensureSession(run, plan.session, plan.projectRoot);
      await newWindow(run, plan.session, window, argv, plan.projectRoot);
      offsets.set(plan.runId, 0);
      return { runId: plan.runId, session: plan.session, window, logPath, exitPath, promptPath };
    },

    async poll(h) {
      // Check the exit file FIRST, then drain the log, so output written before
      // the exit file appeared is never lost.
      const exitSeen = fsOps.exists(h.exitPath);
      const prev = offsets.get(h.runId) ?? 0;
      const r = fsOps.readFromOffset(h.logPath, prev);
      // Hold back an incomplete trailing UTF-8 sequence unless the run has exited.
      const keep = exitSeen ? r.data.length : completeUtf8Length(r.data);
      offsets.set(h.runId, prev + keep);
      const newOutput = r.data.subarray(0, keep).toString('utf8');
      if (!exitSeen) return { exited: false, exitCode: null, newOutput };
      const raw = fsOps.readText(h.exitPath).trim();
      // Non-numeric exit file content: exited with exitCode -1 (unknown failure).
      const code = /^-?\d{1,4}$/.test(raw) ? Number(raw) : -1;
      return { exited: true, exitCode: code, newOutput };
    },

    async kill(h) {
      try {
        await killWindow(run, h.session, h.window);
      } catch {
        // best effort
      }
    },
  };
}
