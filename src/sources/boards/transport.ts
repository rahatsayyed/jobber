// Shared hardened HTTP transport for board providers (moved out of greenhouse.ts; greenhouse.ts re-exports it).
// Every request: https only, host policy (fixed set or predicate), no embedded credentials, isSafeFetchUrl, no redirects,
// 20 s timeout, 15 MB body cap that REJECTS (a truncated body is useless), descriptive user-agent that callers cannot override.
import { AsyncLocalStorage } from 'node:async_hooks';
import { isSafeFetchUrl } from '../../liveness.js';
import { hostMatches } from '../../lib/hostClass.js';

export const BOARD_TIMEOUT_MS = 20_000;
export const MAX_BODY_BYTES = 15 * 1024 * 1024;
export const MAX_REQUEST_BODY_CHARS = 20_000;
export const BOARD_USER_AGENT = 'jobber/1.0 (personal job search; contact via repo owner)';
export const BOARD_HEADERS = { 'User-Agent': BOARD_USER_AGENT, Accept: 'application/json' };

// Raw-response sink for shape checks (src/sources/shape.ts). Whoever wraps a provider call in withRawSink() receives the first few
// parsed payloads (JSON values, or the text of an XML/text response) without any provider having to hand them over.
const MAX_RAW_PAYLOADS = 3;
const rawSink = new AsyncLocalStorage<unknown[]>();
export function withRawSink<T>(sink: unknown[], fn: () => Promise<T>): Promise<T> { return rawSink.run(sink, fn); }
function offerRaw(v: unknown): void { const s = rawSink.getStore(); if (s && s.length < MAX_RAW_PAYLOADS) s.push(v); }

/** A fixed hostname set, or a predicate over the lower-cased hostname (per-tenant vendor hosts). */
export type HostPolicy = ReadonlySet<string> | ((hostname: string) => boolean);

const DEFAULT_API_HOSTS: HostPolicy = new Set(['boards-api.greenhouse.io', 'api.lever.co', 'api.eu.lever.co', 'api.ashbyhq.com']);

/** Exactly these hostnames. */
export const exactHosts = (...hosts: string[]): HostPolicy => new Set(hosts.map((h) => h.toLowerCase()));
/** One of the apexes, or any subdomain of one (hostMatches on a synthetic https URL). */
export const apexHosts = (...apexes: string[]): HostPolicy => (host) => apexes.some((a) => hostMatches(`https://${host}/`, a));

export interface RequestOptions {
  /** Allowed hostnames (default: the Greenhouse, Lever and Ashby API hosts). */
  hosts?: HostPolicy;
  /** Extra headers (for example Origin or Referer). User-Agent cannot be overridden. */
  headers?: Record<string, string>;
  /** Overrides the Accept header. */
  accept?: string;
}

// Same idea as the module-private readBodyCapped in src/liveness.ts (not exported, and it truncates), but a board body cut off mid-JSON is useless, so exceeding the cap rejects.
async function readBodyCapped(res: Response, label: string): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    try { await res.body?.cancel(); } catch { /* best effort */ }
    throw new Error(`${label}: response too large`);
  }
  const reader = res.body?.getReader?.();
  if (!reader) {
    const t = await res.text();
    if (Buffer.byteLength(t) > MAX_BODY_BYTES) throw new Error(`${label}: response too large`);
    return t;
  }
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    received += value.length;
    if (received > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); throw new Error(`${label}: response too large`); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function requestText(url: string, label: string, method: 'GET' | 'POST', body: string | undefined, defaultAccept: string, opts: RequestOptions): Promise<string> {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`${label}: host not allowed`); }
  const policy = opts.hosts ?? DEFAULT_API_HOSTS;
  const host = u.hostname.toLowerCase();
  let hostOk = false;
  try { hostOk = !host.endsWith('.') && (typeof policy === 'function' ? policy(host) === true : policy.has(host)); } catch { hostOk = false; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !hostOk || !isSafeFetchUrl(url)) throw new Error(`${label}: host not allowed`);
  if (body !== undefined && body.length > MAX_REQUEST_BODY_CHARS) throw new Error(`${label}: request body too large`);
  // Callers cannot set these in any letter case (a lower-case duplicate would be merged into the real header value).
  const fixed = new Set(['user-agent', 'accept', 'content-type']);
  const extra = Object.fromEntries(Object.entries(opts.headers ?? {}).filter(([k]) => !fixed.has(k.toLowerCase())));
  const headers: Record<string, string> = { ...BOARD_HEADERS, Accept: opts.accept ?? defaultAccept, ...extra, 'User-Agent': BOARD_USER_AGENT };
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  const signal = AbortSignal.timeout(BOARD_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { method, headers, ...(method === 'POST' ? { body } : {}), signal, redirect: 'error' });
  } catch (e: any) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw new Error(`${label}: ${timedOut ? 'timeout' : `request failed (${String(e?.cause?.message ?? e?.message ?? e).slice(0, 120)})`}`);
  }
  if (!res.ok) {
    try { await res.body?.cancel(); } catch { /* best effort */ }
    throw new Error(`${label}: HTTP ${res.status}`);
  }
  try { return await readBodyCapped(res, label); } catch (e: any) {
    if (typeof e?.message === 'string' && e.message.startsWith(`${label}:`)) throw e;
    throw new Error(`${label}: ${e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'timeout' : 'read failed'}`);
  }
}

function parseJson(text: string, label: string): any {
  let v: any;
  try { v = JSON.parse(text); } catch { throw new Error(`${label}: invalid JSON`); }
  offerRaw(v);
  return v;
}

/** GET a JSON document. */
export async function getJson(url: string, label: string, opts: RequestOptions = {}): Promise<any> {
  return parseJson(await requestText(url, label, 'GET', undefined, 'application/json', opts), label);
}

/** GET a text document (XML, RSS, plain text). */
export async function getText(url: string, label: string, opts: RequestOptions = {}): Promise<string> {
  const text = await requestText(url, label, 'GET', undefined, 'application/xml, text/xml, application/rss+xml, text/plain;q=0.8, */*;q=0.5', opts);
  offerRaw(text);
  return text;
}

/** POST a JSON payload and parse the JSON answer (Workday CXS). */
export async function postJson(url: string, payload: unknown, label: string, opts: RequestOptions = {}): Promise<any> {
  let body: string | undefined;
  try { body = JSON.stringify(payload); } catch { throw new Error(`${label}: invalid request body`); }
  if (typeof body !== 'string') throw new Error(`${label}: invalid request body`);
  return parseJson(await requestText(url, label, 'POST', body, 'application/json', opts), label);
}
