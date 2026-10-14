// src/lib/userData.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const USER_FILES = [
  'resume.json',
  'easy-apply-answers.json',
  'fact-gate.json',
  'languages.json',
] as const;
export type UserFile = (typeof USER_FILES)[number];

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function userDataDir(env: NodeJS.ProcessEnv = process.env, root: string = projectRoot): string {
  const override = env.JOBAPPLIER_USER_DATA?.trim();
  if (override) return path.isAbsolute(override) ? override : path.resolve(root, override);
  return path.join(root, 'user-data');
}

export function userDataPath(file: UserFile, env: NodeJS.ProcessEnv = process.env, root: string = projectRoot): string {
  return path.join(userDataDir(env, root), file);
}

export function missingUserDataMessage(file: UserFile): string {
  return `user-data/${file} not found. Run \`npm run user-data -- init\` to copy the templates, then fill them in (the setup skill does this for you).`;
}

/** Where each file lived before the user-data folder existed (relative to the project root). */
export const LEGACY_PATHS: Record<UserFile, string[]> = {
  'resume.json': ['input/resume.json'],
  'easy-apply-answers.json': ['config/easy-apply-answers.json'],
  'fact-gate.json': ['config/fact-gate.json'],
  'languages.json': ['config/languages.json'],
};

export interface CopyOp {
  from: string;
  to: string;
}

export function planMigration(
  root: string,
  exists: (p: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): CopyOp[] {
  const ops: CopyOp[] = [];
  for (const file of USER_FILES) {
    const to = userDataPath(file, env, root);
    if (exists(to)) continue;
    const from = LEGACY_PATHS[file].map((rel) => path.join(root, rel)).find((p) => exists(p));
    if (from) ops.push({ from, to });
  }
  return ops;
}

export function planInit(root: string, exists: (p: string) => boolean, env: NodeJS.ProcessEnv = process.env): CopyOp[] {
  const ops: CopyOp[] = [];
  for (const file of USER_FILES) {
    const to = userDataPath(file, env, root);
    if (!exists(to)) ops.push({ from: path.join(root, 'user-data.example', file), to });
  }
  return ops;
}
