// Automated Hacker News domain check: the company domain resolved for a
// hackernews job must match a domain or email found in the posting itself.

const EXCLUDED_HOSTS = [
  'ycombinator.com',
  'news.ycombinator.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'github.com',
  'youtube.com',
  'medium.com',
  't.co',
  'bit.ly',
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'gmx.com',
  'mail.com',
  'yandex.com',
];

const SECOND_LEVEL = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.in', 'org.in', 'net.in', 'com.au', 'net.au', 'org.au',
  'com.sg', 'co.jp', 'com.br', 'co.za', 'com.ae', 'co.nz', 'com.mx', 'com.tr', 'com.sa', 'com.eg',
  'co.il', 'com.cn', 'com.hk', 'com.pk', 'com.my', 'co.id', 'co.kr', 'com.ar', 'com.co',
]);

function normHost(raw: string): string {
  return raw.trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}

export function registrableDomain(host: string): string {
  const labels = normHost(host).split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return SECOND_LEVEL.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

function excluded(host: string): boolean {
  return EXCLUDED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export function postingDomains(text: string): string[] {
  const out = new Set<string>();
  const add = (raw: string) => {
    let host = normHost(raw);
    if (!host.includes('.') || !/^[\p{L}\p{N}.-]+$/u.test(host)) return;
    try {
      host = normHost(new URL(`http://${host}`).hostname); // punycode-normalises IDN
    } catch {
      return;
    }
    if (!host.includes('.') || excluded(host)) return;
    out.add(host);
  };
  const body = text ?? '';
  for (const m of body.matchAll(/[A-Za-z0-9._%+-]+@([\p{L}\p{N}.-]+\.[\p{L}]{2,})/gu)) add(m[1]);
  for (const m of body.matchAll(/\bhttps?:\/\/(?:[^\s/@]+@)?([\p{L}\p{N}.-]+\.[\p{L}]{2,})(?::\d+)?/giu)) add(m[1]);
  return [...out];
}

export type HnCheck = 'matched' | 'unmatched' | 'no_domain_in_posting' | 'not_applicable';

export function hnDomainCheck(
  job: { source: string; description: string | null },
  resolvedDomain: string,
): HnCheck {
  if (job.source !== 'hackernews') return 'not_applicable';
  const domains = postingDomains(job.description ?? '');
  if (domains.length === 0) return 'no_domain_in_posting';
  const want = registrableDomain(resolvedDomain);
  if (!want) return 'unmatched';
  return domains.some((d) => registrableDomain(d) === want) ? 'matched' : 'unmatched';
}

/**
 * Seam for the contacts tool: runs `work` only when the check does not block.
 * On unmatched / no_domain_in_posting `work` is never called (no scraping,
 * search, Hunter or verification).
 */
export async function withHnGate<T>(
  job: { source: string; description: string | null } | null,
  resolvedDomain: string,
  work: () => Promise<T[]>,
): Promise<{ contacts: T[]; hn_check: HnCheck }> {
  const hn_check: HnCheck = job ? hnDomainCheck(job, resolvedDomain) : 'not_applicable';
  if (hn_check === 'unmatched' || hn_check === 'no_domain_in_posting') {
    return { contacts: [], hn_check };
  }
  return { contacts: await work(), hn_check };
}
