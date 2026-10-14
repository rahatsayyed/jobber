import { htmlToText } from './htmlText.js';
export { htmlToText };

const MAX_SNAPSHOT = 50_000;

export type Liveness = 'active' | 'expired' | 'uncertain';

const ANTI_BOT = /just a moment|cloudflare|verify you are human|captcha/;
const HARD_EXPIRED = [/no longer available/, /has expired/, /no longer accepting/, /this (?:role|job|position) is closed(?!-)/, /has been filled/, /job (?:is )?no longer exists/];
const CONDITIONAL = /\b(until|once|when|if|unless)\b(?:\W+\w+){0,10}\W+$/;
const APPLY = /\bapply( now| for this job)?\b|easy apply/;
const JOB_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{5,}/i;

const clean = (s: string) => s.normalize('NFD').replace(/\p{Mn}/gu, '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').toLowerCase();

export function classifyLiveness(i: { status: number; requestedUrl: string; finalUrl: string; bodyText: string }): Liveness {
  const text = clean(i.bodyText);
  if (i.status === 404 || i.status === 410) return 'expired';
  if (ANTI_BOT.test(text) || [403, 429, 503].includes(i.status) || i.status >= 500) return 'uncertain';
  if (/[?&]error=true/.test(i.finalUrl)) return 'expired';
  for (const re of HARD_EXPIRED) {
    const m = re.exec(text);
    if (m && !CONDITIONAL.test(text.slice(0, m.index))) return 'expired';
  }
  const id = JOB_ID.exec(i.requestedUrl)?.[0];
  if (id && !i.finalUrl.includes(id)) return 'uncertain';
  if (APPLY.test(text)) return 'active';
  return 'uncertain';
}

/** True only for http(s) URLs whose host is not localhost / private / link-local / internal. */
export function isSafeFetchUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (host.startsWith('[')) {
    const v6 = host.slice(1, -1);
    return !(v6 === '::1' || v6 === '::' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('::ffff:'));
  }
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
  }
  return true;
}

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 200 * 1024;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function readBodyCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) return (await res.text()).slice(0, MAX_BODY_BYTES);
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  while (received < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    const chunk = value.length > MAX_BODY_BYTES - received ? value.subarray(0, MAX_BODY_BYTES - received) : value;
    received += chunk.length;
    text += decoder.decode(chunk, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text + decoder.decode();
}

export async function checkLivenessDetailed(url: string): Promise<{ liveness: Liveness; text: string | null }> {
  if (!isSafeFetchUrl(url)) return { liveness: 'uncertain', text: null };
  try {
    const signal = AbortSignal.timeout(10_000);
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current, { redirect: 'manual', signal, headers: { 'User-Agent': USER_AGENT } });
      if (res.status >= 300 && res.status < 400) {
        try { await res.body?.cancel(); } catch { /* best effort: release the unread redirect body */ }
        const location = res.headers?.get?.('location');
        if (!location) return { liveness: 'uncertain', text: null };
        let next: string;
        try {
          next = new URL(location, current).toString();
        } catch {
          return { liveness: 'uncertain', text: null };
        }
        if (!isSafeFetchUrl(next)) return { liveness: 'uncertain', text: null };
        current = next;
        continue;
      }
      const bodyText = await readBodyCapped(res);
      const liveness = classifyLiveness({ status: res.status, requestedUrl: url, finalUrl: current, bodyText });
      return { liveness, text: res.status >= 200 && res.status < 300 ? htmlToText(bodyText).slice(0, MAX_SNAPSHOT) : null };
    }
    return { liveness: 'uncertain', text: null };
  } catch {
    return { liveness: 'uncertain', text: null };
  }
}

export async function checkLiveness(url: string): Promise<Liveness> {
  return (await checkLivenessDetailed(url)).liveness;
}
