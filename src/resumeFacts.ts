import { existsSync, readFileSync } from 'node:fs';
import { userDataPath } from './lib/userData.js';
import { delegatedAuthorshipClaims, diagnoseCoverage, exceedsScanCap, factClaims, joinStatements, MAX_SCAN_CHARS, metricClaims, normalizeClaim, normalizeFact, sourceContainsFact } from './factClaims.js';
import { proseFindings, resumeStatements } from './proseClaims.js';
import { mixedScriptWords, normalizeForAts, normalizeText } from './atsText.js';
import { stripMarkers } from './emailHtml.js';

/** `mixed-script:<word>: reason` findings for words that mix Latin with another script (homoglyph bypass). */
const mixedScriptFindings = (text: string): string[] =>
  uniqStrings(mixedScriptWords(text).map((m) => `mixed-script:${m.word}: mixes Latin with ${m.scripts.join('/')} letters`));
const uniqStrings = (xs: string[]) => [...new Set(xs)];

export interface FactCheckResult { verdict: 'pass' | 'block'; invented: string[] }

const YEAR = /^(19|20)\d{2}$/;
const METRIC = /\$?€?£?\d[\d,]*(?:\.\d+)?\s*(?:%|[kKmMbB]\b|x\b)?/g;

export function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => strings(x, out));
  return out;
}
const norm = (s: unknown) =>
  String(s ?? '')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const tokens = (s: string): string[] => norm(s).replace(/\.js\b/g, '').split(/[^a-z0-9]+/).filter(Boolean);

function metrics(v: unknown): Set<string> {
  const found = new Set<string>();
  for (const text of strings(v)) {
    for (const m of text.matchAll(METRIC)) {
      const tok = m[0].toLowerCase().replace(/[\s,]/g, '');
      if (!tok || YEAR.test(tok)) continue;
      found.add(tok);
    }
  }
  return found;
}

function field(arr: any, key: string): Set<string> {
  return new Set((Array.isArray(arr) ? arr : []).map((x: any) => norm(x?.[key])).filter(Boolean));
}
function skillItems(r: any): string[] {
  return (r?.skills ?? []).flatMap((s: any) => (s?.items ?? []).map(norm)).filter(Boolean);
}

export function checkFacts(base: Record<string, any>, tailored: Record<string, any>): FactCheckResult {
  const invented: string[] = [];
  const baseMetrics = metrics(base);
  for (const m of metrics(tailored)) if (!baseMetrics.has(m)) invented.push(`metric:${m}`);

  for (const key of ['company', 'title', 'location', 'start', 'end'] as const) {
    const allowed = field(base.experience, key);
    for (const v of field(tailored.experience, key)) if (!allowed.has(v)) invented.push(`${key}:${v}`);
  }
  for (const key of ['degree', 'school', 'year'] as const) {
    const allowed = field(base.education, key);
    for (const v of field(tailored.education, key)) if (!allowed.has(v)) invented.push(`education-${key}:${v}`);
  }
  // Token pool: a tailored skill passes iff every word in it appears somewhere in the base skills.
  const pool = new Set(skillItems(base).flatMap(tokens));
  for (const s of new Set(skillItems(tailored))) {
    const t = tokens(s);
    if (!t.length || !t.every(w => pool.has(w))) invented.push(`skill:${s}`);
  }
  // Rendered headings/titles: projects and certificates must exist in the base (normalized equality); a skill
  // category may only use words from the base's category names and skill items ("Kubernetes & Go" blocks).
  const baseProjects = field(base.projects, 'title');
  for (const v of field(tailored.projects, 'title')) if (!baseProjects.has(v)) invented.push(`project:${v}`);
  const baseCerts = field(base.certificates, 'name');
  for (const v of field(tailored.certificates, 'name')) if (!baseCerts.has(v)) invented.push(`certificate:${v}`);
  const catPool = new Set([...pool, ...[...field(base.skills, 'category')].flatMap(tokens), 'and']);
  for (const c of field(tailored.skills, 'category')) if (!tokens(c).every(w => catPool.has(w))) invented.push(`skill-category:${c}`);

  const contacts: Array<[string, unknown, unknown]> = [
    ['name', base.name, tailored.name], ['email', base.email, tailored.email],
    ['phone', base.phone, tailored.phone], ['website', base.website?.url, tailored.website?.url],
  ];
  for (const [k, b, t] of contacts) if (norm(t) && norm(t) !== norm(b)) invented.push(`contact:${k}`);

  return { verdict: invented.length ? 'block' : 'pass', invented };
}

