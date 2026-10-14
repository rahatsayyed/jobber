// Automated metrics harness for the resume-tailoring eval.
//   npx tsx scripts/eval/metrics.ts <results-dir> [--no-render]
//   npx tsx scripts/eval/metrics.ts --selftest
// Reads <results-dir>/<system>-<jobId>.json (jobId may use "_" instead of ":"), prints one JSON line per
// file, then a markdown summary table (mean over jobs, per system). Run from the repo root.
// Render step calls src/resume.ts renderResumeChecked, which writes into the git-ignored renderer/automation/.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { checkFacts, checkResume } from '../../src/resumeFacts.js';
import { renderResumeChecked } from '../../src/resume.js';
// @ts-ignore: import the lib file directly to avoid pdf-parse's debug side effect
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const EVAL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const JOBS: Job[] = JSON.parse(readFileSync(path.join(EVAL_DIR, 'fixtures', 'jobs.json'), 'utf8'));

interface Job { id: string; title: string; company: string; description: string; mustHaveKeywords: string[] }
type Json = any;

// ---------- text helpers ----------
function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => strings(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => strings(x, out));
  return out;
}
const words = (s: string) => s.split(/\s+/).filter(Boolean);

function bulletsOf(r: Json): string[] {
  const out: string[] = [];
  for (const e of Array.isArray(r?.experience) ? r.experience : []) {
    const d = e?.description;
    if (Array.isArray(d)) d.forEach((x: unknown) => typeof x === 'string' && x.trim() && out.push(x.trim()));
    else if (typeof d === 'string') d.split('\n').map(x => x.replace(/^[\s\-*•]+/, '').trim()).filter(Boolean).forEach(x => out.push(x));
  }
  return out;
}

