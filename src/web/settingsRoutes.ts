// src/web/settingsRoutes.ts
// Dashboard settings API (plan 8H, Task 7): read the env catalog and the allowlisted config files, preview and apply
// changes in two steps (one-time token bound to the session and to the exact plan), roll back from backups.
// Every write goes through the same check order (see runWrite). No secret value, file content or token is ever logged,
// audited or echoed: audit rows carry key names, a changed-path count and non-secret bool/int/enum before->after pairs.
// Registered by createWebServer only when WebDeps.settings is set; the chat route never receives these deps.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Ctx } from './router.js';
import { readJson } from './router.js';
import { type AuditKind, type AuthDb, audit, savePendingSettings, takePendingSettings } from '../dash/authStore.js';
import { isFresh } from '../dash/sessions.js';
import { parseEnv } from '../platform/envFile.js';
import { currentMode, fileFlags } from '../stack/mode.js';
import { type AtomicFs, SettingsError } from '../settings/atomic.js';
import { listBackups, readBackup, type BackupTarget } from '../settings/backups.js';
import { applyEnvPlan, planEnvChange, planRollback, readEnvState, type EnvPlan } from '../settings/envEdit.js';
import { resolveEntry, type FileEntry } from '../settings/fileRegistry.js';
import { createJsonStore, type FilePlan } from '../settings/jsonStore.js';
import { phraseMatches } from '../settings/policy.js';
import type { ChangeOp, EnvSpec, Friction, PolicyCtx, RestartScope, SectionId } from '../settings/types.js';

export interface PendingRestartSeam {
  mark(entries: { key: string; scope: RestartScope }[]): void;
  list(): { key: string; scope: RestartScope; command: string }[];
}

export interface SettingsDeps {
  root: string;
  envPath: string;
  /** settings backup root (contains env/ and files/) */
  backupDir: string;
  userDataDir: string;
  catalog: readonly EnvSpec[];
  fs: AtomicFs;
  editEnabled: boolean;
  remoteExposure: boolean;
  remoteSafetyAllowed: boolean;
  backupKeep: number;
  /** mode seen when the dashboard started */
  startMode: { mode: 'DRY RUN' | 'LIVE'; flags: Record<string, string> };
  /** literal secret values masked in responses; newly written secrets are pushed here */
  secrets: string[];
  now?: () => Date;
  /** process env of the dashboard, only used to report shellOverride (never values) */
  shellEnv?: NodeJS.ProcessEnv;
  pendingRestart?: PendingRestartSeam;
  /** run mode derived from the .env FILE (not the process env); shown in /api/session */
  currentMode?: () => { mode: 'DRY RUN' | 'LIVE'; flags: Record<string, string> };
}

export interface SettingsRouteEnv {
  auth: AuthDb;
  now: () => Date;
  authMode: string;
  reauthMaxAgeSec: number;
}

export interface SettingsRoute {
  method: 'GET' | 'POST';
  pattern: string;
  fn: (c: Ctx, params: string[]) => Promise<void> | void;
}

const TOKEN_TTL_SEC = 120;
const ENV_BODY_MAX = 64 * 1024;
const ROLLBACK_BODY_MAX = 4096;
const WRITES_PER_MIN = 10;
const FAILS_TO_LOCK = 5;
const FAIL_WINDOW_MS = 10 * 60_000;
const LOCK_MS = 5 * 60_000;
const AUDIT_GAP_MS = 60_000;
const NOTE_PAIR_TYPES = new Set(['bool', 'int', 'enum']);

export const RESTART_COMMANDS: Record<RestartScope, string> = {
  none: '',
  next_run: 'none needed: takes effect on the next run',
  dashboard: 'restart the dashboard (npm run web, or npm run down && npm run up)',
  scheduler: 'restart the scheduler (npm run down && npm run up)',
  mcp: 'fully quit and restart the Claude sessions',
  stack: 'npm run down && npm run up',
};

const SECTION_TITLES: Record<SectionId, string> = {
  'credentials-sources': 'Credentials: job sources',
  'credentials-gmail': 'Credentials: Gmail',
  safety: 'Safety',
  classifier: 'Classifier',
  limits: 'Limits',
  linkedin: 'LinkedIn',
  naukri: 'Naukri',
  scheduler: 'Scheduler',
  dashboard: 'Dashboard',
  telegram: 'Telegram',
  layout: 'Layout memory',
  'update-backup': 'Update and backup',
  advanced: 'Advanced',
  'web-core': 'Core',
  search: 'Search',
  apply: 'Apply',
};

