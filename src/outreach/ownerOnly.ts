// src/outreach/ownerOnly.ts
// Words that mark a reply as the OWNER's to answer (zero LLM, closed code list). Used for the Telegram "needs you" flag on email and LinkedIn
// replies. A reply that matches any code here is never answered by the agent. This is a flag for the owner, not a gate that lets anything through:
// a reply that matches nothing is only "plainly safe" for the optional auto reply if it also passes the stricter list in src/mail/autoReply.ts.
export type OwnerOnlyCode = 'salary' | 'interview_time' | 'test_or_assessment' | 'link_or_phone' | 'documents' | 'references' | 'personal_data';

const PATTERNS: ReadonlyArray<readonly [OwnerOnlyCode, RegExp]> = [
  ['salary', /\b(salary|ctc|compensation|expected pay|current pay|lpa|package|notice period|stipend)\b/i],
  ['interview_time', /\b(interviews?|slots?|schedul\w*|availability|available (?:on|at|for)|calendly|reschedul\w*|time ?zone|meeting|zoom|google meet|teams call|call)\b/i],
  ['test_or_assessment', /\b(tests?|assessments?|assignments?|coding challenge|hackerrank|codility|take-?home|case study)\b/i],
  ['link_or_phone', /https?:\/\/|www\.|\b(link|phone|mobile|whatsapp|contact number|linkedin profile|github)\b/i],
  ['documents', /\b(documents?|resume|cv|certificates?|attach\w*|portfolio|payslips?|offer letter|marksheet)\b/i],
  ['references', /\b(references?|referees?)\b/i],
  ['personal_data', /\b(aadhaa?r|pan card|passport|date of birth|dob|home address|current address|ssn|bank (?:details|account)|id proof|photograph)\b/i],
];

/** Lines of a mail that the sender wrote now: quoted lines, the "On ... wrote:" tail and forwarded headers are dropped. */
export function unquotedText(body: string | null | undefined): string {
  const raw = String(body ?? '').slice(0, 12000).replace(/\r/g, '');
  const cut = /^(?:On .{5,200}wrote:|-{2,}\s*Original Message\s*-{2,}|_{5,}|From:\s.+\nSent:\s)/im.exec(raw);
  const head = cut ? raw.slice(0, cut.index) : raw;
  return head.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n').trim();
}

/** The owner-only codes found in the new text of a mail (subject included). Empty when none. */
export function ownerOnlyCodes(subject: string | null | undefined, body: string | null | undefined): OwnerOnlyCode[] {
  const text = `${String(subject ?? '').slice(0, 300)}\n${unquotedText(body)}`;
  return PATTERNS.filter(([, re]) => re.test(text)).map(([c]) => c);
}

/** True when a free-text reason or ask (an escalation reason, an ask kind) names an owner-only ask. */
export function ownerOnlyAskText(text: string | null | undefined): boolean {
  const t = String(text ?? '');
  return /\b(salary|interview[_ ]?(?:time|slot)|personal[_ ]data|references?|link[_ ]or[_ ]phone)\b/i.test(t);
}
