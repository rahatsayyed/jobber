// file: src/roleGate.ts
// Deterministic ROLE GATE: is this job's TITLE a role family the owner targets? Runs in code before the matcher (so a wrong
// role costs no model call) and again inside gates.apply_vetoes (so manual and already-matched jobs pass the same gate).
// Config: config/role-families.json. The built-in defaults below are used when the file is missing; an invalid file also falls
// back to them and the caller shows a flag (never a silent skip).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';

export const ROLE_MISMATCH_STATUS = 'role_mismatch';
export const ROLE_REASON_PREFIX = 'role: ';
const HIRING_POST_PREFIX = 'Hiring post by ';

export interface FamilyRule { family: string; patterns: string[]; needs_not?: string[]; requires_signal?: boolean; note?: string }
export interface RoleGateConfig {
  deny: string[];
  deny_intern: string[];
  allow_intern: boolean;
  pay_model_phrases: string[];
  allow: FamilyRule[];
  borderline: FamilyRule[];
  signal_patterns: string[];
}

export type RoleGateResult =
  | { verdict: 'pass'; family: string }
  | { verdict: 'borderline'; family: string; note: string }
  | { verdict: 'reject'; reason: string };

const DEFAULTS: RoleGateConfig = {
  deny: ['reviewers?', 'evaluators?', 'raters?', 'annotators?', 'annotation', 'labell?ers?', 'tutors?', 'trainers?', 'coach(?:es)?', 'qa', 'quality assurance', 'tests?', 'testers?', 'testing', 'sdet', 'sales', 'recruiters?', 'recruiting', 'talent acquisition', 'designers?', 'data entry', 'content', 'writers?', 'support', 'unpaid', 'volunteers?', 'freelance', 'per[- ]task', 'gig', 'crowd'],
  deny_intern: ['interns?', 'internship', 'trainee'],
  allow_intern: false,
  pay_model_phrases: ['per task', 'per-task', 'per approved task', 'paid per task', 'pay per task', 'gig work', 'crowd work'],
  allow: [
    { family: 'full-stack', patterns: ['full[- ]?stack', '\\bmern\\b', '\\bmean\\b stack'] },
    { family: 'frontend', patterns: ['front[- ]?end', '\\bui (?:engineer|developer)', 'user interface (?:engineer|developer)'] },
    { family: 'react', patterns: ['\\breact(?:[ .]?js)?\\b'], needs_not: ['react native'] },
    { family: 'javascript', patterns: ['javascript', 'typescript', '(?<![.\\w])js (?:developer|engineer)', '(?<![.\\w])ts (?:developer|engineer)'] },
    { family: 'web', patterns: ['web (?:developer|engineer|application developer)'] },
    { family: 'software', patterns: ['software (?:development )?(?:developer|engineer)', 'software development', '\\bsde\\b(?: ?(?:i|ii|iii|1|2|3))?', 'application developer', 'programmer'] },
  ],
  borderline: [
    { family: 'react-native', patterns: ['react[- ]native'], note: 'React Native is mobile' },
    { family: 'backend', patterns: ['back[- ]?end', '\\bnode(?:[ .]?js)?\\b', '\\bexpress(?:[ .]?js)?\\b'], requires_signal: true, note: 'backend or node role' },
    { family: 'generic', patterns: ['^\\W*(?:(?:senior|sr\\.?|junior|jr\\.?|lead|principal|staff|associate|mid|[ivx]+|\\d+)\\W+)*(?:developer|engineer|programmer)\\W*$'], note: 'bare Developer or Engineer title' },
  ],
  signal_patterns: ['full[- ]?stack', 'javascript', 'typescript', '\\bnode(?:[ .]?js)?\\b', '\\breact(?:[ .]?js)?\\b', '\\bmern\\b'],
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const roleFamiliesPath = path.join(path.resolve(__dirname, '..'), 'config', 'role-families.json');

const strList = (v: unknown, name: string): string[] => {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !x.trim())) throw new Error(`${name} must be a list of non-empty strings`);
  return (v as string[]).map((x) => x.trim());
};
const rules = (v: unknown, name: string): FamilyRule[] => {
  if (!Array.isArray(v)) throw new Error(`${name} must be a list`);
  return v.map((r: any, i) => {
    if (!r || typeof r.family !== 'string' || !r.family.trim()) throw new Error(`${name}[${i}].family missing`);
    return {
      family: r.family.trim(), patterns: strList(r.patterns, `${name}[${i}].patterns`),
      ...(r.needs_not !== undefined ? { needs_not: strList(r.needs_not, `${name}[${i}].needs_not`) } : {}),
      ...(r.requires_signal === true ? { requires_signal: true } : {}),
      ...(typeof r.note === 'string' ? { note: r.note } : {}),
    };
  });
};

