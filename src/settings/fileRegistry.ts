// src/settings/fileRegistry.ts
// Explicit allowlist of the config and user-data files the dashboard may show or edit (plan 8H, D14).
// The client sends an id, never a path; `rel` values are constants. Each editable entry carries a validator built on the
// real loader where one exists (path-taking loaders run on a 0600 temp copy), its edit tier, and its restart scope.
// Validation errors carry a JSON path and a reason, never the file content.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLanguageConfigStatus } from '../languageGate.js';
import { validateProfile } from '../setup/profile.js';
import { loadPortals } from '../sources/boards/filters.js';
import { loadTargetRegionsStatus } from '../targetRegions.js';
import { validateAnswers } from './schemas/answers.js';
import { validateDealBreakers } from './schemas/dealBreakers.js';
import { validateDiscovery } from './schemas/discovery.js';
import { validateFactGate } from './schemas/factGate.js';
import { validateReplies } from './schemas/replies.js';
import type { SchemaResult } from './schemas/util.js';
import type { EditTier, RestartScope } from './types.js';

export interface ValidateCtx {
  /** Text of another registered file (for cross-file warnings); null when it cannot be read. */
  readText(id: string): string | null;
}
export interface ValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface FileEntry {
  id: string;
  rel: string;
  area: 'config' | 'user-data';
  edit: boolean;
  maxBytes: number;
  validate(text: string, ctx: ValidateCtx): ValidateResult;
  /** Reason the change widens what the agent may do, or null. Receives parsed JSON (null when unreadable). */
  weakens?(before: unknown, after: unknown): string | null;
  tier: EditTier;
  /** Tier when weakens() returns a reason */
  weakTier?: EditTier;
  restart: RestartScope;
  viewReason?: string;
}

const DEFAULT_MAX = 262144;
const VIEW_MAX = 1048576;

export const ID_RE = /^[a-z0-9-]{1,40}$/;

// ---------------------------------------------------------------- text checks

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Size, BOM, NUL and invalid UTF-8 (a replacement character or a lone surrogate means the bytes were not valid). */
export function textProblem(text: unknown, maxBytes: number): string | null {
  if (typeof text !== 'string') return 'text must be a string';
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return `file is larger than ${maxBytes} bytes`;
  if (text.charCodeAt(0) === 0xfeff) return 'file starts with a byte order mark; remove it';
  if (text.includes('\u0000')) return 'file contains a NUL character';
  if (text.includes('�') || LONE_SURROGATE.test(text)) return 'file is not valid UTF-8';
  return null;
}

/** Parse JSON; on failure the message names line and column when the engine reports a position, never the text. */
export function parseJsonText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (e) {
    const msg = String((e as Error).message ?? '');
    const lc = /line (\d+) column (\d+)/.exec(msg);
    if (lc) return { ok: false, error: `invalid JSON at line ${lc[1]} column ${lc[2]}` };
    const pos = /position (\d+)/.exec(msg);
    if (pos) {
      const upto = text.slice(0, Number(pos[1]));
      const line = upto.split('\n').length;
      const col = upto.length - upto.lastIndexOf('\n');
      return { ok: false, error: `invalid JSON at line ${line} column ${col}` };
    }
    return { ok: false, error: 'invalid JSON' };
  }
}

// ---------------------------------------------------------------- helpers

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function viaTempFile<T>(basename: string, text: string, fn: (file: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'jobber-settings-'));
  const file = join(dir, basename);
  const origErr = console.error;
  try {
    writeFileSync(file, text, { mode: 0o600 });
    console.error = () => {}; // some loaders log the offending entry; the editor reports paths only
    return fn(file);
  } finally {
    console.error = origErr;
    rmSync(dir, { recursive: true, force: true });
  }
}

function make(
  base: Omit<FileEntry, 'validate' | 'maxBytes' | 'edit'> & { maxBytes?: number; edit?: boolean },
  specific: (value: unknown, text: string, ctx: ValidateCtx) => SchemaResult,
): FileEntry {
  const maxBytes = base.maxBytes ?? DEFAULT_MAX;
  return {
    ...base,
    edit: base.edit ?? true,
    maxBytes,
    validate(text, ctx) {
      const bad = textProblem(text, maxBytes);
      if (bad) return { ok: false, errors: [bad], warnings: [] };
      const parsed = parseJsonText(text);
      if (!parsed.ok) return { ok: false, errors: [parsed.error], warnings: [] };
      let r: SchemaResult;
      try {
        r = specific(parsed.value, text, ctx);
      } catch {
        r = { errors: ['could not validate this file'], warnings: [] };
      }
      return { ok: r.errors.length === 0, errors: r.errors, warnings: r.warnings };
    },
  };
}