// ---------- keyword matching (case-insensitive, .js-suffix and punctuation normalised, whole token) ----------
const SYN: Record<string, string> = { postgres: 'postgresql', golang: 'go', k8s: 'kubernete', js: 'javascript' };
function toks(s: string): string[] {
  const t = s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/full[\s-]*stack/g, 'fullstack')
    .replace(/front[\s-]*end/g, 'frontend')
    .replace(/back[\s-]*end/g, 'backend')
    .replace(/\b(node|react|next|vue|nuxt|express)\.?js\b/g, '$1')
    .replace(/\.js\b/g, '')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(' ')
    .filter(Boolean)
    // synonym map first (raw word), then naive plural stem, so "postgres" and "PostgreSQL" meet.
    .map(w => SYN[w] ?? (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return t;
}
function hasPhrase(hay: string[], needle: string[]): boolean {
  if (!needle.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}
function coverage(resume: Json, keywords: string[]): { value: number; missing: string[] } {
  const hay = toks(strings(resume).join(' \n '));
  const missing = keywords.filter(k => !hasPhrase(hay, toks(k)));
  return { value: (keywords.length - missing.length) / keywords.length, missing };
}

// ---------- hygiene ----------
const SLOP = ['leverag', 'spearhead', 'orchestrat', 'seamless', 'robust', 'cutting-edge', 'passionate', 'dynamic', 'synerg', 'utiliz', 'delve', 'tapestry', 'testament', 'pivotal', 'elevat', 'holistic', 'results-driven', 'proven track record'];
const SLOP_RE = SLOP.map(w => ({ w, re: new RegExp('\\b' + w.replace(/[-\s]/g, '[-\\s]'), 'gi') }));
function slopHits(text: string): Record<string, number> {
  const hits: Record<string, number> = {};
  for (const { w, re } of SLOP_RE) { const n = (text.match(re) ?? []).length; if (n) hits[w] = n; }
  return hits;
}
const dashCount = (s: string) => (s.match(/[–—―]|\s--\s/g) ?? []).length;

const VERBS = new Set(('accelerated achieved added administered analyzed architected automated authored boosted built championed coached collaborated configured consolidated contributed converted coordinated created cut debugged decreased delivered deployed designed developed directed drove eliminated enabled engineered enhanced established executed expanded facilitated fixed founded generated guided handled identified implemented improved increased initiated integrated introduced investigated launched led maintained managed mentored merged migrated modernized monitored negotiated onboarded operated optimized orchestrated organized oversaw owned partnered performed pioneered planned prevented produced programmed prototyped provided published reduced refactored released remediated replaced resolved restructured retired reviewed revamped rewrote scaled secured shipped simplified solved spearheaded standardized streamlined strengthened supported tested trained transformed troubleshot unified upgraded validated wrote ' +
  'applied assembled audited benchmarked bootstrapped cleaned cleared clarified closed compiled completed composed connected consulted debugged defined demonstrated diagnosed documented drafted evaluated extended formalized gathered hardened instrumented interviewed iterated mapped measured mentored paired prioritized profiled proposed ran raised rebuilt reorganized represented researched rolled saved scoped set sped stabilized started stood tracked tuned turned updated used wired').split(/\s+/));
const NOT_VERBS = new Set(['embedded', 'related', 'based', 'advanced', 'detailed', 'skilled', 'experienced', 'dedicated', 'motivated', 'seasoned', 'accomplished', 'certified']);
function startWord(b: string): string {
  return (b.replace(/^[^A-Za-z]+/, '').split(/\s+/)[0] ?? '').toLowerCase().replace(/[^a-z]/g, '');
}
const isVerb = (w: string) => VERBS.has(w) || (w.length > 4 && w.endsWith('ed') && !NOT_VERBS.has(w));

// ---------- diff vs base (token-set overlap heuristic) ----------
const STOP = new Set('a an the and or of to in on for with by at as from is are was were be been that this it its into via using across per'.split(' '));
const tset = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9+#.%]+/g, ' ').split(' ').filter(w => w.length > 1 && !STOP.has(w)));
function sim(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const jacc = inter / (a.size + b.size - inter);
  const contain = inter / a.size; // how much of the tailored bullet is already in the base bullet
  return Math.max(jacc, 0.8 * contain);
}
function diffVsBase(base: Json, t: Json) {
  const bb = bulletsOf(base), tb = bulletsOf(t);
  const bsets = bb.map(tset);
  let unchanged = 0, reworded = 0, added = 0;
  const used = new Set<number>();
  for (const b of tb) {
    const s = tset(b);
    let best = 0, bi = -1;
    bsets.forEach((x, i) => { const v = sim(s, x); if (v > best) { best = v; bi = i; } });
    if (best >= 0.95 || (bi >= 0 && b.trim().toLowerCase() === bb[bi].trim().toLowerCase())) { unchanged++; used.add(bi); }
    else if (best >= 0.4) { reworded++; used.add(bi); }
    else added++;
  }
  const skillOrder = (r: Json) => JSON.stringify((r?.skills ?? []).map((c: any) => [c?.category, c?.items]));
  return {
    baseBullets: bb.length, bulletsUnchanged: unchanged, bulletsReworded: reworded, bulletsNew: added,
    baseBulletsDropped: bb.length - used.size,
    summaryChanged: (t?.summary ?? null) !== (base?.summary ?? null),
    jobTitleChanged: (t?.jobTitle ?? null) !== (base?.jobTitle ?? null),
    skillsChangedOrOrder: skillOrder(t) !== skillOrder(base),
    method: 'token-set overlap: sim=max(jaccard, 0.8*containment); >=0.95 or identical=unchanged, >=0.4=reworded, else new',
  };
}

// ---------- parsing ----------
function parseLoose(raw: string): { value: Json; note: string | null } {
  try { return { value: JSON.parse(raw), note: null }; } catch { /* fall through */ }
  const s = raw.trim().replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '');
  try { return { value: JSON.parse(s), note: 'code fence stripped' }; } catch { /* fall through */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) return { value: JSON.parse(s.slice(a, b + 1)), note: 'extracted outermost {...} from surrounding text' };
  throw new Error('no JSON object found');
}

// ---------- pdf ----------
async function pdfStats(pdfPath: string) {
  const ext = { top: -Infinity, bottom: Infinity, H: 0 };
  const pagerender = (pd: any) =>
    pd.getTextContent().then((tc: any) => {
      ext.H = pd.getViewport(1.0).height;
      let s = '';
      for (const it of tc.items) {
        if (!String(it.str).trim()) continue;
        const y = it.transform[5];
        ext.bottom = Math.min(ext.bottom, y);
        ext.top = Math.max(ext.top, y + (it.height || 0));
        s += it.str + ' ';
      }
      return s;
    });
  const data = await pdfParse(Uint8Array.from(readFileSync(pdfPath)), { pagerender });
  const fill = ext.H && isFinite(ext.top) && isFinite(ext.bottom) ? (ext.top - ext.bottom) / ext.H : null;
  return { pages: data.numpages as number, fillRatio: fill, bottomGapRatio: ext.H && isFinite(ext.bottom) ? ext.bottom / ext.H : null };
}

// ---------- per-file analysis ----------
export async function analyze(file: string, system: string, jobIdRaw: string, base: Json, doRender: boolean) {
  const nulls: Record<string, string> = {};
  const rec: Record<string, any> = { system, jobId: jobIdRaw, file: path.basename(file) };
  const job = JOBS.find(j => j.id === jobIdRaw || j.id.replace(':', '_') === jobIdRaw);
  rec.jobId = job?.id ?? jobIdRaw;

  let t: Json = null;
  try {
    const p = parseLoose(readFileSync(file, 'utf8'));
    t = p.value;
    if (p.note) rec.parseNote = p.note;
    if (t && typeof t === 'object' && !Array.isArray(t) && t.resume_json && typeof t.resume_json === 'object' && !t.experience) {
      t = t.resume_json;
      rec.parseNote = [rec.parseNote, 'unwrapped {"resume_json": ...} wrapper'].filter(Boolean).join('; ');
    }
    rec.jsonValid = t !== null && typeof t === 'object' && !Array.isArray(t);
    if (!rec.jsonValid) nulls.jsonValid = 'parsed but not a JSON object';
  } catch (e: any) {
    rec.jsonValid = false;
    rec.jsonError = String(e?.message ?? e);
  }

  const baseKeys = Object.keys(base).sort();
  if (rec.jsonValid) {
    const k = Object.keys(t).sort();
    rec.schemaKeysMatch = JSON.stringify(k) === JSON.stringify(baseKeys);
    rec.keysMissing = baseKeys.filter(x => !k.includes(x));
    rec.keysExtra = k.filter(x => !baseKeys.includes(x));
    rec.experienceKeysMatch = (Array.isArray(t.experience) ? t.experience : []).every((e: any) => JSON.stringify(Object.keys(e ?? {}).sort()) === JSON.stringify(Object.keys(base.experience[0]).sort()));
  } else {
    rec.schemaKeysMatch = false;
  }

  if (rec.jsonValid) {
    try {
      const f = checkFacts(base, t);
      rec.factsVerdict = f.verdict;
      rec.invented = f.invented;
    } catch (e: any) {
      rec.factsVerdict = null; rec.invented = null;
      nulls.factsVerdict = `checkFacts threw: ${e?.message ?? e}`;
    }
    try {
      const v2 = checkResume(base, t, { jobDescription: job?.description, jobTitle: job?.title });
      rec.factsV2Verdict = v2.verdict;
      rec.factsV2Blocks = [...v2.invented, ...v2.unsupported, ...v2.forbidden.map((p) => `forbidden:${p}`)];
      rec.factsV2Warnings = v2.warnings;
    } catch (e: any) {
      rec.factsV2Verdict = null;
      nulls.factsV2Verdict = `checkResume threw: ${e?.message ?? e}`;
    }
  } else {
    rec.factsVerdict = null; rec.invented = null;
    nulls.factsVerdict = 'not computed: JSON invalid';
  }

  // Render (sequential, ~10s each). renderResumeChecked (maxTrims: 0, so overflow is measured, not hidden) re-runs the v2 fact gate and verifyPdf (1 page, name/email/phone text).
  rec.rendered = null; rec.pages = null; rec.fillRatio = null; rec.bottomGapRatio = null; rec.renderError = null;
  if (!rec.jsonValid || rec.factsVerdict !== 'pass') {
    nulls.rendered = !rec.jsonValid ? 'skipped: JSON invalid' : 'skipped: failed checkFacts';
    nulls.pages = nulls.fillRatio = nulls.rendered;
  } else if (!doRender) {
    nulls.rendered = 'skipped: --no-render';
    nulls.pages = nulls.fillRatio = nulls.rendered;
  } else {
    try {
      const pdf = (await renderResumeChecked(t, { maxTrims: 0 })).pdfPath;
      rec.rendered = true;
      const st = await pdfStats(pdf);
      rec.pages = st.pages;
      rec.fillRatio = st.fillRatio;
      rec.bottomGapRatio = st.bottomGapRatio;
      if (st.fillRatio == null) nulls.fillRatio = 'could not read text extents from PDF';
    } catch (e: any) {
      rec.rendered = false;
      rec.renderError = String(e?.message ?? e).slice(0, 400);
      const m = /expected 1 pages, got (\d+)/.exec(rec.renderError);
      rec.pages = m ? Number(m[1]) : null;
      if (!m) nulls.pages = 'render failed before page count was known';
      nulls.fillRatio = 'render failed, no PDF returned by renderResumeChecked';
    }
  }

  // Keyword coverage
  if (rec.jsonValid && job) {
    const c = coverage(t, job.mustHaveKeywords);
    const cb = coverage(base, job.mustHaveKeywords);
    rec.keywordCoverage = c.value;
    rec.keywordCoverageBase = cb.value;
    rec.keywordLift = c.value - cb.value;
    rec.keywordsMissing = c.missing;
  } else {
    rec.keywordCoverage = rec.keywordCoverageBase = rec.keywordLift = null;
    nulls.keywordCoverage = !job ? `job id ${jobIdRaw} not in jobs.json` : 'JSON invalid';
  }

  // Hygiene + diff
  if (rec.jsonValid) {
    const bl = bulletsOf(t);
    const sw = typeof t.summary === 'string' ? words(t.summary).length : null;
    const starts = bl.map(startWord);
    const counts = new Map<string, number>();
    starts.forEach(s => s && counts.set(s, (counts.get(s) ?? 0) + 1));
    const allText = strings(t).join('\n');
    const bulletText = bl.join('\n');
    const slop = slopHits(`${t.summary ?? ''}\n${bulletText}`);
    rec.hygiene = {
      dashesInBullets: dashCount(bulletText),
      dashesInSummary: typeof t.summary === 'string' ? dashCount(t.summary) : null,
      dashesAnywhere: dashCount(allText),
      slopWordCount: Object.values(slop).reduce((a, b) => a + b, 0),
      slopWords: slop,
      bulletCount: bl.length,
      meanBulletWords: bl.length ? bl.reduce((a, b) => a + words(b).length, 0) / bl.length : null,
      pctActionVerbStart: bl.length ? starts.filter(isVerb).length / bl.length : null,
      pctBulletsWithNumber: bl.length ? bl.filter(b => /\d/.test(b)).length / bl.length : null,
      repeatedStartVerbBullets: [...counts.values()].reduce((a, n) => a + (n > 1 ? n - 1 : 0), 0),
      startVerbsUsedOver2Times: [...counts.values()].filter(n => n > 2).length,
      summaryWords: sw,
      totalWords: words(`${t.summary ?? ''} ${bulletText} ${(t.skills ?? []).flatMap((s: any) => s?.items ?? []).join(' ')}`).length,
      actionVerbMethod: 'first word in ~190-verb list, or any >4-letter word ending in -ed (minus a small non-verb stoplist)',
    };
    if (!bl.length) nulls.bulletStats = 'no experience bullets found';
    if (sw == null) nulls.summaryWords = 'summary missing or not a string';
    rec.diffVsBase = diffVsBase(base, t);
  } else {
    rec.hygiene = null; rec.diffVsBase = null;
    nulls.hygiene = nulls.diffVsBase = 'JSON invalid';
  }
  rec.nulls = nulls;
  return rec;
}

// ---------- summary ----------
const mean = (xs: Array<number | null | undefined>) => {
  const v = xs.filter((x): x is number => typeof x === 'number' && isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const rate = (xs: Array<boolean | null | undefined>) => mean(xs.map(x => (x == null ? null : x ? 1 : 0)));
const fmt = (x: number | null, d = 2) => (x == null ? 'n/a' : x.toFixed(d));
const pct = (x: number | null) => (x == null ? 'n/a' : (100 * x).toFixed(0) + '%');

function summarize(recs: any[], missingBy: Record<string, string[]>): string {
  const systems = [...new Set(recs.map(r => r.system))].sort();
  const rows: Array<[string, (rs: any[]) => string]> = [
    ['files (missing)', rs => `${rs.length}`],
    ['jsonValid', rs => pct(rate(rs.map(r => r.jsonValid)))],
    ['schemaKeysMatch', rs => pct(rate(rs.map(r => r.schemaKeysMatch)))],
    ['checkFacts pass', rs => pct(rate(rs.map(r => (r.factsVerdict == null ? null : r.factsVerdict === 'pass'))))],
    ['checkResume v2 not blocked', rs => pct(rate(rs.map(r => (r.factsV2Verdict == null ? null : r.factsV2Verdict !== 'block'))))],
    ['rendered OK (of attempted)', rs => pct(rate(rs.map(r => r.rendered)))],
    ['exactly 1 page (of known)', rs => pct(rate(rs.map(r => (r.pages == null ? null : r.pages === 1))))],
    ['fillRatio (text extent / page)', rs => fmt(mean(rs.map(r => r.fillRatio)))],
    ['keywordCoverage', rs => pct(mean(rs.map(r => r.keywordCoverage)))],
    ['keywordCoverageBase (untailored)', rs => pct(mean(rs.map(r => r.keywordCoverageBase)))],
    ['keyword lift (pp)', rs => { const m = mean(rs.map(r => r.keywordLift)); return m == null ? 'n/a' : (100 * m).toFixed(1); }],
    ['dashes in bullets', rs => fmt(mean(rs.map(r => r.hygiene?.dashesInBullets)))],
    ['slop words', rs => fmt(mean(rs.map(r => r.hygiene?.slopWordCount)))],
    ['bullet count', rs => fmt(mean(rs.map(r => r.hygiene?.bulletCount)), 1)],
    ['mean bullet words', rs => fmt(mean(rs.map(r => r.hygiene?.meanBulletWords)), 1)],
    ['% bullets action-verb start', rs => pct(mean(rs.map(r => r.hygiene?.pctActionVerbStart)))],
    ['% bullets with number', rs => pct(mean(rs.map(r => r.hygiene?.pctBulletsWithNumber)))],
    ['repeated start verbs', rs => fmt(mean(rs.map(r => r.hygiene?.repeatedStartVerbBullets)), 1)],
    ['summary words', rs => fmt(mean(rs.map(r => r.hygiene?.summaryWords)), 1)],
    ['total words', rs => fmt(mean(rs.map(r => r.hygiene?.totalWords)), 0)],
    ['bullets unchanged', rs => fmt(mean(rs.map(r => r.diffVsBase?.bulletsUnchanged)), 1)],
    ['bullets reworded', rs => fmt(mean(rs.map(r => r.diffVsBase?.bulletsReworded)), 1)],
    ['bullets new', rs => fmt(mean(rs.map(r => r.diffVsBase?.bulletsNew)), 1)],
    ['base bullets dropped', rs => fmt(mean(rs.map(r => r.diffVsBase?.baseBulletsDropped)), 1)],
  ];
  const head = `| metric (mean over jobs) | ${systems.join(' | ')} |\n|---|${systems.map(() => '---').join('|')}|`;
  const body = rows.map(([name, f]) => {
    const cells = systems.map(s => {
      const rs = recs.filter(r => r.system === s);
      const v = f(rs);
      return name === 'files (missing)' ? `${v} (${missingBy[s]?.length ?? 0})` : v;
    });
    return `| ${name} | ${cells.join(' | ')} |`;
  });
  const jobsSeen = [...new Set(recs.map(r => r.jobId))];
  const kw = [`| keywordCoverage by job | ${systems.join(' | ')} | base |`, `|---|${systems.map(() => '---').join('|')}|---|`];
  for (const j of jobsSeen) {
    const cells = systems.map(s => { const r = recs.find(x => x.system === s && x.jobId === j); return r ? pct(r.keywordCoverage) : '-'; });
    const any = recs.find(x => x.jobId === j);
    kw.push(`| ${j} | ${cells.join(' | ')} | ${pct(any?.keywordCoverageBase ?? null)} |`);
  }
  const miss = Object.entries(missingBy).filter(([, v]) => v.length).map(([s, v]) => `- system ${s} missing: ${v.join(', ')}`);
  return [head, ...body, '', ...kw, '', ...(miss.length ? ['Missing result files:', ...miss, ''] : [])].join('\n');
}

// ---------- driver ----------
async function runDir(dir: string, doRender: boolean) {
  const base = JSON.parse(readFileSync(path.join(EVAL_DIR, 'fixtures', 'base-resume.json'), 'utf8'));
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  const recs: any[] = [];
  for (const f of files) {
    const m = /^(?:system-)?([A-Za-z0-9]+)-(.+)\.json$/.exec(f);
    if (!m) { console.error(`[skip] ${f}: name does not match <system>-<jobId>.json`); continue; }
    const rec = await analyze(path.join(dir, f), m[1], m[2], base, doRender);
    recs.push(rec);
    console.log(JSON.stringify(rec));
  }
  const missingBy: Record<string, string[]> = {};
  for (const s of new Set(recs.map(r => r.system))) {
    missingBy[s] = JOBS.filter(j => !recs.some(r => r.system === s && r.jobId === j.id)).map(j => j.id);
  }
  const md = summarize(recs, missingBy);
  console.log('\n' + md);
  writeFileSync(path.join(dir, 'metrics.jsonl'), recs.map(r => JSON.stringify(r)).join('\n') + '\n');
  writeFileSync(path.join(dir, 'summary.md'), md + '\n');
  return recs;
}

async function selfTest() {
  const base = JSON.parse(readFileSync(path.join(EVAL_DIR, 'fixtures', 'base-resume.json'), 'utf8'));
  let failed = 0;
  const check = (name: string, ok: boolean, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`); if (!ok) failed++; };
  const dir = path.join(EVAL_DIR, 'runs', 'selftest');
  mkdirSync(dir, { recursive: true });
  const j0 = JOBS[0];
  const safe = (id: string) => id.replace(':', '_');

  // 1) base resume as system BASE (rendered once, real run)
  writeFileSync(path.join(dir, `BASE-${safe(j0.id)}.json`), JSON.stringify(base, null, 2));
  // 2) in-memory negative/hygiene controls (no render)
  const bad = JSON.parse(JSON.stringify(base));
  bad.experience[0].description[1] = bad.experience[0].description[1].replace('70%', '75%');
  bad.summary = 'Passionate engineer — leveraged robust systems.';
  bad.experience[0].description[0] = 'Leveraged seamless tooling — shipped it.';
  writeFileSync(path.join(dir, `BAD-${safe(j0.id)}.json`), '```json\n' + JSON.stringify(bad) + '\n```\n');

  const recs = await runDir(dir, true);
  const b = recs.find(r => r.system === 'BASE')!;
  const x = recs.find(r => r.system === 'BAD')!;
  console.log('');
  check('BASE jsonValid', b.jsonValid === true);
  check('BASE schemaKeysMatch', b.schemaKeysMatch === true);
  check('BASE factsVerdict pass', b.factsVerdict === 'pass', JSON.stringify(b.invented));
  check('BASE diff: all bullets unchanged', b.diffVsBase?.bulletsUnchanged === b.diffVsBase?.baseBullets && b.diffVsBase?.bulletsNew === 0);
  check('BASE keywordLift == 0', b.keywordLift === 0);
  check('BAD fenced JSON tolerated', x.jsonValid === true && x.parseNote === 'code fence stripped');
  check('BAD factsVerdict block (invented 75%)', x.factsVerdict === 'block' && (x.invented ?? []).some((s: string) => s.includes('75')), JSON.stringify(x.invented));
  check('BAD not rendered (skipped on facts)', x.rendered === null && /failed checkFacts/.test(x.nulls.rendered ?? ''));
  check('BAD em dashes counted (bullets>=1, summary>=1)', x.hygiene.dashesInBullets >= 1 && x.hygiene.dashesInSummary >= 1);
  check('BAD slop words counted (>=4)', x.hygiene.slopWordCount >= 4, JSON.stringify(x.hygiene.slopWords));
  check('keyword normaliser: Node.js/NodeJS/golang/Postgres', coverage({ s: 'Built with NodeJS, Golang and PostgreSQL' }, ['Node.js', 'Go', 'Postgres']).value === 1);
  console.log(`\nINFO  BASE render: rendered=${b.rendered} pages=${b.pages} fillRatio=${b.fillRatio == null ? null : b.fillRatio.toFixed(2)} err=${b.renderError ?? '-'}`);
  console.log(failed ? `\nSELFTEST FAILED (${failed})` : '\nSELFTEST PASS');
  process.exit(failed ? 1 : 0);
}

const args = process.argv.slice(2);
if (args.includes('--selftest')) await selfTest();
else if (!args.length || args[0].startsWith('--')) {
  console.error('usage: npm run eval:metrics -- <results-dir> [--no-render]   |   --selftest');
  process.exit(2);
} else {
  if (!existsSync(args[0])) { console.error(`results dir not found: ${args[0]}`); process.exit(2); }
  await runDir(args[0], !args.includes('--no-render'));
}
