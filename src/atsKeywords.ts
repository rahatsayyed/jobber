// file: src/atsKeywords.ts
// Adapted from MadsLorentzen/ai-job-search .claude/commands/apply.md step 5d (MIT, (c) 2026 Mads Lorentzen). See that repo's LICENSE.
export interface KeywordSpec { term: string; priority: 'required' | 'preferred'; synonyms?: string[] }
export type KeywordStatus = 'covered' | 'synonym_only' | 'missing_have_it' | 'skills_only' | 'gap';
export interface KeywordResult { term: string; priority: 'required' | 'preferred'; status: KeywordStatus; via?: string }

const SYNONYM_GROUPS: string[][] = [
  ['javascript', 'js'], ['typescript', 'ts'], ['kubernetes', 'k8s'], ['postgresql', 'postgres'], ['golang', 'go'],
  ['ci/cd', 'continuous integration', 'continuous delivery', 'continuous deployment'], ['aws', 'amazon web services'],
  ['gcp', 'google cloud'], ['machine learning', 'ml'], ['llm', 'llms', 'large language model', 'large language models'],
  ['rest api', 'restful api', 'rest'], ['node', 'nodejs'], ['react', 'reactjs'], ['next', 'nextjs'],
  ['fullstack', 'full stack'], ['state management', 'redux', 'react context'], ['docker', 'containers', 'containerization'],
  ['testing', 'unit tests', 'unit testing', 'test coverage'], ['sse', 'server-sent events'], ['ui', 'user interface'],
];

/** Lowercase, fold dashes, ".js" suffixes and full/front/back-end spellings, keep + # / inside terms. */
export function foldKw(s: string): string {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\b(node|react|next|vue|express|nuxt)\s*\.?\s*js\b/g, '$1')
    .replace(/\bfull[\s-]*stack\b/g, 'fullstack').replace(/\bfront[\s-]*end\b/g, 'frontend').replace(/\bback[\s-]*end\b/g, 'backend')
    .replace(/[^a-z0-9+#/]+/g, ' ').trim();
}

/** Boundary-aware match with a simple plural ("rest api" matches "REST APIs" and vice versa). */
export function termMatches(text: string, term: string): boolean {
  let t = foldKw(term);
  if (!t) return false;
  if (t.length > 4 && /[^s]s$/.test(t)) t = t.slice(0, -1);
  const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+');
  const plural = t.length > 3 ? '(?:s|es)?' : '';
  return new RegExp(`(?<![a-z0-9])${esc}${plural}(?![a-z0-9])`).test(foldKw(text));
}

export function synonymsOf(spec: KeywordSpec): string[] {
  const t = foldKw(spec.term);
  const group = SYNONYM_GROUPS.find((g) => g.some((x) => foldKw(x) === t)) ?? [];
  return [...new Set([...group.filter((x) => foldKw(x) !== t), ...(spec.synonyms ?? [])])];
}

/**
 * tailoredText / baseText are PROSE (summary, headline, bullets); skillsText is the base skills list.
 * covered = posting term in the tailored prose; synonym_only = only a synonym there; missing_have_it = the base PROSE shows it;
 * skills_only = the base lists it only as a skill (never claim it as work); gap = nowhere.
 */
export function classifyKeywords(keywords: KeywordSpec[], tailoredText: string, baseText: string, skillsText = ''): KeywordResult[] {
  return keywords.filter((k) => k && typeof k.term === 'string' && k.term.trim()).map((k) => {
    const priority = k.priority === 'required' ? 'required' : 'preferred';
    if (termMatches(tailoredText, k.term)) return { term: k.term, priority, status: 'covered' };
    const syn = synonymsOf(k).find((s) => termMatches(tailoredText, s));
    if (syn) return { term: k.term, priority, status: 'synonym_only', via: syn };
    if ([k.term, ...synonymsOf(k)].some((s) => termMatches(baseText, s))) return { term: k.term, priority, status: 'missing_have_it' };
    if ([k.term, ...synonymsOf(k)].some((s) => termMatches(skillsText, s))) return { term: k.term, priority, status: 'skills_only' };
    return { term: k.term, priority, status: 'gap' };
  });
}

export function coveragePct(results: KeywordResult[]): number | null {
  return results.length ? Math.round((100 * results.filter((r) => r.status === 'covered').length) / results.length) : null;
}