/** Parse and validate a config object (throws a short reason when it is wrong, including a pattern that is not a valid regular expression). */
export function parseRoleGateConfig(raw: unknown): RoleGateConfig {
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object') throw new Error('not an object');
  const cfg: RoleGateConfig = {
    deny: strList(o.deny, 'deny'),
    deny_intern: strList(o.deny_intern ?? DEFAULTS.deny_intern, 'deny_intern'),
    allow_intern: o.allow_intern === true,
    pay_model_phrases: strList(o.pay_model_phrases ?? [], 'pay_model_phrases'),
    allow: rules(o.allow, 'allow'),
    borderline: rules(o.borderline ?? [], 'borderline'),
    signal_patterns: strList(o.signal_patterns ?? DEFAULTS.signal_patterns, 'signal_patterns'),
  };
  if (!cfg.allow.length) throw new Error('allow must not be empty');
  compile(cfg); // throws on a bad regular expression
  return cfg;
}

export interface RoleGateStatus { config: RoleGateConfig; source: 'file' | 'default'; invalid?: string }

/** Load config/role-families.json. Missing file = built-in defaults. Invalid file = built-in defaults plus `invalid` (callers show a flag). */
export function loadRoleGateConfig(file: string = roleFamiliesPath): RoleGateStatus {
  if (!existsSync(file)) return { config: DEFAULTS, source: 'default' };
  try {
    return { config: parseRoleGateConfig(JSON.parse(readFileSync(file, 'utf8'))), source: 'file' };
  } catch (e) {
    return { config: DEFAULTS, source: 'default', invalid: (e as Error).message.slice(0, 160) };
  }
}

interface Compiled {
  deny: RegExp; denyIntern: RegExp | null; pay: RegExp | null; signal: RegExp;
  allow: Array<{ rule: FamilyRule; re: RegExp[]; not: RegExp[] }>;
  borderline: Array<{ rule: FamilyRule; re: RegExp[]; not: RegExp[] }>;
}
const cache = new WeakMap<RoleGateConfig, Compiled>();

