// Pure, English-oriented classifier for inbound Naukri messages. Escalation is the safe default.
import { gateInput } from '../safety/inputGate.js';

export type InboundClass = 'recruiter_inquiry' | 'reply' | 'rejection' | 'interview' | 'noise' | 'injection_suspect';
export interface InboundVerdict { klass: InboundClass; escalate: boolean; reasons: string[]; mayAutoReply: boolean }

const RULES: Array<[string, RegExp]> = [
  ['salary', /\b(salary|salaries|ctc|lpa|lakhs?|compensation|remuneration|package|pay\s*(?:range|expectation))\b/i],
  ['expected_current_pay', /\b(expected|current)\s+(ctc|salary|compensation|package)\b/i],
  ['notice_period', /\bnotice\s*period\b/i],
  ['interview', /\binterview(s|ing)?\b/i],
  ['schedule', /\b(schedule|scheduling|rescheduled?|slot|availability|available\s+(?:on|at|for))\b/i],
  ['call_request', /\b(call\s+me|give\s+me\s+a\s+call|phone\s+call|call\s+you|let'?s\s+(?:talk|connect\s+on\s+call))\b/i],
  ['messenger_handle', /\b(whats\s?app|telegram|skype|signal)\b/i],
  ['document_request', /\b(aadhaar|aadhar|pan\s*(?:card|number)?|passport|bank\s*(?:details|statement|account)|payslips?|offer\s+letter|(?:share|send|attach)\b[^.\n]{0,40}\b(?:resume|cv|documents?|id\s*proof))\b/i],
  ['references', /\breferences?\b/i],
  ['url', /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|io|co|net|org|ai|me|ly)\b\/?\S*/i],
  ['email_address', /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
];

const NON_LATIN = /(?![\p{Script=Latin}])\p{L}/u;
const TZ = /\b(ist|pst|pdt|est|edt|cst|gmt|utc|cet|gst|time\s*zones?)\b/i;
const DATE_OR_TIME =
  /\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b|\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b|\btomorrow\b/i;

function hasPhone(text: string): boolean {
  const m = text.match(/\+?\d[\d\s\-().]{5,}\d/g) ?? [];
  return m.some((s) => s.replace(/\D/g, '').length >= 7);
}

const REJECTION =
  /\b(unfortunately|regret to inform|not (?:be )?moving forward|not (?:been )?selected|position (?:has been|is) filled|decided to (?:move|proceed) with (?:other|another)|other candidates|not a (?:good )?fit)\b/i;
const NOISE = /\b(unsubscribe|job alert|newsletter|jobs? (?:recommended|for you)|auto[- ]?(?:reply|generated)|do not reply|no-?reply)\b/i;
const INQUIRY = /\b(interested|opportunit(?:y|ies)|opening|hiring|vacancy|role|position|profile|looking for)\b/i;

export function classifyInbound(
  text: string,
  opts: { alreadyRepliedThisThread?: boolean; threadAgeDays?: number } = {},
): InboundVerdict {
  const raw = typeof text === 'string' ? text : '';
  const gate = gateInput(raw);
  if (gate.blocked || gate.flags.some((f) => f !== 'truncated')) {
    return { klass: 'injection_suspect', escalate: true, reasons: ['injection_suspect', ...gate.flags], mayAutoReply: false };
  }
  const t = gate.text;
  const reasons: string[] = [];
  for (const [name, re] of RULES) if (re.test(t)) reasons.push(name);
  if (hasPhone(t)) reasons.push('phone_number');
  if (TZ.test(t) && (DATE_OR_TIME.test(t) || /\d/.test(t))) reasons.push('time_zone_schedule');
  if (NON_LATIN.test(t)) reasons.push('unclassified_non_latin');
  if (gate.flags.includes('truncated')) reasons.push('truncated');

  let klass: InboundClass;
  if (REJECTION.test(t)) klass = 'rejection';
  else if (reasons.includes('interview') || reasons.includes('schedule') || reasons.includes('time_zone_schedule')) klass = 'interview';
  else if (NOISE.test(t)) klass = 'noise';
  else if (INQUIRY.test(t)) klass = 'recruiter_inquiry';
  else klass = 'reply';

  const escalate = reasons.length > 0;
  const age = opts.threadAgeDays;
  const mayAutoReply =
    !escalate && (klass === 'recruiter_inquiry' || klass === 'reply') &&
    opts.alreadyRepliedThisThread === false && typeof age === 'number' && Number.isFinite(age) && age <= 14;
  return { klass, escalate, reasons, mayAutoReply };
}
