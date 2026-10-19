import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkResume, type FactReport } from './resumeFacts.js';
import { pdfLayout, verifyPdf } from './pdfVerify.js';
import { joinStatements } from './factClaims.js';
import { resumeStatements } from './proseClaims.js';
import { classifyKeywords, coveragePct, type KeywordResult, type KeywordSpec } from './atsKeywords.js';
import { pickBulletToCut, removeBullet } from './trimResume.js';
import { normalizeForAts } from './atsText.js';
import { missingUserDataMessage, userDataPath } from './lib/userData.js';
import { htmlToPdf } from './pdfRender.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const rendererDir = path.join(projectRoot, 'renderer');

export function getBaseResume(): any {
  const resumePath = userDataPath('resume.json');
  if (!existsSync(resumePath)) throw new Error(missingUserDataMessage('resume.json'));
  return JSON.parse(readFileSync(resumePath, 'utf8'));
}

export { normalizeForAts, normalizeText } from './atsText.js';

export interface RenderOptions { jobDescription?: string; jobTitle?: string; keywords?: KeywordSpec[]; maxTrims?: number }
export interface RenderResult {
  pdfPath: string;
  resume: any;
  facts: FactReport;
  ats: KeywordResult[] | null;
  atsCoverage: number | null;
  trimmed: string[];
  fillRatio: number | null;
}

async function renderOnce(resumeJson: any): Promise<string> {
  const id = randomUUID();
  const outputDir = path.join(rendererDir, 'automation', id);
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, 'resume.json'), JSON.stringify(resumeJson));
  // renderer/index.js writes resume.html; the PDF is printed by headless installed Chrome (src/pdfRender.ts).
  await execFileAsync('node', ['index.js', id], { cwd: rendererDir });
  const pdfPath = path.join(outputDir, 'resume.pdf');
  await htmlToPdf(path.join(outputDir, 'resume.html'), pdfPath);
  if (!existsSync(pdfPath)) throw new Error(`Expected PDF not found at ${pdfPath}`);
  return pdfPath;
}

/** Prose (summary, headline, bullets) and the skills list as separate texts: a skills-list hit must not count as covered (P10). */
const proseText = (r: any) => joinStatements(resumeStatements(r).map((s) => s.text));
const skillsList = (r: any) => (Array.isArray(r?.skills) ? r.skills : []).flatMap((x: any) => (Array.isArray(x?.items) ? x.items : [])).join(', ');

/**
 * ATS-safe text (normalized FIRST) -> fact gate v2 on that same copy -> render -> while >1 page: cut the lowest-relevance bullet (max `maxTrims`, default 6)
 * -> verifyPdf (exactly 1 page, name/email/phone as text; throws otherwise) -> keyword classification over prose + skills list.
 * The last cut is the one that made the page fit, so there is no "restore" pass (P13): `fillRatio` is reported for the caller only.
 */
export async function renderResumeChecked(resumeJson: any, opts: RenderOptions = {}): Promise<RenderResult> {
  const base = getBaseResume();
  // Normalize FIRST, then gate and render the same copy: invisible characters must not split a claim past the gate.
  let current = normalizeForAts(resumeJson);
  const facts = checkResume(base, current, { jobDescription: opts.jobDescription, jobTitle: opts.jobTitle });
  if (facts.verdict === 'block') {
    const claims = [...facts.invented, ...facts.unsupported, ...facts.forbidden.map((p) => `forbidden:${p}`)];
    throw new Error(`Resume fact check failed, refusing to render. Unsupported claims: ${claims.join(', ')}`);
  }
  const keywords = opts.keywords ?? [];
  const cuts: Array<{ exp: number; idx: number; text: string }> = [];
  let pdf = await renderOnce(current);
  let layout = await pdfLayout(pdf);
  while (layout.pages > 1 && cuts.length < (opts.maxTrims ?? 6)) {
    const cut = pickBulletToCut(current, keywords);
    if (!cut) break;
    cuts.push({ ...cut, text: current.experience[cut.exp].description[cut.idx] });
    current = removeBullet(current, cut.exp, cut.idx);
    pdf = await renderOnce(current);
    layout = await pdfLayout(pdf);
  }
  const { name, email, phone } = current ?? {};
  try {
    await verifyPdf(pdf, { pages: 1, mustContain: [name, email].filter(Boolean), digitsContain: [phone].filter(Boolean) });
  } catch (e: any) {
    if (layout.pages > 1) {
      const list = cuts.map((c) => JSON.stringify(String(c.text).slice(0, 60))).join(', ');
      throw new Error(`${e.message} (trimming exhausted after ${cuts.length} trims; cut: ${list || 'none'})`);
    }
    throw e;
  }
  const ats = keywords.length ? classifyKeywords(keywords, proseText(current), proseText(base), skillsList(base)) : null;
  return { pdfPath: pdf, resume: current, facts, ats, atsCoverage: ats ? coveragePct(ats) : null, trimmed: cuts.map((c) => c.text), fillRatio: layout.fillRatio };
}

/** Back-compatible: returns only the PDF path. */
export async function renderResume(resumeJson: any): Promise<string> {
  return (await renderResumeChecked(resumeJson)).pdfPath;
}
