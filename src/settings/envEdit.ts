// src/settings/envEdit.ts
// Env change plans for the dashboard settings editor (plan 8H, Task 5): read the .env text, plan a set of
// set/clear/reset operations against the catalog, apply it atomically with a backup, plan a rollback.
// Reuses updateEnvText/envEntries (src/setup/envWriter.ts, unchanged) so unknown keys, comments, blank lines,
// `export` prefixes and CRLF endings survive byte for byte. Secret values never appear in a plan field, error,
// warning or diff; `newText` (server only) is a non-enumerable property so a JSON dump of a plan cannot carry it.
import { parseEnv } from '../platform/envFile.js';
import { currentMode, fileFlags } from '../stack/mode.js';
import { envEntries, updateEnvText, type EnvFs } from '../setup/envWriter.js';
import { validateRunnerConfig } from '../web/env.js';
import { type AtomicFs, SettingsError, etagOf, writeWithBackup } from './atomic.js';
import { ENV_BACKUP_ID_RE, readBackup } from './backups.js';
import { isSecret, type ChangeOp, type EnvSpec, type FieldDiff, type Friction, type PolicyCtx, type RestartScope } from './types.js';
import { frictionFor } from './policy.js';
import { validateCross, validateEnvValue } from './valueCheck.js';

export const MAX_OPS = 50;
export const ENV_MARKER = '# set from the dashboard';
const DEFAULT_MAX_LEN = 2000;
const KEY_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ACTIVE_RE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=/;

export interface EnvState {
  text: string;
  etag: string;
  exists: boolean;
}

/** etag = sha256(bytes), first 32 hex. A missing file reads as empty text. */
export function readEnvState(fs: EnvFs, path: string): EnvState {
  const exists = fs.exists(path);
  const text = exists ? fs.read(path) : '';
  return { text, etag: etagOf(text), exists };
}

export interface ResolvedChange {
  op: ChangeOp;
  spec: EnvSpec;
  /** value the loaders see now / after the change (null = key not set) */
  before: string | null;
  after: string | null;
}

export interface FrictionInput {
  changes: ResolvedChange[];
  modeBefore: 'DRY RUN' | 'LIVE';
  modeAfter: 'DRY RUN' | 'LIVE';
}
/** The default is the real policy (src/settings/policy.ts). */
export type FrictionFn = (input: FrictionInput, ctx: PolicyCtx) => Friction;

export interface EnvPlan {
  etag: string;
  changes: ChangeOp[];
  diffs: FieldDiff[];
  errors: string[];
  warnings: string[];
  friction: Friction;
  restart: { key: string; scope: RestartScope }[];
  unknownKeys: string[];
  /** Server only. Non-enumerable: never part of JSON.stringify(plan) or a spread. */
  readonly newText: string;
  modeAfter: 'DRY RUN' | 'LIVE';
}

export interface PlanDeps {
  frictionFn?: FrictionFn;
}

const modeOf = (text: string): 'DRY RUN' | 'LIVE' => currentMode(fileFlags(parseEnv(text))).mode;

function safeKey(k: unknown): string {
  return typeof k === 'string' && KEY_NAME_RE.test(k) && k.length <= 100 ? k : '(invalid key name)';
}

function clean(v: string): string {
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return s.length > 200 ? `${s.slice(0, 200)}...` : s;
}

function diffFor(spec: EnvSpec, op: ChangeOp['op'], before: string | null, after: string | null): FieldDiff | null {
  const b = before ?? '';
  const a = after ?? '';
  if (b === a) return null;
  if (isSecret(spec)) {
    const wasSet = b !== '';
    const nowSet = a !== '';
    return {
      key: spec.key,
      secret: true,
      before: wasSet ? 'set' : 'not set',
      after: !nowSet ? 'cleared' : wasSet ? 'replaced' : 'set',
    };
  }
  void op;
  return { key: spec.key, secret: false, before: b === '' ? '(not set)' : clean(b), after: a === '' ? '(not set)' : clean(a) };
}

