// file: src/proseClaims.ts
// Prose-level claim checks derived from the 2026-10-07 blind-judge violations (scripts/eval/fixtures/baseline/judge).
// Pure, no I/O. Compares a tailored resume against the base resume (and optionally the job posting).
import { exceedsScanCap, foldDigits, MAX_SCAN_CHARS, metricClaims, NEGATION_AFTER_RE, NEGATION_RE } from './factClaims.js';

export type ProseKind = 'oversize' | 'scope' | 'lead' | 'years-scope' | 'tool' | 'tool-context' | 'headline' | 'attribution' | 'posting-echo';
export interface ProseFinding { kind: ProseKind; severity: 'block' | 'warn'; value: string; match: string; where: string }
export interface Located { where: string; text: string }

const STOP = new Set(('a an the and or of to in on for with by at as from is are was were be been that this it its into via using ' +
  'across per over under than then also both each while within without through new more most our their your ' +
  'cut cutting reduce reduced reducing improve improved improving enable enabled enabling eliminating eliminated ' +
  'accelerating accelerated resulting decreasing increasing boosting lowering saving strengthening maintaining').split(' '));

export function contentTokens(s: string): string[] {
  return foldDigits(s).toLowerCase().replace(/[‐-―−]/g, '-')
    .split(/[^a-z0-9+#.-]+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d/.test(t));
}

function splitSentences(s: string): string[] {
  return s.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((x) => x.trim()).filter(Boolean);
}

function descriptionLines(d: unknown): string[] {
  if (Array.isArray(d)) return d.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim());
  if (typeof d === 'string') return d.split('\n').map((x) => x.replace(/^[\s\-*•]+/, '').trim()).filter(Boolean);
  return [];
}

/** Every prose statement of a resume with a JSON-path-like location. Skills are not prose. */
export function resumeStatements(r: any): Located[] {
  const out: Located[] = [];
  if (typeof r?.jobTitle === 'string' && r.jobTitle.trim()) out.push({ where: 'jobTitle', text: r.jobTitle.trim() });
  if (typeof r?.summary === 'string') splitSentences(r.summary).forEach((text, i) => out.push({ where: `summary[${i}]`, text }));
  (Array.isArray(r?.experience) ? r.experience : []).forEach((e: any, i: number) =>
    descriptionLines(e?.description).forEach((text, j) => out.push({ where: `experience[${i}].description[${j}]`, text })));
  (Array.isArray(r?.projects) ? r.projects : []).forEach((p: any, i: number) =>
    descriptionLines(p?.description).forEach((text, j) => out.push({ where: `projects[${i}].description[${j}]`, text })));
  return out;
}

const isBullet = (where: string) => /^(experience|projects)\[/.test(where);

function skillsText(r: any): string {
  return (Array.isArray(r?.skills) ? r.skills : []).flatMap((s: any) => (Array.isArray(s?.items) ? s.items : [])).join(', ');
}
function titlesText(r: any): string {
  return [r?.jobTitle, ...(Array.isArray(r?.experience) ? r.experience.map((e: any) => e?.title) : [])].filter((x) => typeof x === 'string').join('. ');
}

// ---- 1. scope escalations: phrases the judges flagged when the base never says them ----
export const SCOPE_PATTERNS: Array<{ id: string; re: RegExp; severity: 'block' | 'warn' }> = [
  { id: 'ownership', re: /(?<!\b(?:its|their|my|our|your|his|her)\s+)\b(?:own(?:s|ed|ing)?|ownership)\b/i, severity: 'block' }, // possessive "their own filter state" is not ownership
  { id: 'end-to-end', re: /\bend[\s-]to[\s-]end\b/i, severity: 'block' },
  { id: 'from-scratch', re: /\bfrom (?:scratch|the ground up)\b|\bgreenfield\b|\bzero[\s-]to[\s-]one\b/i, severity: 'block' },
  { id: 'tech-direction', re: /\b(?:set|sets|setting|drove|drive|drives|driving|shaped|shaping|defined|defining)\s+(?:the\s+)?(?:technical|engineering|architectural|product)\s+(?:direction|strategy|vision|roadmap)\b/i, severity: 'block' },
  { id: 'people-lead', re: /\b(?:mentor(?:ed|ing|s)?|coach(?:ed|ing)?|line[\s-]manag\w*|managed\s+(?:a\s+|the\s+)?(?:team|engineers|developers)|(?:team|tech|technical|engineering)\s+lead|head(?:ed)?\s+of)\b/i, severity: 'block' },
  { id: 'scale', re: /\b(?:large|large-scale|massive|enterprise(?:-grade)?|high-traffic|high-scale|global)\s+(?:[\w.-]+\s+){0,2}?(?:codebases?|applications?|apps?|systems?|platforms?|products?|teams?|scale|user\s*base)\b/i, severity: 'block' },
  { id: 'user-facing', re: /\b(?:user|customer|consumer|client)[\s-]facing\b/i, severity: 'block' },
  { id: 'microservices', re: /\bmicro-?services?\b|\bmicroservice-style\b/i, severity: 'block' },
  { id: 'production', re: /\bproduction(?:-grade|-ready)?\b/i, severity: 'warn' },
];

// ---- 2. leadership verbs must lead the same work the base says was led ----
// One family: the judges accepted "Directed" -> "Led" for the same work, but not "Led" for different work.
const LEAD_RE = /\b(led|lead|leading|headed|spearheaded|architected|architecting|directed|drove|driving)\b\s+([^.;]{3,160})/gi;
const LEAD_BLOCK_BELOW = 0.25; // < 25% of the led object's content words appear in any base lead statement: block
const LEAD_WARN_BELOW = 0.5;   // 25-49%: warn (the reviewer fixes it)

// ---- 3. "N+ years of <qualifier> experience" ----
// Judges flagged "3+ years of commercial React and TypeScript experience" (general years made stack-specific and
// commercial) but accepted "3+ years of experience building React ..." when the base shows React work. So a years
// claim blocks only when its qualifier adds an escalation word, and warns when it names a skills-list-only technology.
const YEARS_RE = /(?<!\d)(\d{1,15})\s*\+?\s*years?\s+(?:of\s+)?((?:[\w.+#/-]+,?\s+){0,5}?)experience\b((?:\s+(?:in|with|building|across|on)\s+(?:[\w.+#/-]+,?\s*){1,8}))?/gi;
const YEARS_ESCALATION = new Set(['commercial', 'enterprise', 'professional', 'industry', 'senior', 'leadership']);
function yearsClaims(text: string): Array<{ n: string; qualText: string; quals: string[]; raw: string }> {
  const out: Array<{ n: string; qualText: string; quals: string[]; raw: string }> = [];
  for (const m of foldDigits(text).matchAll(YEARS_RE)) {
    const qualText = `${m[2] ?? ''} ${m[3] ?? ''}`;
    out.push({ n: m[1], qualText, quals: contentTokens(qualText), raw: m[0].trim().slice(0, 100) });
  }
  return out;
}

// ---- 4. technology lexicon: a named technology in prose must exist in the base, and in base prose for bullets ----
export const TECH_TERMS: Array<[string, RegExp]> = [
  ['kubernetes', /\bkubernetes\b|\bk8s\b/i], ['terraform', /\bterraform\b/i], ['ansible', /\bansible\b/i], ['helm', /\bhelm\b/i],
  ['graphql', /\bgraphql\b/i], ['grpc', /\bgrpc\b/i], ['websockets', /\bweb\s?sockets?\b/i], ['webrtc', /\bwebrtc\b/i],
  ['kafka', /\bkafka\b/i], ['rabbitmq', /\brabbitmq\b/i], ['redis', /\bredis\b/i], ['elasticsearch', /\belastic\s?search\b/i],
  ['postgresql', /\bpostgres(?:ql)?\b/i], ['mysql', /\bmysql\b/i], ['mongodb', /\bmongo(?:db)?\b/i], ['dynamodb', /\bdynamodb\b/i],
  ['sqlite', /\bsqlite\b/i], ['prisma', /\bprisma\b/i], ['firebase', /\bfirebase\b/i], ['supabase', /\bsupabase\b/i],
  ['apollo', /\bapollo\b/i], ['redux', /\bredux\b/i], ['zustand', /\bzustand\b/i], ['react native', /\breact[\s-]native\b/i],
  ['vue', /\bvue(?:\.?js)?\b/i], ['angular', /\bangular(?:js)?\b/i], ['svelte', /\bsvelte(?:kit)?\b/i], ['nuxt', /\bnuxt(?:\.?js)?\b/i],
  ['remix', /\bremix\b/i], ['backbone', /\bbackbone(?:\.?js)?\b/i], ['jquery', /\bjquery\b/i], ['coffeescript', /\bcoffee\s?script\b/i],
  ['python', /\bpython\b/i], ['django', /\bdjango\b/i], ['flask', /\bflask\b/i], ['fastapi', /\bfastapi\b/i],
  ['ruby', /\bruby\b/i], ['rails', /\brails\b/i], ['java', /\bjava\b(?!\s*script)/i], ['spring', /\bSpring(?:\s+Boot)?\b/],
  ['kotlin', /\bkotlin\b/i], ['swift', /\bswift(?:ui)?\b/i], ['flutter', /\bflutter\b/i], ['dart', /\bdart\b/i],
  ['php', /\bphp\b/i], ['laravel', /\blaravel\b/i], ['.net', /\.net\b|\bdotnet\b|\bc#/i], ['rust', /\brust\b/i],
  ['golang', /\b[Gg][Oo][Ll][Aa][Nn][Gg]\b|(?:\b(?:in|with|using)\s+|,\s*)Go\b/], ['scala', /\bscala\b/i], ['elixir', /\belixir\b/i], ['haskell', /\bhaskell\b/i],
  ['solidity', /\bsolidity\b/i], ['aws', /\baws\b|\bamazon web services\b/i], ['gcp', /\bgcp\b|\bgoogle cloud\b/i], ['azure', /\bazure\b/i],
  ['vercel', /\bvercel\b/i], ['heroku', /\bheroku\b/i], ['cloudflare', /\bcloudflare\b/i], ['docker', /\bdocker\b/i],
  ['jenkins', /\bjenkins\b/i], ['github actions', /\bgithub actions\b/i], ['gitlab ci', /\bgitlab[\s-]ci\b/i], ['ci/cd', /\bci\s*\/\s*cd\b/i],
  ['jest', /\bjest\b/i], ['cypress', /\bcypress\b/i], ['playwright', /\bplaywright\b/i], ['selenium', /\bselenium\b/i],
  ['storybook', /\bstorybook\b/i], ['webpack', /\bwebpack\b/i], ['vite', /\bvite\b/i], ['sass', /\bs[ac]ss\b/i],
  ['tailwind', /\btailwind(?:\s?css)?\b/i], ['figma', /\bfigma\b/i], ['openai', /\bopen\s?ai\b/i], ['langchain', /\blangchain\b/i],
  ['pytorch', /\bpytorch\b/i], ['tensorflow', /\btensorflow\b/i], ['pinecone', /\bpinecone\b/i], ['vector database', /\bvector\s+(?:db|database|store)s?\b/i],
  ['serverless', /\bserverless\b/i], ['nginx', /\bnginx\b/i], ['oauth', /\boauth\b/i], ['stripe', /\bstripe\b/i],
  ['d3', /\bd3(?:\.?js)?\b/i], ['three.js', /\bthree\.?js\b/i], ['webgl', /\bwebgl\b/i], ['node.js', /\bnode(?:\.?js)?\b/i],
  ['express', /\bExpress(?:\.?js)?\b/], ['next.js', /\bnext\.?js\b/i], ['react', /\breact(?:\.?js)?\b(?![\s-]native)/i],
  ['typescript', /\btypescript\b/i], ['javascript', /\bjavascript\b/i], ['llm', /\bLLMs?\b/], ['rag', /\bRAG\b/], ['mcp', /\bMCP\b/],
  ['cardano', /\bcardano\b/i], ['ethereum', /\bethereum\b/i],
];
function techIn(text: string): Set<string> {
  const s = new Set<string>();
  for (const [name, re] of TECH_TERMS) if (re.test(text)) s.add(name);
  return s;
}
const NEGATION_WINDOW = 4; // words
/**
 * Technologies a statement CLAIMS: techIn minus any term whose every mention has a negation within 4 words
 * ("Rails is not in my toolkit yet", "I haven't worked with Kubernetes yet"). "no"/"without" only count BEFORE the term,
 * so "on Kubernetes with no downtime" still claims Kubernetes.
 */
function techClaims(text: string): Set<string> {
  const s = new Set<string>();
  for (const [name, re] of TECH_TERMS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) {
      const at = m.index ?? 0;
      // bounded windows (4 words never need more than ~80 chars of context) keep this linear on long text
      const before = text.slice(Math.max(0, at - 80), at).split(/\s+/).filter(Boolean).slice(-NEGATION_WINDOW).join(' ');
      const after = text.slice(at + m[0].length, at + m[0].length + 80).split(/\s+/).filter(Boolean).slice(0, NEGATION_WINDOW).join(' ');
      if (!(NEGATION_RE.test(before) || NEGATION_AFTER_RE.test(after))) { s.add(name); break; }
    }
  }
  return s;
}

// ---- 5. headline: only plain role words may be added to the base titles ----
const ROLE_WORDS = new Set(['software', 'engineer', 'developer', 'frontend', 'front-end', 'backend', 'back-end', 'full', 'stack',
  'full-stack', 'fullstack', 'web', 'application', 'applications', 'programmer']);
function headlineExtras(headline: string, base: any): string[] {
  const allowed = new Set([...ROLE_WORDS, ...titlesText(base).toLowerCase().split(/[^a-z0-9+#.-]+/).filter(Boolean)]);
  return headline.toLowerCase().split(/[^a-z0-9+#.-]+/).filter((w) => w.length > 1 && !STOP.has(w) && !allowed.has(w));
}

// ---- 7. posting echo: n-grams copied from the posting that the base never says ----
function words(s: string): string[] {
  return foldDigits(s).toLowerCase().replace(/[‐-―−]/g, '-').split(/[^a-z0-9+#.-]+/)
    .map((w) => w.replace(/^[.-]+|[.-]+$/g, '')).filter(Boolean);
}
const GENERIC = new Set([...ROLE_WORDS, 'experience', 'building', 'build', 'built', 'development', 'engineering', 'team', 'teams',
  'work', 'working', 'years', 'strong', 'skills', 'knowledge', 'understanding', 'ability', 'solutions', 'technologies', 'modern']);
const isTechWord = (w: string) => TECH_TERMS.some(([, re]) => re.test(w));
function ngrams(ws: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= ws.length; i++) {
    const g = ws.slice(i, i + n);
    if (!g.every((w) => w.length >= 2 && !STOP.has(w) && !/^\d/.test(w))) continue;
    if (g.every((w) => GENERIC.has(w) || isTechWord(w))) continue;
    out.push(g.join(' '));
  }
  return out;
}

/** First prose field longer than the extractors' scan cap, as "<resume>.<field>"; null when every field fits. */
function oversizeField(label: string, r: any): string | null {
  const fields: Array<[string, unknown]> = [['jobTitle', r?.jobTitle], ['summary', r?.summary]];
  for (const key of ['experience', 'projects'] as const) {
    (Array.isArray(r?.[key]) ? r[key] : []).forEach((e: any, i: number) => {
      const d = e?.description;
      if (Array.isArray(d)) d.forEach((x, j) => fields.push([`${key}[${i}].description[${j}]`, x]));
      else fields.push([`${key}[${i}].description`, d]);
    });
  }
  for (const [name, v] of fields) if (typeof v === 'string' && exceedsScanCap(v)) return `${label} ${name}`;
  return null;
}

export function proseFindings(base: any, tailored: any, opts: { jobDescription?: string; jobTitle?: string } = {}): ProseFinding[] {
  // Fail closed: the extractors truncate at MAX_SCAN_CHARS, so unscanned text would pass unchecked.
  const big = oversizeField('tailored', tailored) ?? oversizeField('base', base);
  if (big) return [{ kind: 'oversize', severity: 'block', value: `oversize: ${big} exceeds ${MAX_SCAN_CHARS} chars; not fact-checked`, match: 'oversize', where: big }];
  const findings: ProseFinding[] = [];
  const add = (f: ProseFinding) => {
    if (!findings.some((x) => x.kind === f.kind && x.value === f.value && x.where === f.where)) findings.push(f);
  };
  const baseStmts = resumeStatements(base);
  const baseProse = [titlesText(base), ...baseStmts.map((s) => s.text)].join('\n');
  const baseFull = `${baseProse}\n${skillsText(base)}`;
  const baseBullets = baseStmts.filter((s) => isBullet(s.where));
  const baseTech = techIn(baseFull);
  const baseProseTech = techIn(baseProse);
  const baseYears = new Map<string, Set<string>>();
  for (const y of yearsClaims(baseProse)) {
    const set = baseYears.get(y.n) ?? new Set<string>();
    y.quals.forEach((q) => set.add(q));
    baseYears.set(y.n, set);
  }
  const baseLead = baseStmts.filter((s) => new RegExp(LEAD_RE.source, 'i').test(s.text)).map((s) => new Set(contentTokens(s.text)));
  const baseWordSet = new Set(words(baseFull));
  const baseGrams = new Set([...ngrams(words(baseFull), 2), ...ngrams(words(baseFull), 3)]);
  const jdGrams = opts.jobDescription ? new Set([...ngrams(words(opts.jobDescription), 2), ...ngrams(words(opts.jobDescription), 3)]) : null;

  for (const st of resumeStatements(tailored)) {
    const { where, text } = st;
    for (const p of SCOPE_PATTERNS) {
      const m = p.re.exec(text);
      if (m && !p.re.test(baseProse)) add({ kind: 'scope', severity: p.severity, value: `${p.id}: "${m[0]}"`, match: m[0].toLowerCase(), where });
    }
    for (const m of text.matchAll(LEAD_RE)) {
      const obj = contentTokens(m[2]).slice(0, 8);
      if (!obj.length) continue;
      const best = Math.max(0, ...baseLead.map((b) => obj.filter((t) => b.has(t)).length / obj.length));
      if (best < LEAD_WARN_BELOW) add({ kind: 'lead', severity: best < LEAD_BLOCK_BELOW ? 'block' : 'warn', value: `"${m[1]} ${m[2].slice(0, 60).trim()}" is not work the base says was led/directed/architected`, match: `${m[1]} ${m[2]}`.toLowerCase(), where });
    }
    for (const y of yearsClaims(text)) {
      const allowed = baseYears.get(y.n);
      if (!allowed) continue; // a changed number is caught by the metric check
      const escalations = y.quals.filter((q) => YEARS_ESCALATION.has(q) && !allowed.has(q));
      const skillsOnlyTech = [...techIn(y.qualText)].filter((t) => baseTech.has(t) && !baseProseTech.has(t));
      if (escalations.length) add({ kind: 'years-scope', severity: 'block', value: `"${y.raw}" adds to the base's ${y.n}+ years: ${escalations.join(', ')}`, match: y.raw.toLowerCase(), where });
      if (skillsOnlyTech.length) add({ kind: 'years-scope', severity: 'warn', value: `"${y.raw}" counts skills-list-only technology in the years claim: ${skillsOnlyTech.join(', ')}`, match: y.raw.toLowerCase(), where });
    }
    for (const t of techClaims(text)) { // a gap line ("Rails is not in my toolkit yet") is not in techClaims
      if (!baseTech.has(t)) add({ kind: 'tool', severity: 'block', value: t, match: t, where });
      else if (!baseProseTech.has(t)) add({ kind: 'tool-context', severity: isBullet(where) ? 'block' : 'warn', value: `${t} is only in the skills list; no base bullet shows work with it`, match: t, where });
    }
    if (where === 'jobTitle' || where === 'summary[0]') {
      const head = where === 'jobTitle' ? text : (/^([A-Z][\w./+&, -]{2,60}?)\s+with\s+\d/.exec(text)?.[1] ?? '');
      const extras = head ? headlineExtras(head, base) : [];
      if (extras.length) add({ kind: 'headline', severity: 'warn', value: `"${head}" adds words not in any base title: ${extras.join(', ')}`, match: head.toLowerCase(), where });
      if (head && opts.jobTitle && head.trim().toLowerCase() === opts.jobTitle.trim().toLowerCase() && !titlesText(base).toLowerCase().includes(head.trim().toLowerCase()))
        add({ kind: 'headline', severity: 'warn', value: `"${head}" copies the posting title`, match: head.toLowerCase(), where });
    }
    if (isBullet(where)) {
      const tok = new Set(contentTokens(text));
      const sims = baseBullets.map((b) => {
        const bt = new Set(contentTokens(b.text));
        const shared = [...tok].filter((t) => bt.has(t)).length;
        return { b, shared, containment: tok.size ? shared / tok.size : 0 };
      });
      for (const claim of metricClaims(text)) {
        const sources = baseStmts.filter((b) => metricClaims(b.text).has(claim));
        if (sources.length && !sources.some((b) => contentTokens(b.text).filter((t) => tok.has(t)).length >= 2))
          add({ kind: 'attribution', severity: 'warn', value: `"${claim}" sits in a bullet unrelated to the base bullet that states it`, match: claim, where });
      }
      const nearCopy = sims.some((s) => s.containment >= 0.8);
      const overlapping = sims.filter((s) => s.shared >= 3);
      if (!nearCopy && overlapping.length >= 2 && metricClaims(text).size)
        add({ kind: 'attribution', severity: 'warn', value: `bullet merges ${overlapping.length} base bullets; check every number still describes its own work`, match: text.toLowerCase(), where });
    }
    if (jdGrams) {
      const ws = words(text);
      for (const g of [...ngrams(ws, 3), ...ngrams(ws, 2)]) {
        if (jdGrams.has(g) && !baseGrams.has(g) && g.split(' ').some((w) => !baseWordSet.has(w)))
          add({ kind: 'posting-echo', severity: 'warn', value: g, match: g, where });
      }
    }
  }
  // keep at most 8 posting-echo findings so the report stays readable
  let echoes = 0;
  return findings.filter((f) => f.kind !== 'posting-echo' || ++echoes <= 8);
}
