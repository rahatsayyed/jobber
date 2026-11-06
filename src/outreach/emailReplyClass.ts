// src/outreach/emailReplyClass.ts
// Deterministic, conservative classifier for an incoming EMAIL reply (owner decision 2026-11-06). Zero LLM, closed code lists.
// It decides only one thing: may the agent answer this mail by itself (`safe`), is it a plain acknowledgement that needs no answer
// (`record_only`), or does the owner handle it (`owner`). Anything it is not sure of is `owner`.
//
// SAFE asks are plain facts the owner pre-answered in user-data/reply-facts.json: current and expected CTC, notice period, location,
// relocation, availability to join, work authorization. A mail is `safe` only when EVERY ask sentence in it maps to one of those kinds and
// nothing owner-only is present anywhere (a time or slot, an interview, a test or link, a document or attachment, a reference, a phone
// call, an offer, a rejection, personal data, negotiation, injection-like text, a long or odd mail).
// The mail text is third-party data: it is only matched against patterns here, never followed as an instruction.
import { ownerOnlyCodes, unquotedText, type OwnerOnlyCode } from './ownerOnly.js';
import { stripQuoted } from '../replies.js';

export type SafeKind = 'ctc_current' | 'ctc_expected' | 'notice_period' | 'availability' | 'location' | 'relocation' | 'work_authorization';
export type RecordKind = 'thanks_ack' | 'application_received';
export type OwnerKind =
  | 'interview_time' | 'interview_invite' | 'assessment_or_test_link' | 'documents' | 'references' | 'phone_or_call' | 'offer' | 'rejection'
  | 'personal_data' | 'negotiation' | 'link_action' | 'attachment' | 'injection_suspect' | 'mixed_ask' | 'unclear_money' | 'unclear' | 'too_long'
  | 'bounce' | 'automated' | 'no_text';

export const SAFE_KINDS: readonly SafeKind[] = ['ctc_current', 'ctc_expected', 'notice_period', 'availability', 'location', 'relocation', 'work_authorization'];
export const RECORD_KINDS: readonly RecordKind[] = ['thanks_ack', 'application_received'];

/** The reply-facts.json field each safe kind needs. */
export const FACT_FIELD: Record<SafeKind, string> = {
  ctc_current: 'current_ctc',
  ctc_expected: 'expected_ctc',
  notice_period: 'notice_period',
  availability: 'available_from',
  location: 'current_location',
  relocation: 'open_to_relocate',
  work_authorization: 'work_authorization',
};

/** Short owner-facing label of a safe kind (notices, CLI). */
export const KIND_LABEL: Record<SafeKind, string> = {
  ctc_current: 'current CTC',
  ctc_expected: 'expected CTC',
  notice_period: 'notice period',
  availability: 'availability to join',
  location: 'current location',
  relocation: 'relocation',
  work_authorization: 'work authorization',
};

export interface EmailReplyClass {
  verdict: 'safe' | 'record_only' | 'owner';
  /** Safe asks found (empty unless verdict is `safe`). */
  kinds: SafeKind[];
  /** Plain acknowledgements found (verdict `record_only`). */
  record: RecordKind[];
  /** Why the owner must handle it (verdict `owner`). */
  owner: OwnerKind[];
}

export interface ClassifyInput {
  subject?: string | null;
  body?: string | null;
  /** The class from src/replies.ts classifyReplyDetail, when known. */
  cls?: string | null;
  /** True for no-reply, ATS and job-board senders (src/replies.ts isAutomatedSender). */
  automated?: boolean;
}

export const MAX_NEW_CHARS = 1500;
export const MAX_NEW_LINES = 30;
const MAX_ASK_SENTENCES = 6;

// ---------------------------------------------------------------- safe asks

const MONEY = '(?:ctc|salary|package|compensation|pay|remuneration|income|lpa)';