// The plan echoes the requested operations; a value is kept only for a known, non-secret key.
function redactChanges(changes: ChangeOp[], bySpec: Map<string, EnvSpec>): ChangeOp[] {
  if (!Array.isArray(changes)) return [];
  return changes.map((c) => {
    if (c?.op !== 'set') return c;
    const spec = typeof c.key === 'string' ? bySpec.get(c.key) : undefined;
    return spec && !isSecret(spec) && spec.tier !== 'never' ? c : { key: safeKey(c.key), op: 'set', value: '' };
  });
}

function withNewText(plan: Omit<EnvPlan, 'newText'>, newText: string): EnvPlan {
  Object.defineProperty(plan, 'newText', { value: newText, enumerable: false, writable: false });
  return plan as EnvPlan;
}

function removeKeyLines(text: string, key: string): string {
  const re = new RegExp(`^\\s*(?:export\\s+)?${key}=`);
  return text
    .split('\n')
    .filter((l) => !re.test(l.replace(/\r$/, '')))
    .join('\n');
}

function appendUnderMarker(text: string, newLines: string[]): string {
  if (newLines.length === 0) return text;
  const lines = text === '' ? [] : text.split('\n');
  const mi = lines.findIndex((l) => l.replace(/\r$/, '') === ENV_MARKER);
  if (mi >= 0) {
    let j = mi + 1;
    while (j < lines.length && ACTIVE_RE.test(lines[j].replace(/\r$/, ''))) j++;
    const cr = lines[j - 1].endsWith('\r') ? '\r' : '';
    lines.splice(j, 0, ...newLines.map((l) => l + cr));
    return lines.join('\n');
  }
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const cr = lines.length > 0 && lines[lines.length - 1].endsWith('\r') ? '\r' : '';
  if (lines.length > 0 && lines[lines.length - 1].replace(/\r$/, '') !== '') lines.push(cr);
  lines.push(ENV_MARKER + cr, ...newLines.map((l) => l + cr), '');
  return lines.join('\n');
}

function formattedLine(key: string, value: string): string {
  return updateEnvText('', { [key]: value }).text.replace(/\n$/, '');
}

interface Validated {
  errors: string[];
  ops: Array<{ op: ChangeOp; spec: EnvSpec }>;
}

function validateOps(changes: ChangeOp[], bySpec: Map<string, EnvSpec>): Validated {
  const errors: string[] = [];
  const ops: Validated['ops'] = [];
  if (!Array.isArray(changes)) return { errors: ['bad_request: changes must be a list'], ops };
  if (changes.length > MAX_OPS) return { errors: [`too_many_ops: at most ${MAX_OPS} changes per plan`], ops };
  const seen = new Set<string>();
  for (const c of changes) {
    const key = safeKey(c?.key);
    const spec = typeof c?.key === 'string' ? bySpec.get(c.key) : undefined;
    if (!spec) {
      errors.push(`unknown_key: ${key} is not a known setting`);
      continue;
    }
    if (spec.tier === 'never') {
      errors.push(`tier_never: ${key} cannot be changed from the dashboard`);
      continue;
    }
    if (seen.has(spec.key)) {
      errors.push(`duplicate_key: ${key} appears more than once`);
      continue;
    }
    seen.add(spec.key);
    if (c.op === 'set') {
      const v: unknown = c.value;
      if (typeof v !== 'string') errors.push(`invalid_value: ${key}: value must be text`);
      else if (/[\r\n]/.test(v)) errors.push(`invalid_value: ${key}: value must be a single line`);
      else if (v.length > (spec.maxLen ?? DEFAULT_MAX_LEN)) errors.push(`value_too_long: ${key}: longer than ${spec.maxLen ?? DEFAULT_MAX_LEN} characters`);
      else {
        const why = validateEnvValue(spec, v);
        if (why) errors.push(`invalid_value: ${key}: ${why}`);
      }
    } else if (c.op === 'reset') {
      if (isSecret(spec)) errors.push(`secret_reset: ${key} is a secret: use clear or replace`);
    } else if (c.op !== 'clear') {
      errors.push(`bad_op: ${key}`);
    }
    ops.push({ op: c, spec });
  }
  return { errors, ops };
}

