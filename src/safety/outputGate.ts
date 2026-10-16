// src/safety/outputGate.ts
// Last gate before text leaves the system. Runs AFTER the style gate and resume.check_text;
// the caller passes the normalized_text that check_text returned and its verdict.
import { siteAccountLiterals } from './siteSecrets.js';

export interface OutboundContext {
  recipientKey: string;
  expectedRecipientKey: string;
  threadId?: string;
  expectedThreadId?: string;
  allowedUrls?: string[];
  allowedEmails?: string[];
  rawPageText?: string;
  secretValues?: string[];
  allowedPhrases?: string[];
  factVerdict: 'pass' | 'warn' | 'block';
  // Site-account emails are allowlisted only when scope is 'webcore' (plan 8G task 6); ignored elsewhere.
  scope?: 'webcore';
  accountEmails?: string[];
}

export interface OutboundResult {
  ok: boolean;
  reasons: string[];
}

/** Outbound text longer than this is blocked outright (no legitimate email/note is this long). */
const MAX_TEXT_CHARS = 20_000;
/** Page text beyond this many words is ignored for the copy check (bounded work). */
const MAX_PAGE_WORDS = 50_000;

// All quantifiers are bounded so hostile input cannot cause super-linear scanning.
const URL_RES: RegExp[] = [
  /(?:https?:\/\/|www\.)[^\s)>\]]{1,2048}/gi,
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s)>\]]{0,2048}/gi,
  /\b(?:file|data|javascript|vbscript):[^\s)>\]]{0,2048}/gi,
  // bare domain.tld/path (not preceded by a scheme, userinfo or another host char)
  /(?<![\w./@:-])(?:[a-z0-9-]{1,63}\.){1,5}(?!(?:js|ts|jsx|tsx|py|rb|json|md|vue)\/)[a-z]{2,24}\/[^\s)>\]]{0,2048}/gi,
];
const EMAIL_RE = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/gi;
const PATH_RES: RegExp[] = [
  /(?:^|[\s("':/])(?:~\/|\.\.?\/|\/(?:etc|home|users|var|usr|opt|tmp|root)\/)[\w.\-/]{0,200}/i,
  /\b[A-Za-z]:\\[\w\\.-]{1,200}/,
  /\bsecrets\//i,
  /\.env\b/i,
];
export const SECRET_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9]{16,200}/,
  /\bsk-ant-[A-Za-z0-9_-]{20,200}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{20,200}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,200}/,
  /\beyJ[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{5,2000}/,
];
const COPY_WINDOW_WORDS = 10;

function parseUrl(raw: string): URL | null {
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
    return new URL(hasScheme ? raw : 'https://' + raw);
  } catch {
    return null;
  }
}

/** Drop sentence punctuation and unbalanced closing brackets captured at the end of a match. */
function stripTrailing(raw: string): string {
  let s = raw;
  for (let i = 0; i < 64 && s.length > 0; i++) {
    const last = s[s.length - 1];
    if (/[.,;:!?'"}]/.test(last)) s = s.slice(0, -1);
    else if (last === ')' && !s.includes('(')) s = s.slice(0, -1);
    else break;
  }
  return s;
}

function urlAllowed(rawIn: string, allowed: URL[]): boolean {
  const raw = stripTrailing(rawIn);
  const u = parseUrl(raw);
  if (!u) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  const origin = u.origin.toLowerCase();
  return allowed.some((a) => {
    if (a.origin.toLowerCase() !== origin) return false;
    const base = a.pathname.replace(/\/+$/, '');
    if (base === '') return true;
    return u.pathname === base || u.pathname.startsWith(base + '/');
  });
}

const words = (s: string): string[] =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

function copiedFromPage(text: string, page: string, allowed: string[]): boolean {
  let body = text;
  for (const phrase of allowed) if (phrase) body = body.split(phrase).join(' ');
  const w = words(body);
  if (w.length < COPY_WINDOW_WORDS) return false;
  const pw = words(page).slice(0, MAX_PAGE_WORDS);
  if (pw.length < COPY_WINDOW_WORDS) return false;
  const grams = new Set<string>();
  for (let i = 0; i + COPY_WINDOW_WORDS <= pw.length; i++) {
    grams.add(pw.slice(i, i + COPY_WINDOW_WORDS).join(' '));
  }
  for (let i = 0; i + COPY_WINDOW_WORDS <= w.length; i++) {
    if (grams.has(w.slice(i, i + COPY_WINDOW_WORDS).join(' '))) return true;
  }
  return false;
}

export function gateOutbound(text: string, ctx: OutboundContext): OutboundResult {
  const reasons: string[] = [];

  if (ctx.recipientKey !== ctx.expectedRecipientKey) reasons.push('recipient_mismatch');
  if (ctx.expectedThreadId !== undefined && ctx.threadId !== ctx.expectedThreadId) reasons.push('thread_mismatch');
  if (ctx.factVerdict === 'block') reasons.push('fact_gate_block');

  if (text.length > MAX_TEXT_CHARS) {
    // Fail closed without running pattern scans over oversize input.
    reasons.push('text_too_long');
    return { ok: false, reasons };
  }

  const allowedUrls = (ctx.allowedUrls ?? [])
    .map(parseUrl)
    .filter((u): u is URL => u !== null && (u.protocol === 'http:' || u.protocol === 'https:'));
  const urls = URL_RES.flatMap((re) => text.match(re) ?? []);
  if (urls.some((u) => !urlAllowed(u, allowedUrls))) reasons.push('url_not_allowed');

  const accountEmails = ctx.scope === 'webcore' ? (ctx.accountEmails ?? []).map((e) => e.toLowerCase()) : [];
  const allowedEmails = [...(ctx.allowedEmails ?? []).map((e) => e.toLowerCase()), ...accountEmails];
  const emails = text.match(EMAIL_RE) ?? [];
  if (emails.some((e) => !allowedEmails.includes(e.toLowerCase()))) reasons.push('email_not_allowed');

  if (PATH_RES.some((re) => re.test(text))) reasons.push('path_in_text');
  if (SECRET_SHAPES.some((re) => re.test(text))) reasons.push('secret_shaped');
  if ((ctx.secretValues ?? []).some((v) => v.length >= 8 && !accountEmails.includes(v.toLowerCase()) && text.includes(v))) reasons.push('env_secret_value');

  if (ctx.rawPageText && copiedFromPage(text, ctx.rawPageText, ctx.allowedPhrases ?? [])) {
    reasons.push('copied_from_page');
  }
  return { ok: reasons.length === 0, reasons };
}

export function secretValuesFromEnv(env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value && value.length >= 8 && /KEY|SECRET|TOKEN|PASS(WORD)?/i.test(key)) out.push(value);
  }
  // Site account passwords are literal secrets too (plan 8G task 6). Emails are not: the owner's own
  // address is legitimate outbound text; they are masked by redactSecrets only.
  out.push(...siteAccountLiterals(env).passwords);
  return out;
}
