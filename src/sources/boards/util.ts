import { createHash } from 'node:crypto';

/** Short stable hex digest, used for ids derived from a URL or path (no secrets involved). */
export const shortHash = (s: string, len = 12): string => createHash('sha1').update(s).digest('hex').slice(0, len);

/** True once a provider's own deadline (epoch ms, optional) has passed: stop starting requests and return what you have. */
export const pastDeadline = (deadlineAt: number | undefined): boolean => deadlineAt !== undefined && Date.now() >= deadlineAt;

/** False when a response-supplied URL names a port (even a default one) or writes its host with upper-case letters: such a URL falls back to the canonical one. */
export function hasPlainAuthority(candidate: unknown): boolean {
  if (typeof candidate !== 'string') return false;
  const m = /^https:\/\/([^/?#]*)/i.exec(candidate);
  if (!m) return false;
  return !m[1].includes(':') && m[1] === m[1].toLowerCase();
}
