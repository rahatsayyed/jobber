// Owner CLI for the questions an application form asked that nothing reliable could answer (apply_questions).
//   npm run answers -- list [--all]
//   npm run answers -- answer <id> "<text>" [--always]
//   npm run answers -- skip <id>
// `once` (the default) applies to that question's job(s) only. `--always` also stores the answer in user-data/easy-apply-answers.json
// (`custom`, keyed by the normalized question) so every later form with the same question reuses it. An answer goes through the same gates
// as other outbound text: the shape check (non-empty, within the field's maxlength, one of the listed options), the output gate (no
// link, address, path or secret that is not already in your resume) and, for a free-text answer, the fact gate against the base resume.
// Answering puts the paused job back in the apply queue; the next apply stage retries it. The agent never runs this.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { loadAnswerBook, saveCustomAnswer } from '../src/apply/answers.js';
import { checkAnswerShape, getQuestion, listQuestions, markAnswered, markSkipped } from '../src/apply/questions.js';
import { gateOutbound, secretValuesFromEnv } from '../src/safety/outputGate.js';
import { checkTextWithNormalized } from '../src/resumeFacts.js';
import { getBaseResume } from '../src/resume.js';
import { userDataPath } from '../src/lib/userData.js';

export interface CliDeps {
  db?: BetterSqlite3.Database;
  now?: () => Date;
  answersPath?: string;
  profilePath?: string;
  /** Test seam: the base resume the fact gate checks against. */
  baseResume?: () => Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}

const USAGE = 'usage: npm run answers -- list [--all] | answer <id> "<text>" [--always] | skip <id>';
/** A free-text answer (five words or more) is fact-checked against the resume like an email; short values (a city, a number) are not claims. */
const FREE_TEXT_WORDS = 5;

function allowedFrom(resume: Record<string, unknown>): { urls: string[]; emails: string[] } {
  const urls: string[] = [];
  const emails: string[] = [];
  const web = (resume.website as { url?: unknown } | undefined)?.url;
  if (typeof web === 'string') urls.push(web);
  const social = resume.social as Record<string, { url?: unknown }> | undefined;
  for (const v of Object.values(social ?? {})) if (typeof v?.url === 'string') urls.push(v.url);
  if (typeof resume.email === 'string') emails.push(resume.email);
  return { urls, emails };
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<{ code: number; lines: string[] }> {
  const [cmd, ...rest] = argv;
  const now = deps.now ?? (() => new Date());
  const env = deps.env ?? process.env;
  if (!cmd || !['list', 'answer', 'skip'].includes(cmd)) return { code: 2, lines: [USAGE] };
  const db = deps.db ?? openDb(dbPath());
  try {
    if (cmd === 'list') {
      const rows = listQuestions(db, { status: rest.includes('--all') ? 'all' : 'open' });
      if (!rows.length) return { code: 0, lines: ['no open questions'] };
      const lines = [`${rows.length} question(s)${rest.includes('--all') ? '' : ' need your answer'}:`];
      for (const q of rows) {
        const opts = q.options.length ? `  options: ${q.options.join(' | ')}` : '';
        const lim = q.max_length ? `  max ${q.max_length} chars` : '';
        lines.push(`#${q.id} [${q.status}] ${q.host} (${q.kind}, ${q.job_ids.length} job${q.job_ids.length === 1 ? '' : 's'}): ${q.label}${opts}${lim}`);
        if (q.status === 'open') lines.push(`    npm run answers -- answer ${q.id} "<text>" [--always]    or    npm run answers -- skip ${q.id}`);
        else if (q.answer !== null) lines.push(`    answered (${q.answer_scope}) ${q.answered_at ?? ''}`);
      }
      return { code: 0, lines };
    }

    const idArg = rest.find((a) => !a.startsWith('--'));
    const id = Number(idArg);
    if (!Number.isInteger(id) || id <= 0) return { code: 2, lines: [USAGE] };
    const q = getQuestion(db, id);
    if (!q) return { code: 1, lines: [`no question #${id}`] };
    if (q.status !== 'open') return { code: 1, lines: [`question #${id} is already ${q.status}`] };

    if (cmd === 'skip') {
      const r = markSkipped(db, id, now());
      return { code: 0, lines: [`skipped #${id}; ${r.jobs.length} job(s) moved to manual_review and the question is not asked again on ${q.host}`] };
    }

    // answer
    const always = rest.includes('--always');
    const text = rest.filter((a) => a !== '--always').slice(1).join(' ');
    const shape = checkAnswerShape(q, text);
    if (!shape.ok) return { code: 1, lines: [`not saved: ${shape.reason}`] };
    const value = shape.value;

    let resume: Record<string, unknown>;
    try { resume = (deps.baseResume ?? getBaseResume)() as Record<string, unknown>; } catch { return { code: 1, lines: ['not saved: the base resume (user-data/resume.json) cannot be read, so the gates cannot run'] }; }
    const allow = allowedFrom(resume);
    const fact = checkTextWithNormalized(value, resume, {});
    const words = value.split(/\s+/).filter(Boolean).length;
    const factVerdict = words >= FREE_TEXT_WORDS ? fact.verdict : 'pass';
    const out = gateOutbound(fact.normalized_text, {
      recipientKey: 'form', expectedRecipientKey: 'form', factVerdict,
      allowedUrls: allow.urls, allowedEmails: allow.emails, secretValues: secretValuesFromEnv(env),
    });
    if (!out.ok) {
      const hint = out.reasons.includes('url_not_allowed') ? ' (a link must already be in user-data/resume.json)' : out.reasons.includes('fact_gate_block') ? ` (claims the resume does not support: ${[...fact.invented, ...fact.unsupported].slice(0, 5).join(', ')}; add the fact to user-data/resume.json first)` : '';
      return { code: 1, lines: [`not saved: the output gate refused this answer: ${out.reasons.join(', ')}${hint}`] };
    }
    const stored = fact.normalized_text.trim();
    const cap = checkAnswerShape(q, stored);
    if (!cap.ok) return { code: 1, lines: [`not saved: ${cap.reason}`] };

    if (always) {
      const book = loadAnswerBook({ answersPath: deps.answersPath, profilePath: deps.profilePath ?? userDataPath('resume.json') });
      const cls = book.suggest(q.label).cls;
      if (cls === 'consent' || cls === 'legal_attestation') return { code: 1, lines: ['not saved: consent and attestation questions are never answered from a book; answer them by hand on the form'] };
      saveCustomAnswer(q.label, cap.value, deps.answersPath);
    }
    const r = markAnswered(db, id, cap.value, always ? 'always' : 'once', now());
    return {
      code: 0,
      lines: [
        `saved #${id} (${always ? 'always: stored in user-data/easy-apply-answers.json' : 'once: this job only'})${r.answered.length > 1 ? `; also answered ${r.answered.length - 1} other open question(s) with the same wording` : ''}`,
        r.released.length ? `${r.released.length} job(s) are back in the apply queue; the next apply stage retries them` : 'no job is released yet: other questions of the job are still open',
      ],
    };
  } finally {
    if (!deps.db) db.close();
  }
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(process.argv.slice(2)).then((r) => { for (const l of r.lines) console.log(l); process.exit(r.code); }, () => { console.error('answers failed'); process.exit(1); });
}