function remoteAnywhereWarning(ownFlag: boolean, ownName: string, ctx: ValidateCtx, otherId: string, pick: (o: Record<string, unknown>) => unknown, otherName: string): string[] {
  const t = ctx.readText(otherId);
  if (t === null) return [];
  const p = parseJsonText(t);
  if (!p.ok || !isObj(p.value)) return [];
  const other = pick(p.value) === true;
  return other === ownFlag ? [] : [`${ownName} is ${ownFlag} but ${otherName} is ${other}; keep the two in step (CLAUDE.md, Target regions)`];
}

// ---------------------------------------------------------------- validators

// Loader messages echo file values (unknown ats, slug); bound each quoted value.
const boundQuoted = (m: string): string => m.replace(/"([^"]{40})[^"]*"/g, '"$1..."');

function portals(value: unknown, text: string, ctx: ValidateCtx): SchemaResult {
  const r = viaTempFile('portals.json', text, (f) => loadPortals(f));
  const errors: string[] = [];
  const warnings: string[] = [];
  if (r.error) errors.push(boundQuoted(r.error.replace(/^config\/portals\.json: /, '')));
  for (const w of r.warnings ?? []) errors.push(boundQuoted(w.replace(/^config\/portals\.json: /, '')));
  if (isObj(value) && Array.isArray(value.tracked_companies)) {
    value.tracked_companies.forEach((c, i) => {
      if (isObj(c) && c.enabled !== undefined && typeof c.enabled !== 'boolean') warnings.push(`tracked_companies[${i}].enabled: must be exactly true or false, anything else leaves the company off`);
    });
  }
  if (isObj(value) && errors.length === 0) {
    const own = isObj(value.location_filter) && value.location_filter.remote_anywhere === true;
    warnings.push(...remoteAnywhereWarning(own, 'portals location_filter.remote_anywhere', ctx, 'target-regions', (o) => o.remote_anywhere, 'target-regions remote_anywhere'));
  }
  return { errors, warnings };
}

function targetRegions(value: unknown, text: string, ctx: ValidateCtx): SchemaResult {
  const r = viaTempFile('target-regions.json', text, (f) => loadTargetRegionsStatus(f));
  const errors: string[] = [];
  if (r.config === null) errors.push(r.invalid ?? 'invalid');
  if (isObj(value) && value.remote_anywhere !== undefined && typeof value.remote_anywhere !== 'boolean') errors.push('remote_anywhere: must be true or false');
  const warnings: string[] = [];
  if (errors.length === 0 && isObj(value)) {
    warnings.push(...remoteAnywhereWarning(value.remote_anywhere === true, 'target-regions remote_anywhere', ctx, 'portals', (o) => (isObj(o.location_filter) ? o.location_filter.remote_anywhere : undefined), 'portals location_filter.remote_anywhere'));
  }
  return { errors, warnings };
}

function languages(value: unknown, text: string): SchemaResult {
  const r = viaTempFile('languages.json', text, (f) => loadLanguageConfigStatus(f));
  const errors: string[] = [];
  if (r.config === null) {
    errors.push(r.problem === 'invalid' ? 'declared: an entry needs a language name and a level (basic, professional, fluent or native)' : 'declared: must be a non-empty array of {language, level}');
  }
  if (isObj(value) && value.confirmed !== undefined && typeof value.confirmed !== 'boolean') errors.push('confirmed: must be true or false');
  return { errors, warnings: [] };
}

function profile(value: unknown): SchemaResult {
  return { errors: validateProfile(value).map((p) => `${p}: invalid`), warnings: [] };
}

function viewOnly(value: unknown): SchemaResult {
  return isObj(value) || Array.isArray(value) ? { errors: [], warnings: [] } : { errors: ['(root): must be an object or array'], warnings: [] };
}

// ---------------------------------------------------------------- weakening rules

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

const weakTargetRegions = (b: unknown, a: unknown): string | null =>
  !(isObj(b) && b.remote_anywhere === true) && isObj(a) && a.remote_anywhere === true ? 'turns on remote_anywhere: remote roles based in any country are no longer excluded by location' : null;

function weakDealBreakers(b: unknown, a: unknown): string | null {
  const norm = (v: unknown) => new Set(asStrings(isObj(v) ? v.keywords : []).map((k) => k.trim().toLowerCase()).filter(Boolean));
  const after = norm(a);
  const removed = [...norm(b)].filter((k) => !after.has(k)).length;
  return removed > 0 ? `removes ${removed} deal-breaker keyword${removed === 1 ? '' : 's'}` : null;
}

