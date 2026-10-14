import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FieldMap } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const DEFAULT_LEARNED_PLATFORMS_PATH = path.join(projectRoot, 'config', 'learned-ats-platforms.json');

/**
 * Reads the learned-ATS-platform registry fresh from disk on every call — same reload
 * semantics as user-data/easy-apply-answers.json, so a newly learned platform is usable on the
 * very next call with no MCP/session reconnect. Returns {} if the file doesn't exist yet
 * (first run, before anything has ever been learned).
 */
export function loadLearnedPlatforms(
  configPath: string = DEFAULT_LEARNED_PLATFORMS_PATH
): Record<string, FieldMap> {
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

/** Merges `fieldMap` into the registry under `domain` and writes the whole registry back. */
export function saveLearnedPlatform(
  domain: string,
  fieldMap: FieldMap,
  configPath: string = DEFAULT_LEARNED_PLATFORMS_PATH
): void {
  const registry = loadLearnedPlatforms(configPath);
  registry[domain] = fieldMap;
  writeFileSync(configPath, JSON.stringify(registry, null, 2) + '\n');
}

export interface LearnedDetection {
  platform: string;
  fieldMap: FieldMap;
}

/**
 * Hostname lookup against the learned registry, mirroring each static ATS module's own
 * `detect(url)` shape. Returns null on no match or an unparseable URL.
 */
export function detectLearned(
  url: string,
  configPath: string = DEFAULT_LEARNED_PLATFORMS_PATH
): LearnedDetection | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return null;
  }
  const registry = loadLearnedPlatforms(configPath);
  const fieldMap = registry[hostname];
  return fieldMap ? { platform: hostname, fieldMap } : null;
}
