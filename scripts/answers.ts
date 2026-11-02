// Owner CLI for the questions an application form asked that nothing reliable could answer (apply_questions).
//   npm run answers -- list [--all]
//   npm run answers -- answer <id> "<text>" [--always] [--comment "<note>"]
//   npm run answers -- agent <id> [--comment "<guidance>"]     (let the agent draft it; free-text motivational questions only)
//   npm run answers -- skip <id> [--comment "<note>"]          (I applied by hand / skip)
// `once` (the default) applies to that question's job(s) only. `--always` also stores the answer in user-data/easy-apply-answers.json
// (`custom`, keyed by the normalized question) so every later form with the same question reuses it. An answer goes through the same gates
// as other outbound text (src/apply/answerService.ts): the shape check, the output gate and, for five words or more, the fact gate.
// `agent` only records the choice: the question stays unanswered (the applier never guesses) until the drafting task exists.
// Answering puts the paused job back in the apply queue; the next apply stage retries it. The agent never runs this.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { submitAnswer, type AnswerDeps } from '../src/apply/answerService.js';
import { getQuestion, markAgentHandle, markSkipped } from '../src/apply/questions.js';
import { groupedQuestions, renderJobGroup } from '../src/apply/questionInbox.js';

export interface CliDeps extends AnswerDeps {
  db?: BetterSqlite3.Database;
}

const USAGE = 'usage: npm run answers -- list [--all] | answer <id> "<text>" [--always] [--comment "<note>"] | agent <id> [--comment "<guidance>"] | skip <id> [--comment "<note>"]';

/** Pulls `--comment <text>` out of the arguments (the text is the next argument). */
function takeComment(args: string[]): { rest: string[]; comment: string | null; bad: boolean } {
  const i = args.indexOf('--comment');
  if (i < 0) return { rest: args, comment: null, bad: false };
  const text = args[i + 1];
  if (text === undefined || text.startsWith('--')) return { rest: args, comment: null, bad: true };
  return { rest: [...args.slice(0, i), ...args.slice(i + 2)], comment: text, bad: false };
}

export async function run(argv: string[], deps: CliDeps = {}): Promise<{ code: number; lines: string[] }> {
  const [cmd, ...args] = argv;
  const now = deps.now ?? (() => new Date());
  if (!cmd || !['list', 'answer', 'skip', 'agent'].includes(cmd)) return { code: 2, lines: [USAGE] };
  const db = deps.db ?? openDb(dbPath());
  try {
    if (cmd === 'list') {
      const all = args.includes('--all');
      const groups = groupedQuestions(db, { status: all ? 'all' : 'open', now: now() });
      if (!groups.length) return { code: 0, lines: ['no open questions'] };
      const n = groups.reduce((s, g) => s + g.questions.length, 0);
      const lines = [`${n} question(s) in ${groups.length} job(s)${all ? '' : ' need your answer'}:`];
      for (const g of groups) lines.push('', ...renderJobGroup(g));
      return { code: 0, lines };
    }

    const { rest, comment, bad } = takeComment(args);
    if (bad) return { code: 2, lines: [USAGE] };
    const idArg = rest.find((a) => !a.startsWith('--'));
    const id = Number(idArg);
    if (!Number.isInteger(id) || id <= 0) return { code: 2, lines: [USAGE] };
    const q = getQuestion(db, id);
    if (!q) return { code: 1, lines: [`no question #${id}`] };
    if (q.status !== 'open' && q.status !== 'agent_handle') return { code: 1, lines: [`question #${id} is already ${q.status}`] };

    if (cmd === 'skip') {
      const r = markSkipped(db, id, now(), comment);
      return { code: 0, lines: [`skipped #${id}; ${r.jobs.length} job(s) moved to manual_review and the question is not asked again on ${q.host}`] };
    }

    if (cmd === 'agent') {
      try {
        markAgentHandle(db, id, now(), comment);
      } catch (e) {
        return { code: 1, lines: [`not saved: ${e instanceof Error ? e.message.replace(/^not_allowed: /, '') : 'refused'}. Answer it yourself: npm run answers -- answer ${id} "<text>"`] };
      }
      return { code: 0, lines: [`#${id} is left to the agent: it stays unanswered (nothing is guessed) and the job stays paused until the agent drafts it`] };
    }

    // answer
    const always = rest.includes('--always');
    const text = rest.filter((a) => a !== '--always').slice(1).join(' ');
    const r = submitAnswer(db, id, text, { always, comment }, deps);
    if (!r.ok) return { code: 1, lines: [`not saved: ${r.reason}`] };
    return {
      code: 0,
      lines: [
        `saved #${id} (${always ? 'always: stored in user-data/easy-apply-answers.json' : 'once: this job only'})${r.outcome.answered.length > 1 ? `; also answered ${r.outcome.answered.length - 1} other open question(s) with the same wording` : ''}`,
        r.outcome.released.length ? `${r.outcome.released.length} job(s) are back in the apply queue; the next apply stage retries them` : 'no job is released yet: other questions of the job are still open',
      ],
    };
  } finally {
    if (!deps.db) db.close();
  }
}

if (process.env.VITEST !== 'true' && process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run(process.argv.slice(2)).then((r) => { for (const l of r.lines) console.log(l); process.exit(r.code); }, () => { console.error('answers failed'); process.exit(1); });
}