const sha256Hex = (s: string): string => createHash('sha256').update(s).digest('hex');

function safeEq(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}

/** Stable JSON: object keys sorted, arrays kept in order. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** An early, already-decided response. */
class Refuse extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly body?: Record<string, unknown>) {
    super(code);
    this.name = 'Refuse';
  }
}

const SETTINGS_STATUS: Record<string, number> = {
  unknown_file: 404, bad_backup_id: 400, backup_not_found: 404, stale_etag: 409, plan_mismatch: 409,
  invalid_plan: 422, not_editable: 403, refused: 403, symlink_refused: 422, not_regular_file: 422, parent_missing: 422,
  backup_unreadable: 500, backup_failed: 500, write_failed: 500,
};

interface Planned {
  /** current etag of the target when planned */
  etag: string;
  /** what the token plan hash covers besides the token */
  payload: unknown;
  view: Record<string, unknown>;
  friction: Friction;
  kind: AuditKind;
  note: string;
  commit(): { backupId: string; newEtag: string };
  restart: { key: string; scope: RestartScope }[];
  afterApply?(): void;
}

export function createSettingsRoutes(deps: SettingsDeps, env: SettingsRouteEnv): SettingsRoute[] {
  const now = (): Date => (deps.now ?? env.now)();
  const { auth } = env;
  const { fs } = deps;
  const catalog = deps.catalog;
  const bySpec = new Map(catalog.map((s) => [s.key, s]));
  const store = createJsonStore({
    fs, root: deps.root, userDataDir: deps.userDataDir, backupDir: deps.backupDir, keep: deps.backupKeep, now,
  });
  const catalogVersion = sha256Hex(catalog.map((s) => `${s.key}:${s.type}`).join('|')).slice(0, 12);

  const writes = new Map<string, number[]>(); // session -> write times (ms)
  const fails = new Map<string, number[]>(); // session -> failed apply times (ms)
  const locks = new Map<string, number>(); // session -> locked until (ms)
  const rejectAudited = new Map<string, number>();

  // ---- output ----------------------------------------------------------------------------------------------

  function mask(text: string): string {
    let out = text;
    for (const lit of deps.secrets) {
      if (lit.length < 8) continue;
      out = out.split(lit).join('[redacted]');
      const esc = JSON.stringify(lit).slice(1, -1);
      if (esc !== lit) out = out.split(esc).join('[redacted]');
    }
    return out;
  }

  function reply(c: Ctx, status: number, body: unknown, extra: Record<string, string> = {}): void {
    c.res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    c.res.end(mask(JSON.stringify(body) ?? 'null'));
  }

  const reauth = (c: Ctx): void =>
    reply(c, 401, {
      error: 'reauth_required', url: env.authMode === 'token' ? '/#/login?reauth=1' : '/auth/login?reauth=1',
    });

  const hintOf = (c: Ctx): string => c.session!.idHash.slice(0, 12);
  const fresh = (c: Ctx): boolean => isFresh(c.session!, now(), env.reauthMaxAgeSec);

  function auditRow(kind: AuditKind, c: Ctx, note: string, textHash?: string): void {
    audit(auth, kind, { ip: c.ip, note, idHint: hintOf(c), ...(textHash ? { textHash } : {}) }, now());
  }

  function auditReject(c: Ctx, code: string): void {
    auditRow('settings_reject', c, code.slice(0, 60));
  }

  function auditRejectThrottled(c: Ctx, code: string): void {
    const id = c.session!.idHash;
    const t = now().getTime();
    if (t - (rejectAudited.get(id) ?? -Infinity) < AUDIT_GAP_MS) return;
    rejectAudited.set(id, t);
    if (rejectAudited.size > 64) for (const [k, ts] of rejectAudited) if (t - ts > AUDIT_GAP_MS) rejectAudited.delete(k);
    auditReject(c, code);
  }

  // ---- write guards ----------------------------------------------------------------------------------------

  function recordFail(c: Ctx): void {
    const id = c.session!.idHash;
    const t = now().getTime();
    const arr = (fails.get(id) ?? []).filter((x) => t - x < FAIL_WINDOW_MS);
    arr.push(t);
    if (arr.length >= FAILS_TO_LOCK) {
      locks.set(id, t + LOCK_MS);
      fails.set(id, []);
      auditReject(c, 'locked');
    } else {
      fails.set(id, arr);
    }
  }

  function guards(c: Ctx): void {
    // (2) same-origin fetch metadata
    const sfs = c.req.headers['sec-fetch-site'];
    if ((Array.isArray(sfs) ? sfs[0] : sfs) !== 'same-origin') throw new Refuse(403, 'forbidden');
    // (4) settings may be switched off for writes; reads stay available
    if (!deps.editEnabled) throw new Refuse(403, 'settings_disabled');
    // (5) per-session write budget and failed-apply lock
    const id = c.session!.idHash;
    const t = now().getTime();
    const until = locks.get(id) ?? 0;
    if (until > t) {
      throw new Refuse(429, 'locked', { retry: Math.ceil((until - t) / 1000) });
    }
    const arr = (writes.get(id) ?? []).filter((x) => t - x < 60_000);
    if (arr.length >= WRITES_PER_MIN) {
      writes.set(id, arr);
      throw new Refuse(429, 'rate_limited', { retry: 60 });
    }
    arr.push(t);
    writes.set(id, arr);
    if (writes.size > 64) for (const [k, v] of writes) if (!v.some((x) => t - x < 60_000)) writes.delete(k);
  }

  // ---- policy ctx ------------------------------------------------------------------------------------------

  const policyCtx = (c: Ctx): PolicyCtx => ({
    editEnabled: deps.editEnabled,
    remoteExposure: deps.remoteExposure,
    remoteSafetyAllowed: deps.remoteSafetyAllowed,
    sessionFresh: fresh(c),
  });

  function fileFriction(id: string, plan: FilePlan): Friction {
    if (plan.tier === 'never') return { refuse: 'tier_never', reauth: false, phrase: null };
    if (plan.tier === 'safety' && deps.remoteExposure && !deps.remoteSafetyAllowed) {
      return { refuse: 'remote_exposure', reauth: false, phrase: null };
    }
    if (plan.tier === 'safety') return { reauth: true, phrase: `CHANGE ${id}` };
    return { reauth: plan.tier === 'guarded', phrase: null };
  }

  // ---- planners ---------------------------------------------------------------------------------------------

  function envNote(plan: EnvPlan): string {
    const keys = plan.diffs.map((d) => d.key);
    const pairs: string[] = [];
    for (const d of plan.diffs) {
      const spec = bySpec.get(d.key);
      if (!spec || spec.secret || d.secret || !spec.auditValue || !NOTE_PAIR_TYPES.has(spec.type)) continue;
      pairs.push(`${d.key}:${d.before}->${d.after}`);
    }
    return [keys.join(','), `n=${keys.length}`, ...pairs].join(' ');
  }

  function pushSecrets(plan: EnvPlan): void {
    const env2 = parseEnv(plan.newText);
    for (const spec of catalog) {
      if (!spec.secret) continue;
      const v = env2[spec.key];
      if (v && v.length >= 8 && !deps.secrets.includes(v)) deps.secrets.push(v);
    }
  }

  function fromEnvPlan(plan: EnvPlan, payload: unknown, kind: AuditKind): Planned {
    if (plan.errors.length > 0) {
      if (plan.errors.some((e) => e.startsWith('tier_never'))) throw new Refuse(403, 'tier_never');
      // key names and reasons only: a rejected value (possibly a pasted secret) must not be echoed back
      throw new Refuse(422, 'invalid_changes', { errors: plan.errors.map((e) => e.replace(/"[^"]*"/g, '"..."').slice(0, 300)) });
    }
    return {
      etag: plan.etag,
      payload,
      view: {
        etag: plan.etag, diffs: plan.diffs, errors: [], warnings: plan.warnings,
        friction: { reauth: plan.friction.reauth, phrase: plan.friction.phrase },
        restart: plan.restart, modeAfter: plan.modeAfter,
      },
      friction: plan.friction,
      kind,
      note: envNote(plan),
      commit: () => applyEnvPlan(plan, { fs, path: deps.envPath, backupDir: deps.backupDir, keep: deps.backupKeep, now }),
      restart: plan.restart,
      afterApply: () => pushSecrets(plan),
    };
  }

  function envPlanned(c: Ctx, body: Record<string, unknown>): Planned {
    if (typeof body.etag !== 'string' || !Array.isArray(body.changes)) throw new Refuse(400, 'bad_request');
    const state = readEnvState(fs, deps.envPath);
    if (body.etag !== state.etag) throw new Refuse(409, 'stale_etag');
    const plan = planEnvChange(state, body.changes as ChangeOp[], catalog, policyCtx(c));
    return fromEnvPlan(plan, { etag: body.etag, changes: body.changes }, 'settings_env_apply');
  }

  function filePlanned(
    id: string, entry: FileEntry, text: string, etag: string, payload: unknown, kind: AuditKind,
  ): Planned {
    if (!entry.edit) throw new Refuse(403, 'not_editable');
    if (Buffer.byteLength(text, 'utf8') > entry.maxBytes) throw new Refuse(413, 'too_large');
    const cur = store.read(id);
    if (etag !== cur.etag) throw new Refuse(409, 'stale_etag');
    const plan = store.plan(id, text, etag);
    if (plan.errors.length > 0) {
      if (plan.stale) throw new Refuse(409, 'stale_etag');
      throw new Refuse(422, 'invalid_file', { errors: plan.errors });
    }
    const friction = fileFriction(id, plan);
    return {
      etag: cur.etag,
      payload,
      view: {
        etag: plan.etag, newEtag: plan.newEtag, diff: plan.diff, errors: [], warnings: plan.warnings,
        friction: { reauth: friction.reauth, phrase: friction.phrase },
        restart: plan.restart === 'none' ? [] : [{ key: `file:${id}`, scope: plan.restart }],
        tier: plan.tier, weakens: plan.weakens, changedPaths: plan.changedPaths,
      },
      friction,
      kind,
      note: `file=${id} n=${plan.changedPaths}`,
      commit: () => store.apply(plan, text),
      restart: plan.restart === 'none' ? [] : [{ key: `file:${id}`, scope: plan.restart }],
    };
  }

  function parseTarget(v: unknown): { env: true } | { file: string } {
    if (v === 'env') return { env: true };
    if (typeof v === 'string') {
      const m = /^file:([a-z0-9-]{1,40})$/.exec(v);
      if (m) return { file: m[1] };
    }
    throw new Refuse(400, 'bad_target');
  }

  function rollbackPlanned(c: Ctx, body: Record<string, unknown>): Planned {
    const target = parseTarget(body.target);
    const backupId = body.backupId;
    if (typeof backupId !== 'string' || backupId.length > 100) throw new Refuse(400, 'bad_request');
    if ('env' in target) {
      const state = readEnvState(fs, deps.envPath);
      const plan = planRollback(state, backupId, { fs, backupDir: deps.backupDir, catalog, ctx: policyCtx(c) });
      // the current etag is held by the pending row, so a change on disk after the preview is a 409, not a hash mismatch
      return fromEnvPlan(plan, { target: 'env', backupId }, 'settings_rollback');
    }
    const entry = resolveEntry(target.file);
    if (!entry) throw new Refuse(404, 'not_found');
    const cur = store.read(entry.id);
    const text = readBackup({ fs, backupDir: deps.backupDir }, { file: entry.id }, backupId);
    return filePlanned(entry.id, entry, text, cur.etag, { target: `file:${entry.id}`, backupId }, 'settings_rollback');
  }

  // ---- the shared write flow -------------------------------------------------------------------------------

  async function runWrite(
    c: Ctx,
    mode: 'preview' | 'apply',
    prep: () => { limit: number; build: (body: Record<string, unknown>) => Planned },
  ): Promise<void> {
    let past = false; // failures before the guards pass (headers, disabled, limits) do not count toward the lock
    try {
      guards(c); // (2) (4) (5); (1) route auth ran in the generic gate, (3) is registration itself
      past = true;
      const { limit, build } = prep();
      const raw = await readJson(c.req, limit); // (6) content type, size, parse
      if (!isRec(raw)) throw new Refuse(400, 'bad_request');
      const p = build(raw); // (7) plan
      if (p.friction.refuse) throw new Refuse(403, p.friction.refuse); // (8)
      if (p.friction.reauth && !fresh(c)) return reauth(c);
      const t = now();
      const planHashOf = (token: string): string => sha256Hex(token + canonical(p.payload));

      if (mode === 'preview') {
        const token = randomBytes(32).toString('hex');
        savePendingSettings(auth, {
          tokenHash: sha256Hex(token), sessionHash: c.session!.idHash, planHash: planHashOf(token), etag: p.etag,
          expiresAt: new Date(t.getTime() + TOKEN_TTL_SEC * 1000).toISOString(),
        }, t);
        return reply(c, 200, { plan: p.view, token, expiresInSec: TOKEN_TTL_SEC });
      }

      if (p.friction.phrase !== null && !phraseMatches(raw.phrase, p.friction.phrase)) {
        throw new Refuse(403, 'phrase_mismatch');
      }
      // (9) the token is consumed here, before any further check can fail
      const token = raw.token;
      if (typeof token !== 'string' || token.length < 16 || token.length > 200) throw new Refuse(403, 'token_invalid');
      const row = takePendingSettings(auth, sha256Hex(token), t);
      if (!row) throw new Refuse(403, 'token_invalid');
      if (row.used) throw new Refuse(403, 'token_used');
      if (!safeEq(row.sessionHash, c.session!.idHash)) throw new Refuse(403, 'token_session');
      if (!(Date.parse(row.expiresAt) > t.getTime())) throw new Refuse(403, 'token_expired');
      const planHash = planHashOf(token);
      if (!safeEq(planHash, row.planHash)) throw new Refuse(403, 'plan_mismatch');
      if (row.etag !== p.etag) throw new Refuse(409, 'stale_etag');

      const out = p.commit(); // (10)
      p.afterApply?.();
      if (p.restart.length > 0) deps.pendingRestart?.mark(p.restart);
      auditRow(p.kind, c, p.note, planHash); // (11)
      reply(c, 200, { ok: true, backupId: out.backupId, newEtag: out.newEtag, restart: p.restart });
    } catch (e) {
      let r: Refuse;
      if (e instanceof Refuse) r = e;
      else if (e instanceof SettingsError) r = new Refuse(SETTINGS_STATUS[e.code] ?? 500, e.code);
      else throw e;
      if (r.status === 429) {
        if (r.code !== 'locked') auditRejectThrottled(c, r.code); // the lock itself was audited when it started
        return reply(c, 429, { error: r.code }, { 'Retry-After': String(r.body?.retry ?? 60) });
      }
      auditReject(c, r.code);
      if (mode === 'apply' && past) recordFail(c);
      reply(c, r.status, { error: r.code, ...(r.body && 'errors' in r.body ? { errors: r.body.errors } : {}) });
    }
  }

  // ---- read handlers -----------------------------------------------------------------------------------------

  function currentModeView(text: string): { mode: 'DRY RUN' | 'LIVE'; flags: Record<string, string> } {
    const m = currentMode(fileFlags(parseEnv(text)));
    return { mode: m.mode, flags: m.flags };
  }

  const getMeta = (c: Ctx): void => {
    const state = readEnvState(fs, deps.envPath);
    const mode = currentModeView(state.text);
    reply(c, 200, {
      editEnabled: deps.editEnabled,
      remoteExposure: deps.remoteExposure,
      mode,
      modeChangedSinceStart: mode.mode !== deps.startMode.mode,
      pendingRestart: deps.pendingRestart ? deps.pendingRestart.list() : [],
      restartCommands: RESTART_COMMANDS,
      reauthFresh: fresh(c),
      catalogVersion,
      backupKeep: deps.backupKeep,
    });
  };

  const getEnv = (c: Ctx): void => {
    const q = (c.url.searchParams.get('q') ?? '').slice(0, 100).toLowerCase();
    const section = (c.url.searchParams.get('section') ?? '').slice(0, 40);
    const state = readEnvState(fs, deps.envPath);
    const file = parseEnv(state.text);
    const sections = new Map<string, { id: string; title: string; items: unknown[] }>();
    for (const s of catalog) {
      if (section && s.section !== section) continue;
      if (q && !`${s.key} ${s.about} ${s.feature}`.toLowerCase().includes(q)) continue;
      const raw = file[s.key];
      const isSet = raw !== undefined && raw.trim() !== '';
      const secret = s.secret || s.type === 'secret';
      const shell = deps.shellEnv?.[s.key];
      const item = {
        key: s.key, about: s.about, feature: s.feature, type: s.type, default: s.default, min: s.min, max: s.max,
        allowed: s.allowed, required: s.required, secret, tier: s.tier, tierReason: s.tierReason,
        restart: s.restart, restartCommand: RESTART_COMMANDS[s.restart],
        state: {
          set: isSet,
          ...(isSet && !secret ? { value: raw } : {}),
          source: isSet ? 'file' : s.default !== null ? 'default' : 'unset',
          modified: isSet && s.default !== raw,
          shellOverride: shell !== undefined && shell !== (raw ?? ''),
        },
      };
      let g = sections.get(s.section);
      if (!g) sections.set(s.section, (g = { id: s.section, title: SECTION_TITLES[s.section] ?? s.section, items: [] }));
      g.items.push(item);
    }
    const known = new Set(catalog.map((s) => s.key));
    reply(c, 200, {
      etag: state.etag,
      sections: [...sections.values()],
      unknownKeys: Object.keys(file).filter((k) => !known.has(k)).sort(),
    });
  };

  const getFiles = (c: Ctx): void => reply(c, 200, store.list());

  const getFile = (c: Ctx, [id]: string[]): void => {
    const entry = resolveEntry(id);
    if (!entry) return reply(c, 404, { error: 'not_found' });
    try {
      const r = store.read(entry.id);
      let warnings: string[] = [];
      try {
        warnings = store.plan(entry.id, r.text, r.etag).warnings;
      } catch {
        warnings = [];
      }
      reply(c, 200, {
        text: r.text, etag: r.etag, exists: r.exists, warnings,
        entry: {
          id: entry.id, rel: entry.rel, area: entry.area, edit: entry.edit, tier: entry.tier, restart: entry.restart,
          maxBytes: entry.maxBytes, ...(entry.viewReason ? { viewReason: entry.viewReason } : {}),
        },
      });
    } catch (e) {
      if (e instanceof SettingsError) return reply(c, SETTINGS_STATUS[e.code] ?? 500, { error: e.code });
      throw e;
    }
  };

  const getBackups = (c: Ctx): void => {
    let target: BackupTarget;
    try {
      const t = parseTarget(c.url.searchParams.get('target'));
      target = 'env' in t ? 'env' : { file: t.file };
    } catch {
      return reply(c, 400, { error: 'bad_target' });
    }
    try {
      const rows = listBackups({ fs, backupDir: deps.backupDir }, target);
      reply(c, 200, rows.map((b) => ({ id: b.id, at: b.at, size: b.bytes })));
    } catch (e) {
      if (e instanceof SettingsError) return reply(c, SETTINGS_STATUS[e.code] ?? 500, { error: e.code });
      throw e;
    }
  };

  // ---- route table -------------------------------------------------------------------------------------------

  const fileRoute = (mode: 'preview' | 'apply') => (c: Ctx, [id]: string[]): Promise<void> =>
    runWrite(c, mode, () => {
      const entry = resolveEntry(id);
      if (!entry) throw new Refuse(404, 'not_found');
      return {
        limit: Math.min(entry.maxBytes * 6 + 4096, 8 * 1024 * 1024),
        build: (b) => {
          if (typeof b.etag !== 'string' || typeof b.text !== 'string') throw new Refuse(400, 'bad_request');
          return filePlanned(entry.id, entry, b.text, b.etag, { id: entry.id, etag: b.etag, text: b.text }, 'settings_file_apply');
        },
      };
    });

  return [
    { method: 'GET', pattern: '/api/settings/meta', fn: getMeta },
    { method: 'GET', pattern: '/api/settings/env', fn: getEnv },
    { method: 'POST', pattern: '/api/settings/env/preview', fn: (c) => runWrite(c, 'preview', () => ({ limit: ENV_BODY_MAX, build: (b) => envPlanned(c, b) })) },
    { method: 'POST', pattern: '/api/settings/env/apply', fn: (c) => runWrite(c, 'apply', () => ({ limit: ENV_BODY_MAX, build: (b) => envPlanned(c, b) })) },
    { method: 'GET', pattern: '/api/settings/files', fn: getFiles },
    { method: 'GET', pattern: '/api/settings/files/:id', fn: getFile },
    { method: 'POST', pattern: '/api/settings/files/:id/preview', fn: fileRoute('preview') },
    { method: 'POST', pattern: '/api/settings/files/:id/apply', fn: fileRoute('apply') },
    { method: 'GET', pattern: '/api/settings/backups', fn: getBackups },
    { method: 'POST', pattern: '/api/settings/rollback/preview', fn: (c) => runWrite(c, 'preview', () => ({ limit: ROLLBACK_BODY_MAX, build: (b) => rollbackPlanned(c, b) })) },
    { method: 'POST', pattern: '/api/settings/rollback/apply', fn: (c) => runWrite(c, 'apply', () => ({ limit: ROLLBACK_BODY_MAX, build: (b) => rollbackPlanned(c, b) })) },
  ];
}
