// Pre-send guard pipeline for the typed LinkedIn tools. Synchronous, no browser.
// Ceilings are NOT consumed here (the tool consumes them right before the click).
import type BetterSqlite3 from 'better-sqlite3';
import { haltReason } from '../outreach/limits.js';
import { inQuietHours, quietFromConfig } from '../outreach/quiet.js';
import { loadOutreachConfig } from '../outreach/config.js';
import { loadTuning } from '../outreach/tuning.js';
import { companyPaused } from '../outreach/people.js';
import { checkStyle, type StyleConfig } from '../safety/styleGate.js';
import { gateOutbound, secretValuesFromEnv, type OutboundContext } from '../safety/outputGate.js';
import { checkTextWithNormalized } from '../resumeFacts.js';
import { getBaseResume } from '../resume.js';
import { isLinkedInUrl, isProfileUrl, isBlockedPath, profileKeyOf } from './urls.js';
import { employerGate } from './employer.js';
import { validateNoteLength } from './verify.js';
import { personByProfileKey, reserveTouch, idempotencyKey, type PersonRow } from './touches.js';
import { effectiveDryRun, type LinkedinConfig } from './config.js';

type Db = BetterSqlite3.Database;

export type Kind = 'connect' | 'role_ask' | 'rapport' | 'referral_ask' | 'followup' | 'feedback';
export type FactVerdict = 'pass' | 'warn' | 'block';
export type FactCheck = (
  text: string,
  ctx: { jobTitle?: string; company?: string; jobDescription?: string },
) => { verdict: FactVerdict; normalized_text: string };

export interface GuardInput {
  db: Db; now: Date; env: NodeJS.ProcessEnv;
  action: 'invite' | 'message';
  kind: Kind;
  profileUrl: string;
  text: string;
  jobId?: string | null; jobTitle?: string; company?: string; jobDescription?: string;
  /** Optional: the default (in-process fact gate over the base resume) is only touched when absent. */
  factCheck?: FactCheck;
  styleCfg: StyleConfig;
  cfg: LinkedinConfig;
  callDryRun?: boolean;
  /** A note-less invite (arm kind connect_plain): no text, so the text, style, fact and output gates do not apply; every other gate does. */
  plain?: boolean;
}

export type GuardResult =
  | { ok: true; text: string; person: PersonRow; key: string; dryRun: boolean; touchId: number; factVerdict: FactVerdict }
  | { ok: false; status: 'halted' | 'refused'; code: string; reason: string };

export const MAX_MESSAGE_CHARS = 1800;

/** Default wiring: the base resume is read lazily, only when this runs. */
export const defaultFactCheck: FactCheck = (text, ctx) => {
  const r = checkTextWithNormalized(text, getBaseResume(), {
    jobTitle: ctx.jobTitle, company: ctx.company, jobDescription: ctx.jobDescription,
  });
  return { verdict: r.verdict, normalized_text: r.normalized_text };
};

const refuse = (code: string, reason: string): GuardResult => ({ ok: false, status: 'refused', code, reason });