// ---------- v2: full fact gate (v1 checks + claim extractors + prose checks + config) ----------
export interface FactGateConfig { allow_metrics: string[]; allow_facts: string[]; forbidden_phrases: string[]; warn_phrases: string[] }
export const EMPTY_FACT_GATE: FactGateConfig = { allow_metrics: [], allow_facts: [], forbidden_phrases: [], warn_phrases: [] };
const defaultFactGatePath = userDataPath('fact-gate.json');

/** Read fresh on every call (like easy-apply-answers.json). Missing file = reported, invalid file = throws (fail closed). */
export function loadFactGateConfig(file: string = defaultFactGatePath): { config: FactGateConfig; missing: boolean } {
  if (!existsSync(file)) return { config: { ...EMPTY_FACT_GATE }, missing: true };
  return { config: validateFactGateObject(JSON.parse(readFileSync(file, 'utf8'))), missing: false };
}

/** Pure shape check of a parsed fact-gate.json; throws on the first problem (same messages as the loader). */
export function validateFactGateObject(raw: unknown): FactGateConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('user-data/fact-gate.json: top level must be an object');
  for (const k of Object.keys(raw)) if (!(k in EMPTY_FACT_GATE)) throw new Error(`user-data/fact-gate.json: unknown key "${k}"`);
  const config: FactGateConfig = { ...EMPTY_FACT_GATE };
  for (const k of Object.keys(EMPTY_FACT_GATE) as Array<keyof FactGateConfig>) {
    const v = (raw as Record<string, unknown>)[k];
    if (v == null) continue;
    if (!Array.isArray(v) || !v.every((x: unknown) => typeof x === 'string')) throw new Error(`user-data/fact-gate.json: ${k} must be an array of strings`);
    config[k] = v as string[];
  }
  return config;
}

export interface FactReport {
  verdict: 'pass' | 'warn' | 'block';
  invented: string[];
  unsupported: string[];
  forbidden: string[];
  warnings: string[];
  configMissing: boolean;
}
export interface CheckOptions { jobDescription?: string; jobTitle?: string; company?: string; config?: FactGateConfig; configMissing?: boolean }

