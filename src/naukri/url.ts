// Naukri search URLs, built in code only (shared by naukri_search and naukri_discover).

/** Lowercase ascii slug; anything outside [a-z0-9] collapses to one dash. Never carries quotes or markup. */
export function slugify(s: string, max = 60): string {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
}

/** Search URL built in code only: https://www.naukri.com/<query>-jobs[-in-<location>][-<page>]. */
export function buildSearchUrl(query: string, location?: string, page = 1): string | null {
  const q = slugify(query, 60);
  if (!q) return null;
  const l = location ? slugify(location, 40) : '';
  const p = Math.min(3, Math.max(1, Math.trunc(Number.isFinite(page) ? page : 1)));
  return `https://www.naukri.com/${q}-jobs${l ? `-in-${l}` : ''}${p > 1 ? `-${p}` : ''}`;
}