export function preSendGuard(i: GuardInput): GuardResult {
  const halt = haltReason(i.db, 'linkedin');
  if (halt !== null) return { ok: false, status: 'halted', code: 'halted', reason: `linkedin halted: ${halt}` };

  const ocfg = loadOutreachConfig(i.env);
  if (inQuietHours(i.now, quietFromConfig(ocfg))) {
    return refuse('quiet_hours', 'quiet hours are active');
  }

  const url = i.profileUrl;
  if (!isLinkedInUrl(url) || !isProfileUrl(url) || isBlockedPath(url).blocked) {
    return refuse('bad_url', 'not a LinkedIn profile URL');
  }

  const person = personByProfileKey(i.db, profileKeyOf(url));
  if (!person) return refuse('unknown_recipient', 'recipient is not in people');
  if (!person.name || !person.name.trim()) return refuse('recipient_name_unknown', 'recipient name is unknown');

  if (
    person.paused_reason !== null ||
    ['replied_negative', 'closed', 'cooldown'].includes(person.stage) ||
    companyPaused(i.db, 'linkedin', person.company_key)
  ) {
    return refuse('contact_paused', 'contact or company is paused');
  }

  // People quality (finding 20): the person must show as working at the company. Runs in dry runs
  // too, and before any touch is reserved or ceiling consumed.
  const employer = employerGate(person);
  if (!employer.ok) return refuse(employer.code, employer.reason);

  if (i.plain) {
    const dry = effectiveDryRun(i.cfg, i.callDryRun);
    const k = idempotencyKey(i.kind, person.profile_key, '');
    const r = reserveTouch(i.db, { personId: person.id, kind: i.kind, jobId: i.jobId ?? null, body: '', key: k, now: i.now, dryRun: dry });
    if (!r.ok) return refuse(r.reason, `touch not reserved: ${r.reason}`);
    return { ok: true, text: '', person, key: k, dryRun: dry, touchId: r.touchId, factVerdict: 'pass' };
  }

  const text = i.text ?? '';
  if (text.trim().length === 0) return refuse('empty_text', 'text is empty');
  if (i.action === 'invite') {
    if (!validateNoteLength(text).ok) return refuse('note_too_long', 'note is over 300 characters');
  } else if (text.length > MAX_MESSAGE_CHARS) {
    return refuse('message_too_long', `message is over ${MAX_MESSAGE_CHARS} characters`);
  }

  // Style gate runs on the raw draft BEFORE normalization and the fact gate.
  const style = checkStyle(text, i.kind, i.styleCfg);
  if (!style.ok) {
    const rules = [...new Set(style.hits.map((h) => h.rule))].join(', ');
    return refuse('style_gate', `style rules failed: ${rules}`);
  }

  let fact: { verdict: FactVerdict; normalized_text: string };
  try {
    fact = (i.factCheck ?? defaultFactCheck)(text, {
      jobTitle: i.jobTitle, company: i.company, jobDescription: i.jobDescription,
    });
  } catch {
    return refuse('fact_gate_error', 'fact gate could not run');
  }
  if (fact.verdict === 'block') return refuse('fact_gate_block', 'fact gate blocked the text');
  const normalized = fact.normalized_text;
  // Normalization can lengthen the text: re-check the same limits on what will actually be typed.
  if (i.action === 'invite') {
    if (!validateNoteLength(normalized).ok) return refuse('note_too_long', 'note is over 300 characters');
  } else if (normalized.length > MAX_MESSAGE_CHARS) {
    return refuse('message_too_long', `message is over ${MAX_MESSAGE_CHARS} characters`);
  }

  const g = gateOutbound(normalized, {
    recipientKey: person.profile_key,
    expectedRecipientKey: person.profile_key,
    allowedUrls: i.cfg.allowedUrls,
    allowedEmails: i.cfg.allowedEmails,
    secretValues: secretValuesFromEnv(i.env),
    factVerdict: fact.verdict,
  });
  if (!g.ok) return refuse('output_gate_text', `output gate: ${g.reasons.join(', ')}`);

  const dryRun = effectiveDryRun(i.cfg, i.callDryRun);
  const key = idempotencyKey(i.kind, person.profile_key, normalized);
  const r = reserveTouch(i.db, {
    personId: person.id, kind: i.kind, jobId: i.jobId ?? null, body: normalized, key, now: i.now, dryRun,
  });
  if (!r.ok) return refuse(r.reason, `touch not reserved: ${r.reason}`);
  return { ok: true, text: normalized, person, key, dryRun, touchId: r.touchId, factVerdict: fact.verdict };
}

/** Page-dependent half of the output gate, re-run in the tool with the live page's URL and visible text. */
export function outputGateContext(a: {
  person: PersonRow; actualProfileUrl: string; rawPageText: string; cfg: LinkedinConfig;
  env: NodeJS.ProcessEnv; factVerdict: FactVerdict;
}): OutboundContext {
  const first = (a.person.name ?? '').trim().split(/\s+/)[0] ?? '';
  return {
    recipientKey: profileKeyOf(a.actualProfileUrl),
    expectedRecipientKey: a.person.profile_key,
    allowedUrls: a.cfg.allowedUrls,
    allowedEmails: a.cfg.allowedEmails,
    rawPageText: a.rawPageText,
    secretValues: secretValuesFromEnv(a.env),
    allowedPhrases: first ? [first] : [],
    factVerdict: a.factVerdict,
  };
}