const weakReplies = (b: unknown, a: unknown): string | null =>
  !(isObj(b) && b.auto_record_enabled === true) && isObj(a) && a.auto_record_enabled === true ? 'turns on auto-recording of detected interviews and rejections' : null;

const weakLanguages = (b: unknown, a: unknown): string | null =>
  !(isObj(b) && b.confirmed === true) && isObj(a) && a.confirmed === true ? 'confirms the language list: undeclared required languages become exclusions instead of flags' : null;

function weakFactGate(b: unknown, a: unknown): string | null {
  for (const k of ['allow_facts', 'allow_metrics']) {
    const before = new Set(asStrings(isObj(b) ? b[k] : []));
    const added = asStrings(isObj(a) ? a[k] : []).filter((x) => !before.has(x)).length;
    if (added > 0) return `adds ${added} entr${added === 1 ? 'y' : 'ies'} to ${k}: the fact gate accepts more claims`;
  }
  return null;
}

// ---------------------------------------------------------------- the table

function view(id: string, rel: string, viewReason: string): FileEntry {
  return make({ id, rel, area: 'config', edit: false, maxBytes: VIEW_MAX, tier: 'never', restart: 'none', viewReason }, (v) => viewOnly(v));
}

const ENTRIES: FileEntry[] = [
  make({ id: 'portals', rel: 'config/portals.json', area: 'config', tier: 'normal', restart: 'next_run' }, portals),
  make({ id: 'target-regions', rel: 'config/target-regions.json', area: 'config', tier: 'normal', weakTier: 'guarded', weakens: weakTargetRegions, restart: 'next_run' }, targetRegions),
  make({ id: 'deal-breakers', rel: 'config/deal-breakers.json', area: 'config', tier: 'normal', weakTier: 'guarded', weakens: weakDealBreakers, restart: 'next_run' }, (v) => validateDealBreakers(v)),
  make({ id: 'replies', rel: 'config/replies.json', area: 'config', tier: 'normal', weakTier: 'safety', weakens: weakReplies, restart: 'next_run' }, (v) => validateReplies(v)),
  make({ id: 'linkedin-discovery', rel: 'config/linkedin-discovery.json', area: 'config', tier: 'normal', restart: 'next_run' }, (v) => validateDiscovery(v)),
  make({ id: 'languages', rel: 'user-data/languages.json', area: 'user-data', tier: 'normal', weakTier: 'guarded', weakens: weakLanguages, restart: 'next_run' }, languages),
  make({ id: 'easy-apply-answers', rel: 'user-data/easy-apply-answers.json', area: 'user-data', tier: 'normal', restart: 'none' }, (v) => validateAnswers(v)),
  make({ id: 'profile', rel: 'user-data/profile.json', area: 'user-data', tier: 'normal', restart: 'next_run' }, (v) => profile(v)),
  make({ id: 'fact-gate', rel: 'user-data/fact-gate.json', area: 'user-data', tier: 'normal', weakTier: 'safety', weakens: weakFactGate, restart: 'none' }, (v) => validateFactGate(v)),
  view('permission-sets', 'config/permission-sets.json', 'Change it with `npm run permissions -- read_only|outreach_send|full`.'),
  view('run-profiles', 'config/run-profiles.json', 'Defines what each restricted run may do; edit it in the repository by hand.'),
  view('worker-tools', 'config/worker-tools.json', 'Exact tool lists of the platform operators; edit it in the repository by hand.'),
  view('classifier-models', 'config/classifier-models.json', 'Manage with `npm run models -- list|verify|fetch|pin`.'),
  view('manager-windows', 'config/manager-windows.json', 'Named session windows; edit it in the repository by hand.'),
  view('platforms', 'config/platforms.json', 'Plan 8G platform catalog; edit it in the repository by hand.'),
  view('ai-tells', 'config/ai-tells.json', 'Style gate word lists; edit it in the repository by hand.'),
  view('ccgram-pin', 'config/ccgram.pin.json', 'Pinned bridge version (owner decision); never changed from the web.'),
  view('update-known-failures', 'config/update-known-failures.json', 'Mirrors the test baseline in CLAUDE.md; edit both together by hand.'),
];

const REGISTRY: ReadonlyMap<string, FileEntry> = new Map(ENTRIES.map((e) => [e.id, e]));

/** The only way from a client string to an entry: the id must look like an id AND be in the table. */
export function resolveEntry(id: unknown): FileEntry | null {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  return REGISTRY.get(id) ?? null;
}

export function allEntries(): FileEntry[] {
  return [...REGISTRY.values()];
}