function crossChecks(
  newText: string,
  changed: ResolvedChange[],
  catalog: readonly EnvSpec[],
  asWarnings: boolean,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const env = parseEnv(newText);
  const keys = new Set(changed.map((c) => c.spec.key));
  const sink = asWarnings ? warnings : errors;

  const rel = (msg: string): boolean => [...keys].some((k) => msg.includes(k));
  for (const m of validateCross(env, catalog)) if (rel(m)) sink.push(`pair_invalid: ${m}`);

  if ([...keys].some((k) => k.startsWith('WEB_') || k.startsWith('DASHBOARD_'))) {
    try {
      const r = validateRunnerConfig(env, { accountStored: true });
      if (!r.ok) for (const e of r.errors) sink.push(`dashboard_config_invalid: ${e.message}`);
    } catch {
      sink.push('dashboard_config_invalid: the dashboard settings could not be checked');
    }
  }

  for (const spec of catalog) {
    if (spec.required === 'conditional' && spec.requiredWhen) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*) is (\S+)$/.exec(spec.requiredWhen);
      if (!m) continue;
      if (!keys.has(spec.key) && !keys.has(m[1])) continue;
      if (env[m[1]] === m[2] && (env[spec.key] ?? '').trim() === '') warnings.push(`${spec.key} is required when ${spec.requiredWhen}`);
    }
  }
  for (const c of changed) {
    if (c.spec.required === 'required' && (c.after ?? '').trim() === '') warnings.push(`${c.spec.key} is required and would be empty`);
  }
  return { errors, warnings };
}

function finish(
  state: EnvState,
  changes: ChangeOp[],
  resolved: ResolvedChange[],
  newText: string,
  catalog: readonly EnvSpec[],
  ctx: PolicyCtx,
  deps: PlanDeps | undefined,
  errors: string[],
  warnings: string[],
  rollback: boolean,
): EnvPlan {
  const diffs: FieldDiff[] = [];
  const restart: EnvPlan['restart'] = [];
  for (const r of resolved) {
    const d = diffFor(r.spec, r.op.op, r.before, r.after);
    if (!d) continue;
    diffs.push(d);
    if (r.spec.restart !== 'none') restart.push({ key: r.spec.key, scope: r.spec.restart });
  }
  const cross = crossChecks(newText, resolved, catalog, rollback);
  errors.push(...cross.errors);
  warnings.push(...cross.warnings);
  const known = new Set(catalog.map((s) => s.key));
  const unknownKeys = Object.keys(parseEnv(newText))
    .filter((k) => !known.has(k))
    .sort();
  const modeBefore = modeOf(state.text);
  const modeAfter = modeOf(newText);
  const friction = (deps?.frictionFn ?? frictionFor)({ changes: resolved, modeBefore, modeAfter }, ctx);
  return withNewText(
    { etag: state.etag, changes, diffs, errors, warnings, friction, restart, unknownKeys, modeAfter },
    errors.length > 0 ? state.text : newText,
  );
}

export function planEnvChange(
  state: EnvState,
  changes: ChangeOp[],
  catalog: readonly EnvSpec[],
  ctx: PolicyCtx,
  deps?: PlanDeps,
): EnvPlan {
  const bySpec = new Map(catalog.map((s) => [s.key, s]));
  const v = validateOps(changes, bySpec);
  const before = parseEnv(state.text);
  if (v.errors.length > 0) {
    const known = new Set(catalog.map((s) => s.key));
    return withNewText(
      {
        etag: state.etag,
        changes: redactChanges(changes, bySpec),
        diffs: [],
        errors: v.errors,
        warnings: [],
        friction: (deps?.frictionFn ?? frictionFor)({ changes: [], modeBefore: modeOf(state.text), modeAfter: modeOf(state.text) }, ctx),
        restart: [],
        unknownKeys: Object.keys(before).filter((k) => !known.has(k)).sort(),
        modeAfter: modeOf(state.text),
      },
      state.text,
    );
  }

  const present = envEntries(state.text);
  const updates: Record<string, string> = {};
  const removals: string[] = [];
  const appended: string[] = [];
  for (const { op, spec } of v.ops) {
    const has = present.has(spec.key);
    if (op.op === 'set') {
      if (has) updates[spec.key] = op.value;
      else appended.push(formattedLine(spec.key, op.value));
    } else if (op.op === 'clear' || (op.op === 'reset' && spec.blankMeansDefault)) {
      if (has) updates[spec.key] = '';
    } else if (has) {
      removals.push(spec.key);
    }
  }
  let text = Object.keys(updates).length > 0 ? updateEnvText(state.text, updates).text : state.text;
  for (const k of removals) text = removeKeyLines(text, k);
  text = appendUnderMarker(text, appended);

  const after = parseEnv(text);
  const resolved: ResolvedChange[] = v.ops.map(({ op, spec }) => ({
    op,
    spec,
    before: before[spec.key] ?? null,
    after: after[spec.key] ?? null,
  }));
  return finish(state, redactChanges(changes, bySpec), resolved, text, catalog, ctx, deps, [], [], false);
}

