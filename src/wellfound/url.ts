// Wellfound search URLs, built in code only (used by wellfound_discover). The shapes are unverified live.

/** Lowercase ascii slug; anything outside [a-z0-9] collapses to one dash. Never carries quotes or markup. */
export function slugify(s: string, max = 60): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/**
 * Search URL built in code only:
 *   https://wellfound.com/role/l/<role>/<location>[?remote=true]   (a location)
 *   https://wellfound.com/role/remote/<role>                       (remote only, no location)
 *   https://wellfound.com/role/r/<role>                            (neither)
 */
export function buildSearchUrl(role: string, location?: string, remote = false): string | null {
  const r = slugify(role, 60);
  if (!r) return null;
  const l = location ? slugify(location, 40) : '';
  if (l) return `https://wellfound.com/role/l/${r}/${l}${remote ? '?remote=true' : ''}`;
  return remote ? `https://wellfound.com/role/remote/${r}` : `https://wellfound.com/role/r/${r}`;
}