const SAFE_PATTERNS: ReadonlyArray<readonly [SafeKind, RegExp]> = [
  ['ctc_current', new RegExp(
    `\\b(?:current|present|existing|last\\s+drawn|abhi\\s+ka|abhi\\s+ki|aapka\\s+current|apka\\s+current|aapki\\s+current|apki\\s+current)\\s*(?:fixed\\s*)?${MONEY}\\b`
    + `|\\b${MONEY}\\s+(?:currently|abhi)\\b|\\bcurrently\\s+(?:earning|drawing|making|getting|paid)\\b`
    + `|\\bwhat\\s+(?:are|is)\\s+(?:you|your)\\s+(?:currently\\s+)?(?:earning|drawing|making|getting)\\b`
    + `|\\babhi\\s+kitn[ae]\\s+(?:${MONEY}|milta|mil\\s+raha)\\b|\\bkitn[ae]\\s+${MONEY}\\s+(?:mil|le|draw)`, 'i')],
  ['ctc_expected', new RegExp(
    `\\b(?:expected|expecting|desired|target|aapki\\s+expected|apki\\s+expected)\\s*(?:fixed\\s*)?${MONEY}\\b`
    + `|\\b${MONEY}\\s+expectations?\\b|\\bexpectations?\\s+(?:on|for|about|regarding|in)\\s+${MONEY}\\b`
    + `|\\bkitn[ae]\\s+${MONEY}\\s+(?:chahiye|chahie|chahta|chahte|expect)|\\b(?:aapki|apki|your)\\s+expectations?\\s*(?:kya|\\?)`, 'i')],
  ['notice_period', /\bnotice(?:\s+period)?\b|\blast\s+working\s+day\b|\blwd\b|\bserving\s+(?:your\s+)?notice\b/i],
  ['availability', /\b(?:when|how\s+soon|how\s+early|how\s+quickly)\s+can\s+you\s+(?:join|start|begin|come\s+on\s*board)\b|\b(?:earliest|expected|tentative|possible)\s+(?:date\s+of\s+)?(?:joining|join|start)\b|\bavailab\w+\s+to\s+(?:join|start)\b|\bjoining\s+(?:date|time|timeline)\b|\bimmediate\s+joiner\b|\bcan\s+you\s+join\s+(?:immediately|within|in)\b|\bkab\s+(?:tak\s+)?join\b|\bkitne\s+din\s+(?:mein|me)\s+join\b|\bjoin\s+kar\s+sak/i],
  ['location', /\bcurrent(?:ly)?\s+(?:location|city|base|based|residing|staying)\b|\bwhere\s+are\s+you\s+(?:currently\s+)?(?:based|located|staying|residing)\b|\bwhich\s+city\b|\byour\s+(?:current\s+)?location\b|\bkahan\s+(?:se|rehte|rehti|based|par|pe)\b|\blocation\s+kya\b/i],
  ['relocation', /\brelocat\w*|\bwilling\s+to\s+(?:move|shift|travel)\b|\bopen\s+to\s+(?:move|moving|shift|shifting)\b|\bshift\s+ho\s+sak|\bkar\s+sakte\s+hain\b.*\bshift\b/i],
  ['work_authorization', /\bwork\s+(?:authori[sz]ation|permit|visa)\b|\bvisa\b|\bauthori[sz]ed\s+to\s+work\b|\bright\s+to\s+work\b|\beligible\s+to\s+work\b|\bsponsorship\b/i],
];

const BOTH_CTC = new RegExp(`\\bcurrent\\s*(?:and|&|/|,|\\+|or)\\s*(?:the\\s+)?expected\\s*(?:fixed\\s*)?${MONEY}\\b|\\bexpected\\s*(?:and|&|/|,|\\+|or)\\s*(?:the\\s+)?current\\s*(?:fixed\\s*)?${MONEY}\\b|\\bcurrent\\s*(?:and|&|/|,)\\s*expected\\b`, 'i');

// ---------------------------------------------------------------- plain acknowledgements (no answer needed)