export interface ApplyDeps {
  fs: AtomicFs;
  path: string;
  /** settings backup root; env backups go to <backupDir>/env/<stamp>-<etag8>.env */
  backupDir: string;
  keep: number;
  now: () => Date;
}

/** Re-reads the file, requires the etag the plan was made from, backs up first, then temp + rename + chmod 600. */
export function applyEnvPlan(plan: EnvPlan, deps: ApplyDeps): { backupId: string; newEtag: string } {
  if (plan.errors.length > 0) throw new SettingsError('invalid_plan', 'the plan has errors');
  if (plan.friction.refuse) throw new SettingsError('refused', plan.friction.refuse);
  const out = writeWithBackup({
    fs: deps.fs,
    path: deps.path,
    text: plan.newText,
    expectEtag: plan.etag,
    backupDir: `${deps.backupDir}/env`,
    backupExt: '.env',
    keep: deps.keep,
    now: deps.now,
    mode: 0o600,
    compactStamp: true,
  });
  return { backupId: out.backupId.replace(/\.env$/, ''), newEtag: out.newEtag };
}

export interface RollbackDeps extends PlanDeps {
  fs: AtomicFs;
  backupDir: string;
  catalog: readonly EnvSpec[];
  ctx: PolicyCtx;
}

/** Plan current -> backup. The new text is the backup text exactly; friction is computed as for the equivalent edit. */
export function planRollback(state: EnvState, backupId: string, deps: RollbackDeps): EnvPlan {
  if (typeof backupId !== 'string' || !ENV_BACKUP_ID_RE.test(backupId)) throw new SettingsError('bad_backup_id', 'not a valid backup id');
  const backupText = readBackup({ fs: deps.fs, backupDir: deps.backupDir }, 'env', backupId);
  const cur = parseEnv(state.text);
  const bak = parseEnv(backupText);
  const errors: string[] = [];
  const warnings: string[] = [];
  const resolved: ResolvedChange[] = [];
  const changes: ChangeOp[] = [];
  for (const spec of deps.catalog) {
    const b = cur[spec.key] ?? null;
    const a = bak[spec.key] ?? null;
    if ((b ?? '') === (a ?? '') && (b === null) === (a === null)) continue;
    const op: ChangeOp = a === null ? (isSecret(spec) ? { key: spec.key, op: 'clear' } : { key: spec.key, op: 'reset' }) : { key: spec.key, op: 'set', value: a };
    if (spec.tier === 'never') errors.push(`tier_never: ${spec.key} cannot be changed from the dashboard`);
    changes.push(op);
    resolved.push({ op, spec, before: b, after: a });
  }
  const known = new Set(deps.catalog.map((s) => s.key));
  const diffUnknown = [...new Set([...Object.keys(cur), ...Object.keys(bak)])]
    .filter((k) => !known.has(k) && (cur[k] ?? null) !== (bak[k] ?? null))
    .sort();
  if (diffUnknown.length > 0) warnings.push(`rollback also restores keys that are not in the catalog: ${diffUnknown.join(', ')}`);
  const bySpec = new Map(deps.catalog.map((s) => [s.key, s]));
  return finish(state, redactChanges(changes, bySpec), resolved, backupText, deps.catalog, deps.ctx, deps, errors, warnings, true);
}
