// src/bootstrap/types.ts
import type { Run } from '../platform/tmux.js';

export type Platform = 'darwin' | 'linux' | 'unsupported';
export type ItemId =
  | 'git'
  | 'build-tools'
  | 'node'
  | 'npm-deps'
  | 'renderer-deps'
  | 'playwright-chromium'
  | 'chrome'
  | 'tmux'
  | 'uv'
  | 'ccgram'
  | 'claude-cli'
  | 'age'
  | 'rclone'
  | 'classifier-model';

/** Shape of config/ccgram.pin.json that the bootstrap needs. */
export interface CcgramPin {
  version: string;
  installed?: boolean;
}

export interface Detection {
  present: boolean;
  version?: string;
  detail: string;
  /** Linux node only: major of the apt candidate, when known. */
  candidateMajor?: number;
}

export interface Action {
  id: string; // stable id, e.g. 'tmux:brew'
  summary: string; // one line for the owner
  argv: string[]; // never a shell string; executed without a shell
  cwd?: string;
  needsSudo: boolean;
  network: boolean;
  url?: string;
  downloadsScript?: boolean; // fetch to a temp file first, show url/size/sha256, ask again
}

export type Plan =
  | { kind: 'actions'; actions: Action[] }
  | { kind: 'owner'; message: string; url?: string } // printed, never run
  | { kind: 'none'; why: string };

export interface BootstrapDeps {
  platform: Platform;
  root: string;
  env: NodeJS.ProcessEnv;
  run: Run;
  fs: { exists(p: string): boolean; read(p: string): string; list(p: string): string[] };
  now: () => Date;
}

export interface Item {
  id: ItemId;
  title: string;
  required: boolean;
  optionalKind?: 'report_only' | 'consent';
  detect(d: BootstrapDeps): Promise<Detection>;
  plan(d: BootstrapDeps, det: Detection): Plan;
  /** Optional extra actions the owner may accept (never part of plan). */
  offer?(d: BootstrapDeps, det: Detection): Promise<Action[]>;
}