const APPLICATION_RECEIVED = /\b(?:we(?:'ve|\s+have)?\s+)?received\s+your\s+(?:application|resume|cv|profile|email|mail|details)\b|\bthank(?:s|\s+you)\s+for\s+(?:applying|your\s+(?:application|interest|email|mail|response|time))\b|\byour\s+application\s+(?:has\s+been|is|was)\s+(?:received|submitted|under\s+review|being\s+reviewed)\b|\b(?:we|our\s+team)\s+will\s+(?:review|get\s+back|revert|be\s+in\s+touch|contact\s+you|reach\s+out)(?:\s+to\s+you)?(?:\s+(?:soon|shortly|if\s+(?:shortlisted|selected|suitable|there\s+is\s+a\s+(?:match|fit))))?\b|\bwill\s+(?:revert|get\s+back)\s+(?:to\s+you\s+)?(?:soon|shortly|if\s+\w+)\b|\bshortlisted\s+profiles?\s+will\s+be\s+contacted\b/i;
const THANKS_ACK = /^[\s\W]*(?:(?:hi|hello|dear|hey)\b[^.!?\n]{0,40}[,.!]?\s*)?(?:(?:ok(?:ay)?|noted|got\s+it|received|understood|sure|great|perfect|fine|alright|thank(?:s|\s+you)(?:\s+(?:so\s+much|very\s+much|a\s+lot))?(?:\s+for\s+(?:the\s+)?(?:update|information|details|reply|response|confirmation|sharing|letting\s+me\s+know|getting\s+back))?|thanks\s+and\s+regards|dhanyavaad|shukriya|theek\s+hai)\b[\s,.!:-]*){1,4}(?:regards|best|cheers|thanks)?[\s\W]*$/i;

// ---------------------------------------------------------------- owner-only patterns (hard)

const OWNER_PATTERNS: ReadonlyArray<readonly [OwnerKind, RegExp]> = [
  ['interview_time', /\b(?:schedul\w*|reschedul\w*|slots?|calendly|convenient\s+(?:time|slot|date)|your\s+availability|availability\s+(?:for|on|at)|available\s+(?:on|at|for|from|between|tomorrow|today|this|next)|free\s+(?:on|at|tomorrow|today|this|next)|\d{1,2}\s*(?::\d{2})?\s*(?:am|pm)\b|\d{1,2}[:.]\d{2}\s*(?:hrs|ist|pst|est|utc|gmt)?|(?:mon|tues?|wednes|thurs?|fri|satur|sun)day|tomorrow|day\s+after|next\s+week|this\s+week|time\s*zone|\bist\b|\bpst\b|\bgmt\b|which\s+(?:day|date|time)|what\s+time|kis\s+din|kitne\s+baje|kal\b|parso)/i],
  ['interview_invite', /\b(?:interview\w*|(?:technical|hr|managerial|screening|first|second|third|final|next|face[- ]to[- ]face)\s+round|discussion|shortlisted|meet(?:ing)?s?|video\s+call|zoom|google\s+meet|ms\s+teams|microsoft\s+teams|skype|webex|walk-?in|round\s+of)\b/i],
  ['assessment_or_test_link', /\b(?:tests?|assessments?|assignments?|coding\s+(?:challenge|round|test)|hackerrank|codility|codesignal|take-?home|case\s+study|questionnaire|survey|fill(?:ing)?(?:\s+out)?|form|exam|quiz|task)\b/i],
  ['documents', /\b(?:documents?|docs?|resume|cv|curriculum|certificates?|payslips?|pay\s*slips?|offer\s+letter|relieving|experience\s+letter|marksheets?|portfolio|photos?|photographs?|id\s+proof|attach\w*|enclosed|updated\s+profile|profile\s+link|github|linkedin|form\s*16|bank\s+statement|screenshots?|upload\w*)\b/i],
  ['references', /\b(?:references?|referees?|previous\s+(?:employer|manager|company)|background\s+(?:check|verification)|verification|vouch)\b/i],
  ['phone_or_call', /\b(?:call(?:s|ing|ed)?|phone|mobile|whatsapp|contact\s+(?:number|no)|numbers?|dial|speak|talk|telephon\w*|voice|ring|sms|telegram|signal)\b/i],
  ['offer', /\b(?:offers?|offered|offering|pleased\s+to\s+(?:inform|offer|extend)|congratulations?|congrats|onboard\w*|joining\s+(?:formalities|bonus|letter)|appointment\s+letter|selected|selection)\b/i],
  ['rejection', /\b(?:regret|unfortunately|not\s+(?:be\s+)?(?:moving|proceeding|taking|going)\s+forward|not\s+(?:selected|shortlisted|a\s+(?:good\s+)?(?:fit|match))|other\s+candidates?|position\s+(?:has\s+been\s+)?(?:filled|closed|on\s+hold)|unable\s+to\s+(?:proceed|move)|won'?t\s+be\s+moving|will\s+keep\s+your\s+(?:resume|profile|cv)|on\s+hold|put\s+on\s+hold)\b/i],
  ['personal_data', /\b(?:(?:home|residential|permanent|current|postal|full)\s+address|dob|date\s+of\s+birth|marital|religion|caste|nationality|gender|passport|aadhaa?r|pan\s*card|\bpan\b|ssn|bank|account\s+number|id\s+proof|age)\b/i],
  ['negotiation', /\b(?:negotiab\w*|buy-?out|flexib\w*|counter|best\s+(?:ctc|salary)|hike|lowest|minimum\s+(?:ctc|salary)|budget|salary\s+band|ready\s+to\s+(?:take|accept|reduce)|reduce|lower)\b/i],
  ['injection_suspect', /\bignore\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|rules|restrictions|limits|safety|instructions)|\bdisregard\b|\bforget\s+(?:all\s+|your\s+)?(?:previous|instructions|rules)|system\s+prompt|\byou\s+are\s+now\b|\bact\s+as\b|\bpretend\b|jailbreak|\boverride\b|new\s+instructions?|\bas\s+an\s+ai\b|language\s+model|reveal\s+your|do\s+not\s+tell\s+(?:the|your)\s+owner|developer\s+mode|<\s*\/?\s*(?:system|assistant|instructions?)\s*>|\[\s*(?:system|inst)\s*\]|\bbypass\b|\bsudo\b|\binstructions?\b/i],
];

const ZERO_WIDTH = /[​-‏⁠﻿‪-‮⁦-⁩]/;
const ATTACHMENT_LIST = /^\s*attachments?\s*\(\d+\)|\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|png|jpe?g|gif|txt|csv|ics)\s*\(|\b(?:please\s+find|find\s+the|see|see\s+the)\s+attached\b|\battached\s+(?:is|are|herewith|file|document|form)\b/im;
const URL_RE = /https?:\/\/\S+|www\.\S+|\b[a-z0-9-]+\.(?:com|in|io|co|net|org|ai|app|dev|me|ly)\/\S*/gi;
const LINK_ACTION = /\b(?:link|click|visit|open|register|apply|login|log\s*in|sign\s*(?:in|up)|here|below|portal|form|fill|complete|submit|upload|book|use|check|go\s+to|follow|download|join|attend|take|verify|confirm|access|review)\b/i;

// ---------------------------------------------------------------- ask detection

const ASK_CUE = /\?|\b(?:please|kindly|pls|plz|share|send|provide|confirm|let\s+(?:us|me)\s+know|can\s+you|could\s+you|would\s+you|will\s+you|are\s+you|do\s+you|did\s+you|have\s+you|what|when|where|which|how|tell|mention|specify|revert|reply|respond|require[ds]?|need|bataiye|bataiyega|bataye|batao|bata\s+do|kya|kitna|kitne|kitni|kab|kahan|kaise|chahiye|dijiye|dijiyega|bhejiye|bhejein|bhej\s+do|kariye)\b/i;
const BARE_ASK = /^(?:bataiye|bataiyega|bataye|batao|bata\s+do|dijiye|dijiyega|please|kindly|pls|plz)[\s.!]*$/i;
const BENIGN_ASK = /^(?:please\s+|kindly\s+|pls\s+|plz\s+)?(?:let\s+(?:us|me)\s+know|revert|reply|respond|confirm|get\s+back(?:\s+to\s+(?:us|me))?|do\s+reply|write\s+back)(?:\s+(?:to\s+us|to\s+me|at\s+the\s+earliest|at\s+your\s+earliest(?:\s+convenience)?|asap|soon|as\s+soon\s+as\s+possible|today|by\s+eod|urgently|the\s+same|on\s+the\s+same|with\s+the\s+(?:above\s+)?details|with\s+details|ASAP|if\s+(?:interested|you\s+are\s+interested)))*\s*[.!:]*$/i;
const FILLER_WORDS = /\b(?:please|kindly|pls|plz|thanks|thank you|regards|dear|hi|hello|hey|sir|madam|mam|ji)\b/gi;

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function maskSpans(text: string, res: RegExp[]): string {
  let out = text;
  for (const re of res) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    out = out.replace(g, (m) => ' '.repeat(m.length));
  }
  return out;
}

/** Splits text into sentences/lines, keeping each one's text. Lines ending with `:` or short label lines stay whole. */
function sentences(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '');
    if (!line) continue;
    // Break on sentence ends followed by a space; keep "?" with its sentence.
    const parts = line.split(/(?<=[.!?])\s+(?=[A-Za-z"'(])/);
    for (const p of parts) if (p.trim()) out.push(p.trim());
  }
  return out;
}

function safeKindsOf(sentence: string): SafeKind[] {
  const found = new Set<SafeKind>();
  for (const [k, re] of SAFE_PATTERNS) if (re.test(sentence)) found.add(k);
  if (BOTH_CTC.test(sentence)) { found.add('ctc_current'); found.add('ctc_expected'); }
  return SAFE_KINDS.filter((k) => found.has(k));
}

/** Is this sentence an ask? A cue word, a question mark, or a short label line like "Current CTC:". */
function isAsk(sentence: string, hasKind: boolean): boolean {
  if (ASK_CUE.test(sentence)) return true;
  if (/:\s*$/.test(sentence)) return true;
  return hasKind && wordCount(sentence) <= 8; // "Current CTC", "Notice period - ?" style form lines
}

/** Owner-only kinds present in the (masked) text. */
function ownerKindsOf(masked: string): OwnerKind[] {
  const found = new Set<OwnerKind>();
  for (const [k, re] of OWNER_PATTERNS) if (re.test(masked)) found.add(k);
  // ownerOnly.ts words (shared with the Telegram "needs you" flag), on the masked text without URLs.
  const codes: OwnerOnlyCode[] = ownerOnlyCodes('', masked.replace(URL_RE, ' '));
  for (const c of codes) {
    if (c === 'salary') found.add('unclear_money');
    else if (c === 'interview_time') found.add('interview_time');
    else if (c === 'test_or_assessment') found.add('assessment_or_test_link');
    else if (c === 'documents') found.add('documents');
    else if (c === 'references') found.add('references');
    else if (c === 'personal_data') found.add('personal_data');
    else if (c === 'link_or_phone') found.add('phone_or_call');
  }
  return [...found];
}

/** URLs that look like an action ("click here", a bare link after an ask line). A plain signature link is tolerated. */
function hasLinkAction(newText: string): boolean {
  const lines = newText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    URL_RE.lastIndex = 0;
    if (!URL_RE.test(line)) continue;
    URL_RE.lastIndex = 0;
    if (LINK_ACTION.test(line.replace(URL_RE, ' '))) return true;
    const prev = lines.slice(0, i).reverse().find((l) => l.trim() !== '') ?? '';
    if (/:\s*$/.test(prev.trim()) || ASK_CUE.test(prev)) return true;
  }
  return false;
}

/**
 * The verdict for one incoming mail. Order of rules: hard owner conditions first (bounce, automated sender, attachments, injection-like
 * text, too long, owner-only words, a link that asks for action), then record-only acknowledgements, then the safe asks (all ask sentences
 * must be explained by a safe kind). Everything else is `owner`.
 */
export function classifyEmailReply(input: ClassifyInput): EmailReplyClass {
  const owner = (...k: OwnerKind[]): EmailReplyClass => ({ verdict: 'owner', kinds: [], record: [], owner: [...new Set(k)] });
  const cls = (input.cls ?? '').toLowerCase();
  const rawBody = String(input.body ?? '').slice(0, 12000);
  const subject = String(input.subject ?? '').slice(0, 300);

  const hard: OwnerKind[] = [];
  if (cls === 'bounce') hard.push('bounce');
  if (cls === 'rejected') hard.push('rejection');
  if (cls === 'offer') hard.push('offer');
  if (cls === 'interview') hard.push('interview_invite');
  if (input.automated) hard.push('automated');
  if (ATTACHMENT_LIST.test(rawBody)) hard.push('attachment');
  if (ZERO_WIDTH.test(rawBody) || ZERO_WIDTH.test(subject)) hard.push('injection_suspect');

  // HTML-only mail (gmail.read_email returns raw HTML when there is no text part) is reduced to its new text first, the same way the reply classifier does.
  const readable = /<\s*(?:html|body|div|p|br|blockquote|span|table|a)\b|<!--/i.test(rawBody) ? stripQuoted(rawBody) : rawBody;
  const newText = unquotedText(readable);
  if (!newText.trim()) hard.push('no_text');
  if (newText.length > MAX_NEW_CHARS || newText.split('\n').length > MAX_NEW_LINES) hard.push('too_long');
  if (hard.length) return owner(...hard);

  if ((cls === 'noise' || cls === 'auto_ack') && !ASK_CUE.test(newText)) {
    return { verdict: 'record_only', kinds: [], record: ['application_received'], owner: [] };
  }

  const subjectLower = subject.toLowerCase();
  const text = `${newText}`;
  // Mask the phrases that are safe asks or plain acknowledgements, so a word like "resume" in "received your resume" or "availability" in
  // "availability to join" does not raise an owner-only flag. Everything left is checked against the owner-only lists.
  const maskRes = [...SAFE_PATTERNS.map(([, re]) => re), BOTH_CTC, APPLICATION_RECEIVED];
  const masked = maskSpans(`${subjectLower}\n${text.toLowerCase()}`, maskRes);
  const ownerKinds = ownerKindsOf(masked);
  if (hasLinkAction(text)) ownerKinds.push('link_action');
  if (ownerKinds.length) return owner(...ownerKinds);

  const sents = sentences(text);
  const kinds = new Set<SafeKind>();
  let unexplained = 0;
  let asks = 0;
  for (const s of sents) {
    const ks = safeKindsOf(s);
    // A plain acknowledgement sentence ("we will revert soon") is not an ask even though it holds a cue word.
    if (ks.length === 0 && APPLICATION_RECEIVED.test(s) && !ASK_CUE.test(s.replace(new RegExp(APPLICATION_RECEIVED.source, 'gi'), ' '))) continue;
    if (!isAsk(s, ks.length > 0)) continue;
    asks++;
    if (ks.length > 0) { for (const k of ks) kinds.add(k); continue; }
    const stripped = s.replace(FILLER_WORDS, ' ').replace(/\s+/g, ' ').trim();
    if (stripped === '' || BARE_ASK.test(s.trim()) || BENIGN_ASK.test(s.trim()) || BENIGN_ASK.test(stripped)) continue;
    unexplained++;
  }
  if (asks > MAX_ASK_SENTENCES) return owner('mixed_ask');
  if (unexplained > 0) return owner('mixed_ask');

  if (kinds.size > 0) return { verdict: 'safe', kinds: SAFE_KINDS.filter((k) => kinds.has(k)), record: [], owner: [] };

  // No ask at all: a plain acknowledgement is recorded, never answered.
  if (asks === 0 || sents.every((s) => !isAsk(s, false))) {
    if (wordCount(text) <= 60 && THANKS_ACK.test(text.trim())) return { verdict: 'record_only', kinds: [], record: ['thanks_ack'], owner: [] };
    if (APPLICATION_RECEIVED.test(text) && wordCount(text) <= 120) return { verdict: 'record_only', kinds: [], record: ['application_received'], owner: [] };
  }
  return owner('unclear');
}

/** Owner-facing sentence for the Telegram notice: why this mail is not answered by the agent. */
export const OWNER_REASON_TEXT: Record<OwnerKind, string> = {
  interview_time: 'asks for a time, date or slot',
  interview_invite: 'is an interview or meeting invitation',
  assessment_or_test_link: 'asks for a test, assessment or form',
  documents: 'asks for a document or attachment',
  references: 'asks for references',
  phone_or_call: 'asks for a phone number or a call',
  offer: 'is about an offer',
  rejection: 'is a rejection (recorded, not answered)',
  personal_data: 'asks for personal data',
  negotiation: 'is about negotiation',
  link_action: 'contains a link that asks for an action',
  attachment: 'has an attachment',
  injection_suspect: 'contains instruction-like text',
  mixed_ask: 'has more than the plain asks the agent may answer',
  unclear_money: 'mentions pay in a way that is not clearly current or expected CTC',
  unclear: 'is not a plain ask the agent can be sure about',
  too_long: 'is long',
  bounce: 'is a bounce',
  automated: 'comes from an automated sender',
  no_text: 'has no readable new text',
};