function compile(cfg: RoleGateConfig): Compiled {
  const hit = cache.get(cfg);
  if (hit) return hit;
  const rx = (p: string) => new RegExp(p, 'i');
  const word = (xs: string[]) => new RegExp(`(?<![a-z0-9])(?:${xs.join('|')})(?![a-z0-9])`, 'i');
  const fam = (rs: FamilyRule[]) => rs.map((rule) => ({ rule, re: rule.patterns.map(rx), not: (rule.needs_not ?? []).map(rx) }));
  const c: Compiled = {
    deny: word(cfg.deny),
    denyIntern: cfg.allow_intern || !cfg.deny_intern.length ? null : word(cfg.deny_intern),
    pay: cfg.pay_model_phrases.length ? new RegExp(cfg.pay_model_phrases.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null,
    signal: new RegExp(cfg.signal_patterns.join('|'), 'i'),
    allow: fam(cfg.allow), borderline: fam(cfg.borderline),
  };
  cache.set(cfg, c);
  return c;
}

const normTitle = (t: string): string => t.normalize('NFKC').replace(/[‐-―]/g, '-').replace(/\s+/g, ' ').trim();

/**
 * Judge a job by title (and, for the pay-model phrases and the backend signal, the posting text).
 * `description` is optional: without it only the title decides. Never throws.
 */
export function checkRole(job: { title?: string | null; description?: string | null }, cfg: RoleGateConfig = DEFAULTS): RoleGateResult {
  const title = normTitle(String(job.title ?? ''));
  // A LinkedIn hiring post has no real title (the role is in the post text): it cannot be judged here, so the matcher is told to be strict.
  if (!title || title.startsWith(HIRING_POST_PREFIX)) return { verdict: 'borderline', family: 'unjudged', note: 'no usable title (hiring post)' };
  const c = compile(cfg);
  const deny = c.deny.exec(title) ?? c.denyIntern?.exec(title) ?? null;
  if (deny) return { verdict: 'reject', reason: `${ROLE_REASON_PREFIX}${deny[0].toLowerCase()}` };
  const desc = String(job.description ?? '').slice(0, 20000);
  const pay = c.pay?.exec(`${title}\n${desc}`);
  if (pay) return { verdict: 'reject', reason: `${ROLE_REASON_PREFIX}pay model "${pay[0].toLowerCase()}"` };
  const match = (list: Compiled['allow']) => list.find((f) => f.re.some((r) => r.test(title)) && !f.not.some((r) => r.test(title)));
  const ok = match(c.allow);
  if (ok) return { verdict: 'pass', family: ok.rule.family };
  const border = match(c.borderline);
  if (border) {
    if (border.rule.requires_signal && !c.signal.test(`${title}\n${desc}`)) {
      return { verdict: 'reject', reason: `${ROLE_REASON_PREFIX}${border.rule.family} without a javascript, react or full-stack signal` };
    }
    return { verdict: 'borderline', family: border.rule.family, note: border.rule.note ?? border.rule.family };
  }
  return { verdict: 'reject', reason: `${ROLE_REASON_PREFIX}no target role family` };
}

export interface RoleSweepOpts {
  cfg?: RoleGateConfig;
  /** Unscored jobs created (or JD-fetched) at or after this SQLite time are judged; priority jobs always are. */
  windowStart: string;
  /** Matched jobs (score at or above) without a queue row are judged too. Omit to skip them. */
  matchThreshold?: number;
  /** Report only, change nothing. */
  dry?: boolean;
}
export interface RoleSweepRow { job_id: string; title: string; company: string; reason: string }

/**
 * Marks jobs that fail the role gate: jobs.status = 'role_mismatch' and excluded_reason = 'role: <word>'. Every consumer already skips
 * a job with an excluded_reason (the lists, the mail and LinkedIn drips, apply), so the matcher never sees it. Considers only jobs
 * with no queue row, no send, no connection and no application, and never one the owner un-excluded with /include (job_exclusion_log).
 */
export function sweepRoleGate(db: BetterSqlite3.Database, o: RoleSweepOpts): RoleSweepRow[] {
  const cfg = o.cfg ?? DEFAULTS;
  const rows = db.prepare(
    `SELECT id, title, company, description FROM jobs
      WHERE excluded_reason IS NULL AND COALESCE(status, '') <> '${ROLE_MISMATCH_STATUS}'
        AND NOT EXISTS (SELECT 1 FROM job_exclusion_log l WHERE l.job_id = jobs.id)
        AND NOT EXISTS (SELECT 1 FROM outreach_queue q WHERE q.job_id = jobs.id AND COALESCE(q.status, '') NOT IN ('skipped'))
        AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = jobs.id)
        AND NOT EXISTS (SELECT 1 FROM connections c WHERE c.job_id = jobs.id)
        AND NOT EXISTS (SELECT 1 FROM outreach o WHERE o.job_id = jobs.id)
        AND ((score IS NULL AND (priority > 0 OR created_at >= ? OR COALESCE(jd_fetched_at, '') >= ?))
             OR (? IS NOT NULL AND score >= ?))`,
  ).all(o.windowStart, o.windowStart, o.matchThreshold ?? null, o.matchThreshold ?? null) as Array<{ id: string; title: string | null; company: string | null; description: string | null }>;
  const out: RoleSweepRow[] = [];
  for (const r of rows) {
    const v = checkRole({ title: r.title, description: r.description }, cfg);
    if (v.verdict === 'reject') out.push({ job_id: r.id, title: r.title ?? '', company: r.company ?? '', reason: v.reason });
  }
  if (!o.dry && out.length) {
    const upd = db.prepare(`UPDATE jobs SET excluded_reason = ?, status = '${ROLE_MISMATCH_STATUS}' WHERE id = ? AND excluded_reason IS NULL`);
    db.transaction(() => { for (const r of out) upd.run(r.reason, r.job_id); })();
  }
  return out;
}