const uniq = (xs: string[]) => [...new Set(xs)];
function phraseHits(text: string, phrases: string[]): string[] {
  const t = norm(text);
  return uniq(phrases.map((p) => p.trim()).filter(Boolean).filter((p) => t.includes(norm(p))));
}
function allowedMetricSet(sourceText: string, allow: string[]): Set<string> {
  const s = new Set(metricClaims(sourceText));
  for (const e of allow) {
    s.add(normalizeClaim(e));
    metricClaims(e).forEach((x) => s.add(x));
  }
  return s;
}
const POSTING_NOUNS = new Set(['role', 'opening', 'position', 'posting', 'listing', 'job', 'vacancy', 'opportunity', 'advert']);
const OPENING_NOUNS = new Set(['opening', 'posting', 'listing', 'vacancy', 'advert', 'opportunity']);
const REF_VERBS = [['saw'], ['noticed'], ['spotted'], ['came', 'across'], ['applied', 'for'], ['applying', 'for'], ['applying', 'to'], ['interested', 'in'], ['read']];
const DETERMINERS = new Set(['the', 'your', 'this', 'a']);
const QUOTES = `"'“”‘’`;
const TOKEN_RE = /[^\s.,&\-‐-―−"'“”‘’()]+/g;
interface Tok { raw: string; key: string | null; start: number; end: number }
/** Tokens split on whitespace . , & dashes and quotes. A standalone "js" is dropped and a trailing "js" is stripped, so "React js", "React.js" and "ReactJS" compare equal. */
function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of text.matchAll(TOKEN_RE)) {
    const raw = m[0].toLowerCase();
    let key: string | null = raw;
    if (raw === 'js') key = null;
    else if (raw.length > 2 && raw.endsWith('js')) key = raw.slice(0, -2);
    out.push({ raw, key, start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}
/** Blank out mentions of the posting title / company only when quoted or structurally tied to a posting reference
 *  (after "saw the", before "role/opening/...", "the X ... role", or "opening at X"). Every other mention stays visible to the claim extractors. */
function blankOut(text: string, phrases: Array<string | undefined>): string {
  const toks = tokenize(text);
  const kept = toks.map((t, i) => ({ t, i })).filter((x) => x.t.key !== null);
  const ranges: Array<[number, number]> = [];
  const rawAt = (i: number) => (i >= 0 && i < toks.length ? toks[i].raw : '');
  for (const p of phrases) {
    if ((p ?? '').trim().length < 3) continue;
    const pk = tokenize(p!).map((t) => t.key).filter((k): k is string => k !== null);
    if (!pk.length) continue;
    for (let j = 0; j + pk.length <= kept.length; j++) {
      if (!pk.every((k, n) => kept[j + n].t.key === k)) continue;
      const first = kept[j], last = kept[j + pk.length - 1];
      const start = first.t.start, end = last.t.end;
      const before = text.slice(0, start).trimEnd().slice(-1), after = text.slice(end).trimStart().charAt(0);
      const quoted = !!before && !!after && QUOTES.includes(before) && QUOTES.includes(after);
      const prev = rawAt(first.i - 1);
      const det = DETERMINERS.has(prev);
      const verbEnd = det ? first.i - 2 : first.i - 1;
      const afterVerb = REF_VERBS.some((v) => v.every((w, n) => rawAt(verbEnd - (v.length - 1) + n) === w));
      const nextNoun = POSTING_NOUNS.has(rawAt(last.i + 1));
      const detThenNoun = (prev === 'the' || prev === 'your' || prev === 'this') && [1, 2, 3].some((d) => POSTING_NOUNS.has(rawAt(last.i + d)));
      const openingAt = ['at', 'with', 'from', 'in'].includes(prev) && OPENING_NOUNS.has(rawAt(first.i - 2));
      if (quoted || afterVerb || nextNoun || detThenNoun || openingAt) ranges.push([start, end]);
    }
  }
  let out = text;
  for (const [x, y] of ranges.sort((m, n) => n[0] - m[0])) out = out.slice(0, x) + ' ' + out.slice(y);
  return out;
}
function resolveConfig(opts: CheckOptions): { config: FactGateConfig; missing: boolean } {
  return opts.config ? { config: opts.config, missing: !!opts.configMissing } : loadFactGateConfig();
}
function finish(invented: string[], unsupported: string[], forbidden: string[], warnings: string[], missing: boolean): FactReport {
  if (missing) warnings.push('config: user-data/fact-gate.json not found; allow-lists and phrase checks did not run');
  const verdict = invented.length || unsupported.length || forbidden.length ? 'block' : warnings.length ? 'warn' : 'pass';
  return { verdict, invented: uniq(invented), unsupported: uniq(unsupported), forbidden: uniq(forbidden), warnings: uniq(warnings), configMissing: missing };
}

// Extractors silently cap input at MAX_SCAN_CHARS, so the gate refuses oversize fields instead of truncating.
function oversizeBlock(fields: Record<string, string>, missing: boolean): FactReport | null {
  const bad = Object.entries(fields).filter(([, t]) => exceedsScanCap(t)).map(([k]) => `oversize: ${k} exceeds ${MAX_SCAN_CHARS} chars; not fact-checked`);
  return bad.length ? finish([], bad, [], [], missing) : null;
}

/** The resume gate used by render_resume. v1 checkFacts stays as-is; this adds everything v2 checks. */
export function checkResume(rawBase: Record<string, any>, rawTailored: Record<string, any>, opts: CheckOptions = {}): FactReport {
  const { config, missing } = resolveConfig(opts);
  // Gate the ATS-normalized text (invisible format characters stripped), the same text the renderer prints.
  const base = normalizeForAts(rawBase);
  const tailored = normalizeForAts(rawTailored);
  const baseText = joinStatements(strings(base));
  const baseProse = joinStatements(resumeStatements(base).map((s) => s.text));
  const prose = joinStatements(resumeStatements(tailored).map((s) => s.text));
  const tailoredText = joinStatements(strings(tailored));
  const over = oversizeBlock({ 'tailored resume': prose, 'tailored resume text': tailoredText, 'base resume': baseText, 'base resume prose': baseProse }, missing);
  if (over) return over;
  const allowedMetrics = allowedMetricSet(baseText, config.allow_metrics);
  const allowFacts = new Set(config.allow_facts.map(normalizeFact));

  const invented = checkFacts(base, tailored).invented.filter((x) => !(x.startsWith('metric:') && allowedMetrics.has(normalizeClaim(x.slice(7)))));
  for (const c of metricClaims(tailoredText)) if (c.includes(' ') && !allowedMetrics.has(c)) invented.push(`count:${c}`);

  const sourceNorm = normalizeFact(baseText);
  const unsupported: string[] = mixedScriptFindings(tailoredText); // every rendered text field, not just prose
  for (const c of [...factClaims(prose, sourceNorm), ...delegatedAuthorshipClaims(prose, baseProse)]) {
    if (!sourceContainsFact(sourceNorm, c.value) && !allowFacts.has(c.value)) unsupported.push(`${c.kind}:${c.value}`);
  }
  const warnings: string[] = [];
  for (const f of proseFindings(base, tailored, { jobDescription: opts.jobDescription, jobTitle: typeof opts.jobTitle === 'string' ? normalizeText(opts.jobTitle) : undefined })) {
    if (allowFacts.has(normalizeFact(f.match))) continue;
    (f.severity === 'block' ? unsupported : warnings).push(`${f.kind}:${f.value} @${f.where}`);
  }
  const forbidden = phraseHits(prose, config.forbidden_phrases);
  const baseWarn = new Set(phraseHits(baseProse, config.warn_phrases));
  for (const p of phraseHits(prose, config.warn_phrases)) if (!baseWarn.has(p)) warnings.push(`phrase:${p}`);
  const cov = diagnoseCoverage(prose);
  if (cov) warnings.push(`coverage:${cov}`);
  return finish(invented, unsupported, forbidden, warnings, missing);
}

/** Gate for drafted emails / connect notes / follow-ups. `extraSource` adds text the claims may also come from (e.g. the original sent email).
 *  `jobTitle` and `company` are blanked out of the text first: naming the posting or the employer is not a claim. */
export function checkOutreachText(text: string, base: Record<string, any>, opts: CheckOptions & { extraSource?: string } = {}): FactReport {
  const { config, missing } = resolveConfig(opts);
  // Gate the normalized text (invisible format characters stripped); callers must send this same text (see checkTextWithNormalized).
  base = normalizeForAts(base);
  const clean = blankOut(normalizeText(String(text ?? '')).replace(/https?:\/\/\S+/g, ' '), [opts.jobTitle, opts.company].map((p) => (typeof p === 'string' ? normalizeText(p) : undefined)));
  const extra = normalizeText(opts.extraSource ?? '');
  const baseOnly = joinStatements(strings(base));
  const baseText = joinStatements([...strings(base), extra]);
  const fields: Record<string, string> = { 'outreach text': clean, 'extra source': extra, 'base resume': baseOnly };
  if (!Object.values(fields).some(exceedsScanCap)) fields['base resume plus extra source'] = baseText;
  const over = oversizeBlock(fields, missing);
  if (over) return over;
  const allowedMetrics = allowedMetricSet(baseText, config.allow_metrics);
  const allowFacts = new Set(config.allow_facts.map(normalizeFact));
  const invented = [...metricClaims(clean)].filter((c) => !allowedMetrics.has(c)).map((c) => `metric:${c}`);
  const sourceNorm = normalizeFact(baseText);
  const unsupported: string[] = mixedScriptFindings(normalizeText(String(text ?? '')));
  for (const c of [...factClaims(clean, sourceNorm), ...delegatedAuthorshipClaims(clean, baseText)]) {
    if (!sourceContainsFact(sourceNorm, c.value) && !allowFacts.has(c.value)) unsupported.push(`${c.kind}:${c.value}`);
  }
  const warnings: string[] = [];
  const pseudo = { summary: clean.replace(/\s*\n+\s*/g, ' ') };
  const proseBase = extra ? { ...base, summary: `${base?.summary ?? ''}\n${extra}` } : base;
  for (const f of proseFindings(proseBase, pseudo, { jobDescription: opts.jobDescription })) {
    if (f.kind === 'headline' || f.kind === 'posting-echo') continue; // an email may quote the role title and the posting
    if (allowFacts.has(normalizeFact(f.match))) continue;
    (f.severity === 'block' ? unsupported : warnings).push(`${f.kind}:${f.value}`);
  }
  const forbidden = phraseHits(clean, config.forbidden_phrases);
  for (const p of phraseHits(clean, config.warn_phrases)) warnings.push(`phrase:${p}`);
  return finish(invented, unsupported, forbidden, warnings, missing);
}

/** The check_text MCP result: the gate report plus `normalized_text`, the exact text that was gated (enqueue/send THIS, never the pre-gate text). */
export function checkTextWithNormalized(text: string, base: Record<string, any>, opts: CheckOptions & { extraSource?: string } = {}): FactReport & { normalized_text: string } {
  // normalized_text may carry up to three **...** emphasis markers (src/emailHtml.ts); the gate always sees the text WITHOUT them,
  // so a marker can never carry a claim the gate did not read.
  const normalized_text = normalizeText(String(text ?? ''));
  return { ...checkOutreachText(stripMarkers(normalized_text), base, opts), normalized_text };
}
