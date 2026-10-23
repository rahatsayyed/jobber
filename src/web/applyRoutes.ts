// src/web/applyRoutes.ts
// Dashboard box for /apply requests (always available to a fresh authenticated session). Two steps, like the chat box: prepare validates the URL
// with the shared validator and shows how it will be handled, confirm consumes a one-time token and queues ONE manual_requests row through
// deps.enqueue (a short-lived write connection; the dashboard's own handle stays read-only). CSRF, Origin and Host checks are enforced by the
// server for every POST before these handlers run. Nothing here fetches the URL or bypasses the kill switch or dry run.
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { audit, type AuthDb } from '../dash/authStore.js';
import { isFresh } from '../dash/sessions.js';
import { defaultDeps, readControl } from '../scheduler/control.js';
import { applyTokenText, describeManualRequest, listRecentRequests, openRequestFor } from '../manual/webRequest.js';
import type { CreateResult } from '../manual/requests.js';
import { confirmSend, prepareSend, sha256Hex } from './chat.js';
import { json, readJson, type Ctx } from './router.js';

export interface ApplyDeps {
  /** The narrow write: inserts one manual_requests row (createManualRequest) on a short-lived connection. */
  enqueue: (url: string, force: boolean, now: Date) => CreateResult;
}

export interface ApplyRoute { method: 'GET' | 'POST'; pattern: string; fn: (c: Ctx) => Promise<void> | void }

export const APPLY_MAX_PER_HOUR = 10;
const HOUR_MS = 3_600_000;

export function createApplyRoutes(
  deps: ApplyDeps,
  env: { auth: AuthDb; data: BetterSqlite3.Database; now: () => Date; reauthMaxAgeSec: number; reauthUrl: string; root: string; processEnv: NodeJS.ProcessEnv },
): ApplyRoute[] {
  const { auth, data, now } = env;
  const hits = new Map<string, number[]>(); // session id hash -> confirmed request times (ms)
  const stale = (c: Ctx): boolean => !isFresh(c.session!, now(), env.reauthMaxAgeSec);
  const reauth = (c: Ctx): void => json(c.res, 401, { error: 'reauth_required', url: env.reauthUrl });
  const body = async (c: Ctx): Promise<{ url: unknown; force: boolean; token: unknown }> => {
    const b = await readJson(c.req, 4096);
    const o = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
    return { url: o.url, force: o.force === true, token: o.token };
  };
  function stopped(): boolean {
    try {
      return readControl(data, defaultDeps(env.processEnv, join(env.root, '.jobber', 'STOP'))).killed;
    } catch {
      return true;
    }
  }

  return [
    {
      method: 'POST', pattern: '/api/apply/prepare',
      fn: async (c) => {
        const { url, force } = await body(c);
        if (stale(c)) return reauth(c);
        const t = now();
        const d = describeManualRequest(url, force);
        if (!d.ok) {
          audit(auth, 'apply_reject', { ip: c.ip, note: d.reason }, t);
          return json(c.res, 400, { error: 'invalid url', reason: d.reason });
        }
        const open = openRequestFor(data, d.url);
        const lines = [...d.lines];
        if (open) lines.push(`An identical request is already open (#${open.id}, ${open.status}); confirming reuses it${force ? ' and sets force on it' : ''}.`);
        const p = prepareSend(auth, c.session!.idHash, applyTokenText(d.url, force), t);
        audit(auth, 'apply_prepare', { ip: c.ip, textHash: sha256Hex(d.url) }, t);
        json(c.res, 200, { token: p.token, url: d.url, force, classification: d.classification, lines, expiresInSec: p.expiresInSec, stopped: stopped() });
      },
    },
    {
      method: 'POST', pattern: '/api/apply/confirm',
      fn: async (c) => {
        const { url, force, token } = await body(c);
        const t = now();
        const d = describeManualRequest(url, force);
        if (!d.ok || typeof token !== 'string') {
          audit(auth, 'apply_reject', { ip: c.ip, note: d.ok ? 'bad token' : d.reason }, t);
          return json(c.res, 400, { error: 'invalid request' });
        }
        if (stale(c)) return reauth(c);
        const idHash = c.session!.idHash;
        const recent = (hits.get(idHash) ?? []).filter((x) => t.getTime() - x < HOUR_MS);
        if (recent.length >= APPLY_MAX_PER_HOUR) {
          hits.set(idHash, recent);
          audit(auth, 'apply_reject', { ip: c.ip, note: 'rate limited' }, t);
          const wait = Math.max(1, Math.ceil((recent[0]! + HOUR_MS - t.getTime()) / 1000));
          return json(c.res, 429, { error: 'too many requests', limit: APPLY_MAX_PER_HOUR }, { 'Retry-After': String(wait) });
        }
        const r = confirmSend(auth, idHash, token, applyTokenText(d.url, force), t);
        if (!r.ok) {
          audit(auth, 'apply_reject', { ip: c.ip, note: r.reason, textHash: sha256Hex(d.url) }, t);
          return json(c.res, 409, { error: r.reason });
        }
        recent.push(t.getTime());
        hits.set(idHash, recent);
        if (hits.size > 64) for (const [k, v] of hits) if (!v.some((x) => t.getTime() - x < HOUR_MS)) hits.delete(k);
        let res: CreateResult;
        try {
          res = deps.enqueue(d.url, force, t);
        } catch (e) {
          audit(auth, 'apply_reject', { ip: c.ip, note: 'write failed', textHash: sha256Hex(d.url) }, t);
          console.error(`web: apply request write failed: ${e instanceof Error ? e.name : 'error'}`);
          return json(c.res, 502, { error: 'write failed' });
        }
        if (!res.ok) {
          audit(auth, 'apply_reject', { ip: c.ip, note: res.reason, textHash: sha256Hex(d.url) }, t);
          return json(c.res, 400, { error: 'invalid url', reason: res.reason });
        }
        audit(auth, 'apply_request', { ip: c.ip, note: `#${res.id}${res.duplicate ? ' duplicate' : ''}`, textHash: sha256Hex(d.url) }, t);
        json(c.res, 200, { ok: true, id: res.id, duplicate: res.duplicate, kind: res.kind, stopped: stopped() });
      },
    },
    {
      method: 'GET', pattern: '/api/apply/requests',
      fn: (c) => {
        json(c.res, 200, { items: listRecentRequests(data, 20), stopped: stopped(), limitPerHour: APPLY_MAX_PER_HOUR });
      },
    },
  ];
}
