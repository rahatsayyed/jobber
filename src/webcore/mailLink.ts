// Verification mail handoff (plan 8G task 6, D13, O-email). Mail text is third-party text and an
// injection channel (not classifier-screened in this plan): only a link that passes the host rule
// and the path/token rule is ever used, and no mail text reaches an instruction.
import { hostAllowed, type WebRuntime } from './runtime.js';
import { isDryRun, recordDryRun } from '../safety/dryRun.js';
import type BetterSqlite3 from 'better-sqlite3';

export type VerifyMode = 'gmail' | 'owner_assist' | 'off';

export function parseSenders(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.SITE_MAIL_SENDERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length <= 254 && /^[a-z0-9._%+-]*@[a-z0-9.-]+\.[a-z]{2,24}$/.test(s));
}

/** gmail only when set explicitly AND the sender allowlist is non-empty; anything else is owner_assist (or off). */
export function verificationMode(env: NodeJS.ProcessEnv = process.env): VerifyMode {
  const v = String(env.SITE_MAIL_VERIFY ?? '').trim().toLowerCase();
  if (v === 'off') return 'off';
  if (v === 'gmail' && parseSenders(env).length > 0) return 'gmail';
  return 'owner_assist';
}

const URL_RE = /https?:\/\/[^\s<>"')\]]{1,2048}/gi;
const PATH_RE = /verify|confirm|activate|validate/i;
const TOKEN_PARAM_RE = /^(token|t|code|key|vtoken|verification[_-]?(token|code)|confirmation[_-]?token|auth)$/i;

function fromAddress(text: string): string | null {
  const m = /^\s*from:\s*(.{1,300})$/im.exec(text);
  if (!m) return null;
  const a = /<([^<>\s]+@[^<>\s]+)>/.exec(m[1]) ?? /([^\s<>,;"]+@[^\s<>,;"]+)/.exec(m[1]);
  return a ? a[1].toLowerCase() : null;
}

function senderAllowed(addr: string | null, senders: string[]): boolean {
  if (!addr) return false;
  return senders.some((s) => (s.startsWith('@') ? addr.endsWith(s) : addr === s));
}

export function linkAcceptable(raw: string, hosts: string[]): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  if (!hostAllowed(raw, hosts)) return false;
  if (PATH_RE.test(u.pathname)) return true;
  for (const k of u.searchParams.keys()) if (TOKEN_PARAM_RE.test(k)) return true;
  return false;
}

/**
 * Pure. Returns at most one link: the first that is https, credential-free, on the site's allowed
 * host set, and carries a verify-style path or a token parameter. With `senders` set, the message's
 * From header must be on the allowlist (a missing From header fails).
 */
export function extractVerificationLinks(text: string, opts: { senders?: string[]; hosts: string[] }): string[] {
  const body = String(text ?? '').slice(0, 100_000);
  if (opts.senders && !senderAllowed(fromAddress(body), opts.senders)) return [];
  for (const m of body.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?]+$/, '');
    if (linkAcceptable(raw, opts.hosts)) return [raw];
  }
  return [];
}

export interface OpenLinkDeps {
  runtime: WebRuntime;
  db: BetterSqlite3.Database;
  hosts: string[];
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}
export type OpenLinkResult =
  | { status: 'opened'; url: string }
  | { status: 'dry_run' }
  | { status: 'refused'; code: 'no_link' | 'mode_off' | 'host_change' | 'failed'; reason: string };

/**
 * The single tool with a URL-ish input. A bare URL or pasted message text; the same host and
 * path rules apply to both. In gmail mode a pasted mail must also come from an allowlisted sender;
 * in owner_assist the owner supplied the text, so only the host and path rules apply.
 */
export async function siteOpenLink(input: { url_or_message_text: string }, deps: OpenLinkDeps): Promise<OpenLinkResult> {
  const env = deps.env ?? process.env;
  const mode = verificationMode(env);
  if (mode === 'off') return { status: 'refused', code: 'mode_off', reason: 'verification links are switched off' };
  const text = String(input.url_or_message_text ?? '').trim();
  const bare = /^https?:\/\/\S+$/i.test(text);
  const links = bare
    ? (linkAcceptable(text, deps.hosts) ? [text] : [])
    : extractVerificationLinks(text, { hosts: deps.hosts, senders: mode === 'gmail' ? parseSenders(env) : undefined });
  if (links.length === 0) return { status: 'refused', code: 'no_link', reason: 'no acceptable verification link' };
  const link = links[0];
  const now = (deps.now ?? (() => new Date()))();
  if (isDryRun(env, { web: true })) {
    recordDryRun(deps.db, { runId: null, action: 'site_open_link', platform: 'web', payload: { host: new URL(link).hostname } }, now, env);
    return { status: 'dry_run' };
  }
  const r = await deps.runtime.navigate(link);
  if (!r.ok) return { status: 'refused', code: r.code === 'refused' ? 'host_change' : 'failed', reason: r.reason };
  return { status: 'opened', url: `${new URL(r.url).origin}${new URL(r.url).pathname}` };
}
