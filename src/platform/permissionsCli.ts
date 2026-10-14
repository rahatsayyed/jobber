// src/platform/permissionsCli.ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applySetToFile,
  detectSet,
  resolveSet,
  SET_NAMES,
  type LocalSettings,
  type RawSets,
  type SetName,
} from './permissions.js';

export interface CliResult {
  code: number;
  lines: string[];
}

const USAGE = `usage: npm run permissions -- [${SET_NAMES.join('|')}|--status]`;

export function settingsPathFor(root: string): string {
  return join(root, '.claude', 'settings.local.json');
}

function status(path: string, sets: RawSets): string[] {
  let settings: LocalSettings = {};
  if (existsSync(path)) {
    try {
      settings = JSON.parse(readFileSync(path, 'utf8')) as LocalSettings;
    } catch {
      throw new Error(`${path} is not valid JSON`);
    }
  }
  const managed = new Set<string>();
  for (const n of Object.keys(sets)) for (const e of resolveSet(sets, n)) managed.add(e);
  const allow = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : [];
  const count = allow.filter((e) => typeof e === 'string' && managed.has(e)).length;
  return [`set: ${detectSet(settings, sets)}`, `managed entries: ${count}`];
}

export function runPermissionsCli(args: string[], root: string, sets: RawSets): CliResult {
  const path = settingsPathFor(root);
  const arg = args[0];
  if (args.length > 1) return { code: 1, lines: [USAGE] };
  try {
    if (arg === undefined || arg === '--status') return { code: 0, lines: status(path, sets) };
    if (!(SET_NAMES as string[]).includes(arg)) return { code: 1, lines: [USAGE] };
    applySetToFile(path, sets, arg as SetName);
    const lines = [`applied set: ${arg}`];
    if (arg === 'full') {
      lines.push(
        'WARN: full allows every Jobber send/apply tool for any session and any allowlisted Telegram user.',
      );
    }
    return { code: 0, lines };
  } catch (e) {
    return { code: 1, lines: [e instanceof Error ? e.message : String(e)] };
  }
}
