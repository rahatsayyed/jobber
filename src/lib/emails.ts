const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;
const NOISE_SUBSTRINGS = ['example.com', 'sentry', 'wixpress', '@2x'];

export function extractEmails(text: string): string[] {
  const matches = text.match(EMAIL_RE) ?? [];
  const seen = new Set<string>();
  for (const raw of matches) {
    const email = raw.toLowerCase();
    if (IMAGE_EXT_RE.test(email)) continue;
    if (NOISE_SUBSTRINGS.some((noise) => email.includes(noise))) continue;
    seen.add(email);
  }
  return [...seen];
}

const ROLE_LOCALPARTS = new Set([
  'careers',
  'hr',
  'jobs',
  'recruiting',
  'recruitment',
  'talent',
  'hiring',
  'people',
]);

const GENERIC_LOCALPARTS = new Set([
  'info',
  'contact',
  'hello',
  'hi',
  'support',
  'admin',
  'team',
  'sales',
  'office',
]);

export function classify(email: string): 'role' | 'generic' | 'personal' {
  const localpart = email.split('@')[0]?.toLowerCase() ?? '';
  if (ROLE_LOCALPARTS.has(localpart)) return 'role';
  if (GENERIC_LOCALPARTS.has(localpart)) return 'generic';
  return 'personal';
}

const TYPE_ORDER: Record<string, number> = { role: 0, generic: 1, personal: 2 };

export function rankEmails(emails: string[]): { email: string; type: string }[] {
  return emails
    .map((email) => ({ email, type: classify(email) }))
    .sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);
}

function alphaOnly(part: string): string {
  return part.toLowerCase().replace(/[^a-z]/g, '');
}

export function genPatterns(name: string, domain: string, pattern?: string): string[] {
  const parts = name.trim().split(/\s+/).filter(Boolean).map(alphaOnly).filter(Boolean);
  if (parts.length === 0) return [];

  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : '';

  const candidates: string[] = [];

  if (pattern) {
    const rendered = pattern
      .replace(/\{first\}/g, first)
      .replace(/\{last\}/g, last)
      .replace(/\{f\}/g, first[0] ?? '')
      .replace(/\{l\}/g, last[0] ?? '');
    candidates.push(`${rendered}@${domain}`.toLowerCase());
  }

  if (last) {
    candidates.push(
      `${first}.${last}@${domain}`,
      `${first}@${domain}`,
      `${last}@${domain}`,
      `${first[0]}${last}@${domain}`,
      `${first}${last[0]}@${domain}`,
      `${first}${last}@${domain}`,
      `${first}_${last}@${domain}`
    );
  } else {
    candidates.push(`${first}@${domain}`);
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const c of candidates) {
    const lower = c.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      result.push(lower);
    }
  }
  return result;
}
