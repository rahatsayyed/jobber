import type BetterSqlite3 from 'better-sqlite3';
import { listSentEmails, recordOutcome, type Outcome } from './db.js';
import { classifyReplyDetail, decideReply, emailAddress, isAutomatedSender, loadRepliesConfig, matchReply, type IncomingMessage, type RepliesConfig } from './replies.js';

export interface TriageResult {
  dry_run: boolean;
  auto_recorded: Array<{ message_id: string; job_id: string; outcome: Outcome; from: string; subject: string }>;
  proposals: Array<{ message_id: string; job_id: string; outcome: Outcome; from: string; subject: string; via: string; confidence: string; reason: string }>;
  bounced: Array<{ message_id: string; job_id: string | null; from: string; subject: string }>;
  ambiguous: Array<{ message_id: string; class: string; candidates: string[] }>;
  unmatched: Array<{ message_id: string; from: string; subject: string; classification: string }>;
  /** Ignored messages (noise, auto-ack, unknown) that matched a job with high or medium confidence: shown to the user, since a real reply may hide here. Also counted in `ignored`. */
  matched_ignored: Array<{ message_id: string; job_id: string; from: string; subject: string; class: string }>;
  ignored: number;
  already_processed: number;
}

/** Reply date -> 'YYYY-MM-DD HH:MM:SS' (UTC), or null when the header is missing or unparseable. */
export function replyDate(date: string | null | undefined): string | null {
  const t = Date.parse(String(date ?? ''));
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

/** Auto-record happens only when decideReply says so (config/replies.json auto_record_enabled, off by default); otherwise the result is a proposal. `dry_run: true` classifies and matches exactly like a real run but writes nothing (no outcomes, no processed_messages rows). */
const OUTCOME_RANK: Record<Outcome, number> = { no_response: 0, replied: 1, interview: 2, rejected: 2, offer: 3, hired: 4 };
/** One ladder for approvals: an outcome may be recorded only when none exists or it ranks strictly higher than the latest one (never a downgrade, never a flip). */
export function raisesOutcome(latest: Outcome | null, proposed: Outcome): boolean {
  return latest === null || OUTCOME_RANK[proposed] > OUTCOME_RANK[latest];
}

const clampStr = (v: unknown, n: number): string => String(v ?? '').slice(0, n);

export function triageReplies(db: BetterSqlite3.Database, messages: IncomingMessage[], opts: { dry_run?: boolean; config?: RepliesConfig } = {}): TriageResult {
  const dry = opts.dry_run === true;
  const config = opts.config ?? loadRepliesConfig();
  const out: TriageResult = { dry_run: dry, auto_recorded: [], proposals: [], bounced: [], ambiguous: [], unmatched: [], matched_ignored: [], ignored: 0, already_processed: 0 };
  const sent = listSentEmails(db, 365);
  const seen = db.prepare('SELECT 1 FROM processed_messages WHERE message_id = ?');
  const latestStmt = db.prepare('SELECT outcome FROM job_outcomes WHERE job_id = ? ORDER BY id DESC LIMIT 1');
  const ins = db.prepare(`INSERT INTO processed_messages (message_id, job_id, classification, action, proposed_outcome, from_addr, subject, reply_date, candidates)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const latest = new Map<string, Outcome | null>(); // in-memory so a dry run decides exactly like a real one
  const latestOf = (jobId: string): Outcome | null => {
    if (!latest.has(jobId)) latest.set(jobId, ((latestStmt.get(jobId) as { outcome: Outcome } | undefined)?.outcome) ?? null);
    return latest.get(jobId) as Outcome | null;
  };
  // Oldest first when dates are known (undated messages keep their order, after the dated ones), so the never-downgrade rule sees them in sequence.
  const batchSeen = new Set<string>();
  const dated = messages.filter((m) => m?.message_id).map((m, i) => { const t = Date.parse(String(m.date ?? '')); return { m, i, t: Number.isNaN(t) ? Infinity : t }; });
  dated.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : a.i - b.i));
  const run = () => {
    for (const { m: raw } of dated) {
      const m = { ...raw, message_id: clampStr(raw.message_id, 500), thread_id: raw.thread_id == null ? raw.thread_id : clampStr(raw.thread_id, 200), from: clampStr(raw.from, 320), subject: clampStr(raw.subject, 1000) };
      if (batchSeen.has(m.message_id) || seen.get(m.message_id)) { out.already_processed++; continue; }
      batchSeen.add(m.message_id);
      const match = matchReply(m, sent);
      const ours = (match.job_id ? sent.filter((e) => e.job_id === match.job_id) : sent).map((e) => e.body ?? '').join('\n');
      const detail = classifyReplyDetail(m.subject ?? '', m.body ?? '', m.from ?? '', ours);
      // A high-confidence thread/exact-sender match from a human is never noise: at minimum it is a reply the user sees as a proposal.
      const humanHigh = match.confidence === 'high' && (match.via === 'thread' || match.via === 'sender') && !isAutomatedSender(m.from);
      const { cls, eligible } = humanHigh && detail.cls === 'noise' ? { cls: 'replied' as const, eligible: false } : detail;
      const d = decideReply(cls, match, match.job_id ? latestOf(match.job_id) : null, config, eligible);
      const subject = m.subject.slice(0, 200);
      const addr = emailAddress(m.from ?? '') ?? m.from.toLowerCase();
      const rd = replyDate(m.date);
      // An ambiguous match stores every candidate job so follow-ups are blocked for all of them (blockedJobIds).
      const candidates = match.via === 'ambiguous' && match.candidates?.length ? JSON.stringify(match.candidates) : null;
      const record = (action: string, outcome: Outcome | null) => { if (!dry) ins.run(m.message_id, match.job_id, cls, action, outcome, addr, subject, rd, candidates); };
      if (d.action === 'auto_record' && match.job_id && d.outcome) {
        if (!dry) recordOutcome(db, match.job_id, d.outcome, `auto: ${cls} reply via ${match.via} from ${m.from}: ${subject}`);
        latest.set(match.job_id, d.outcome);
        record('recorded', d.outcome);
        out.auto_recorded.push({ message_id: m.message_id, job_id: match.job_id, outcome: d.outcome, from: m.from, subject });
      } else if (d.action === 'propose' && match.job_id && d.outcome) {
        record('proposed', d.outcome);
        out.proposals.push({ message_id: m.message_id, job_id: match.job_id, outcome: d.outcome, from: m.from, subject, via: match.via, confidence: match.confidence, reason: d.reason });
      } else if (d.action === 'report') {
        record('bounced', null);
        out.bounced.push({ message_id: m.message_id, job_id: match.job_id, from: m.from, subject });
        if (match.via === 'ambiguous') out.ambiguous.push({ message_id: m.message_id, class: cls, candidates: match.candidates ?? [] });
      } else {
        record('ignored', null);
        if (match.via === 'ambiguous' && ['rejected', 'offer', 'interview', 'replied'].includes(cls)) out.ambiguous.push({ message_id: m.message_id, class: cls, candidates: match.candidates ?? [] });
        else if (!match.job_id && ['rejected', 'offer', 'interview', 'replied'].includes(cls)) out.unmatched.push({ message_id: m.message_id, from: m.from, subject, classification: cls });
        else {
          out.ignored++;
          if (match.job_id && (match.confidence === 'high' || match.confidence === 'medium')) out.matched_ignored.push({ message_id: m.message_id, job_id: match.job_id, from: m.from, subject, class: cls });
        }
      }
    }
  };
  if (dry) run(); else db.transaction(run)();
  return out;
}

export interface RefusedProposal { message_id: string; status: 'refused'; reason: string }

/** Approving applies the same ladder as auto-record (raisesOutcome): a stale proposal that would no longer raise the recorded outcome is refused and marked superseded. Rejecting is always allowed. */
export function resolveReplyProposals(db: BetterSqlite3.Database, decisions: Array<{ message_id: string; approve: boolean }>): { recorded: number; skipped: number; unknown: string[]; refused: RefusedProposal[] } {
  const res = { recorded: 0, skipped: 0, unknown: [] as string[], refused: [] as RefusedProposal[] };
  const get = db.prepare("SELECT job_id, proposed_outcome, classification, from_addr, subject FROM processed_messages WHERE message_id = ? AND action = 'proposed'");
  const set = db.prepare('UPDATE processed_messages SET action = ? WHERE message_id = ?');
  const latestStmt = db.prepare('SELECT outcome FROM job_outcomes WHERE job_id = ? ORDER BY id DESC LIMIT 1');
  db.transaction(() => {
    for (const d of decisions) {
      const row = get.get(d.message_id) as { job_id: string; proposed_outcome: Outcome; classification: string; from_addr: string; subject: string } | undefined;
      if (!row) { res.unknown.push(d.message_id); continue; }
      if (d.approve) {
        const latest = ((latestStmt.get(row.job_id) as { outcome: Outcome } | undefined)?.outcome) ?? null;
        if (!raisesOutcome(latest, row.proposed_outcome)) {
          set.run('superseded', d.message_id);
          res.refused.push({ message_id: d.message_id, status: 'refused', reason: `would not raise the recorded outcome (${latest})` });
          continue;
        }
        recordOutcome(db, row.job_id, row.proposed_outcome, `approved: ${row.classification} reply from ${row.from_addr}: ${row.subject}`);
        set.run('approved', d.message_id);
        res.recorded++;
      } else {
        set.run('skipped', d.message_id);
        res.skipped++;
      }
    }
  })();
  return res;
}
