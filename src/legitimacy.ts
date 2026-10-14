// file: src/legitimacy.ts
// Deterministic legitimacy tier. Signals adapted from career-ops-hq/career-ops modes/oferta.md Block G (MIT, (c) 2026
// Santiago Fernandez de Valderrama) and providers/_trust-validator.mjs, plus India-specific job-scam patterns.
import { htmlToLines } from './htmlText.js';

export interface LegitimacyInput {
  id: string; title: string; description: string | null;
  url?: string | null; apply_url?: string | null; repost_count?: number; age_days?: number | null;
  source?: string | null; snapshot_chars?: number;
}
export interface Legitimacy { tier: 'high' | 'caution' | 'suspicious'; signals: string[] }

const SHORTENER_HOSTS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'forms.gle', 'shorturl.at', 'rebrand.ly', 'cutt.ly', 'wa.me', 'chat.whatsapp.com', 't.me'];
// These sources store a snippet or a location string, not the posting: a short description there is our scraper, not the employer.
const SNIPPET_SOURCES = new Set(['linkedin-jobs', 'naukri', 'adzuna']);
// Descriptions are untrusted scraped text: scan a bounded prefix, clause by clause, with every pattern bounded.
const MAX_SCAN_CHARS = 20000;
const MAX_CLAUSE_CHARS = 400;

const FEE_RE = /\b(?:registration|security|training|processing|joining|refundable)\s+(?:fee|deposit|charges?)\b|\bpay\s+(?:a|the)\s+(?:fee|deposit)\b/gi;
// A fee only counts when it is not negated ("never charge a registration fee", "no security deposit"), the employer is not the one paying
// ("we pay the fee for your certification", "we reimburse the training fee"), and the clause shows the applicant as payer.
const NEGATION_RE = /\b(?:no|never|not|without|zero|nil|neither|nor|don't|do not|won't|will not)\b|\bfree of\b|n't\b/i;
const EMPLOYER_PAYS_RE = /\b(?:we|company|employer|they|us)\s+(?:will\s+|shall\s+)?(?:pay|pays|cover|covers|reimburse|sponsor|fund|deposit)\w*|\breimburs\w*|\bsponsor\w*|\bpaid by (?:us|the company|the employer)|\bcovered by\b/i;
const APPLICANT_PAYS_RE = /\b(?:you|candidates?|applicants?|selected|shortlisted|must|required|payable|pay|deposit of|fee of)\b|₹|\brs\s*\d|\b(?:inr|usd)\b|\$\d/i;
const DEPOSIT_RE = /(?<!direct\s)\bdeposit\s+(?:of\s+)?(?:(?:rs|inr|₹|\$|usd)\s*)?\d|\b(?:should|must|need to|needs to|have to|required to|asked to|to)\s+deposit\b/gi;

/** Clauses split at sentence punctuation followed by whitespace (so "Rs. 1500", "2.5" and "a@b.com" stay whole) and at newlines;
 *  a clause longer than MAX_CLAUSE_CHARS is cut into pieces so regex work stays linear. */
function clausesOf(text: string): string[] {
  const t = text.replace(/\b(rs|inr)\.\s*(?=\d)/gi, '$1 ');
  const out: string[] = [];
  for (const c of t.split(/(?<=[.!?;])\s+|\n+/)) {
    for (let i = 0; i < c.length; i += MAX_CLAUSE_CHARS) out.push(c.slice(i, i + MAX_CLAUSE_CHARS));
  }
  return out;
}
const negatedBefore = (clause: string, idx: number, win = 40) => NEGATION_RE.test(clause.slice(Math.max(0, idx - win), idx));
/** Applicant is the payer: not negated before the match, not the employer paying, and the clause names the applicant or an amount. */
const applicantPays = (clause: string, idx: number) => !negatedBefore(clause, idx) && !EMPLOYER_PAYS_RE.test(clause) && APPLICANT_PAYS_RE.test(clause);
function asksFee(clause: string): boolean {
  for (const re of [FEE_RE, DEPOSIT_RE]) for (const m of clause.matchAll(re)) if (applicantPays(clause, m.index!)) return true;
  return false;
}

// Sensitive documents or credentials asked from the applicant. Aadhaar/PAN/passport/bank details tied to an accepted offer (background
// verification, payroll onboarding) are routine and stay unflagged; OTP, card, PIN and password requests are never routine.
const REQUEST_VERB_RE = /\b(?:send|share|submit|provide|upload|forward|attach|enter|whatsapp|e-?mail|mail|give|tell|requires?|required|needs?|must|verify|verification)\b/i;
const DOC_RE = /\b(?:aadhaar|aadhar|adhaar|pan\s+(?:card|number|details|copy)|passport\s+(?:scan|copy)|bank\s+account\s+(?:details|number|no|statement|passbook|login|credentials)|account\s+number|bank\s+(?:details|statement|passbook))\b/gi;
const CREDENTIAL_RE = /\b(?:otp|one[\s-]time\s+password|cvv|atm\s+pin|card\s+pin|net\s*banking\s+(?:password|login|credentials)|password)\b/gi;
const POST_OFFER_RE = /\b(?:after|post|upon|once)\s+(?:the\s+|your\s+)?(?:offer|joining|selection|you\s+join|acceptance|accepting)\b|\bon\s+joining\b|\bbackground\s+(?:verification|check)\b|\bbgv\b|\bonboarding\b|\bpayroll\b|\be-?kyc\b/i;
function asksSensitive(clause: string): boolean {
  for (const m of clause.matchAll(CREDENTIAL_RE)) {
    if (!negatedBefore(clause, m.index!, 50) && /\b(?:send|share|provide|enter|tell|give|submit|forward|whatsapp)\b/i.test(clause)) return true;
  }
  if (POST_OFFER_RE.test(clause) || !REQUEST_VERB_RE.test(clause)) return false;
  for (const m of clause.matchAll(DOC_RE)) if (!negatedBefore(clause, m.index!, 50)) return true;
  return false;
}

// Payment demanded from the applicant through a personal-payment channel.
const PAY_CHANNEL_RE = /\b(?:upi|gpay|google\s*pay|phonepe|paytm|bhim|neft|imps|western\s+union|bitcoin|crypto|wire\s+transfer|bank\s+transfer)\b|\btransfer\b/gi;
const PAY_VERB_RE = /\b(?:pay|paying|payment|send|transfer|remit|deposit)\b/i;
const PAYROLL_RE = /\b(?:salary|stipend|payroll|credited|reimburs\w*|expense)\b/i;
const MONEYISH_RE = /\b(?:amount|fee|fees|charges?|money|kit|registration|deposit)\b|₹|\brs\s*\d|\$\d/i;
function asksPaymentChannel(clause: string): boolean {
  if (PAYROLL_RE.test(clause) || !PAY_VERB_RE.test(clause)) return false;
  for (const m of clause.matchAll(PAY_CHANNEL_RE)) {
    if (/^transfer/i.test(m[0]) && !MONEYISH_RE.test(clause)) continue;
    if (applicantPays(clause, m.index!)) return true;
  }
  return false;
}

// "earn ... per day/week/daily" is a pitch only with a currency amount; "earn a day off each week" is not.
const MONEY = String.raw`(?:(?:rs|inr|₹|\$|usd)\s*\d[\d,.]*\s*(?:k|lakhs?|lpa)?|\d[\d,.]*\s*(?:k|lakhs?)?\s*(?:rs|inr|₹|\$|usd|rupees|dollars))`;
const EARN_RE = new RegExp(String.raw`\bearn\w*\b[^.]{0,60}?${MONEY}[^.]{0,40}?\b(?:(?:per|a|each|every)\s+(?:day|week)|daily|weekly|everyday)\b`, 'i');
const EARN_PERIOD_RE = /\bearn\w*\b[^.]{0,40}\b(?:daily|weekly|per\s+(?:day|week))\b/i;
const PERSONAL_CHANNEL_RE = /\b(?:send|share|whatsapp|forward)\b[^.]{0,40}\b(?:cv|resume)\b[^.]{0,30}\b(?:whatsapp|telegram)\b|\b(?:whatsapp|telegram)\b[^.]{0,30}\b(?:cv|resume)\b|\b[\w.+-]{1,64}@(?:gmail|yahoo|outlook|hotmail|rediffmail)\.(?:com|co\.in|in)\b/i;
// WhatsApp/Telegram as the only apply channel: an apply instruction toward a chat number or group, with no apply URL and no company mailbox.
const CHAT_APPLY_RE = /\b(?:apply|contact|message|msg|dm|ping|reach|text|send)\b[^.]{0,50}\b(?:whatsapp|telegram)\b|\b(?:whatsapp|telegram)\b[^.]{0,20}\b(?:number|group|channel|no)\b[^.]{0,20}(?:\+?\d[\d\s-]{8,}|\bapply\b)/i;
const EMAIL_RE = /\b[\w.+-]{1,64}@([\w-]{1,63}(?:\.[\w-]{1,63}){1,4})\b/gi;
const PERSONAL_DOMAINS = new Set(['gmail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'outlook.com', 'hotmail.com', 'rediffmail.com']);
const GUARANTEE_RE = /\bguaranteed\s+(?:job|placement|selection|income)\b|\b100\s*%\s*(?:placement|job\s+guarantee|guaranteed)|\bjob\s+guarantee\b|\bassured\s+(?:job|placement)\b|\bplacement\s+guarantee\b/i;
const NO_EXPERIENCE_RE = /\bno\s+(?:prior\s+)?experience\s+(?:needed|required|necessary)\b/i;
const DATA_ENTRY_RE = /\b(?:typing|data\s+entry|copy[\s-]?paste|form\s+filling|captcha)\b/i;
// Pay per hour/day/week; for typing or data entry, amounts at or above these bars are not credible (rupees; dollars have their own bars).
const PAY_UNIT_RE = /(?:(rs|inr|₹|\$|usd)\s*(\d[\d,]{0,9}(?:\.\d{1,2})?)\s*(k)?|(\d[\d,]{0,9}(?:\.\d{1,2})?)\s*(k)?\s*(rs|inr|₹|rupees|usd|dollars))\s*(?:\/|per|a|each|every)\s*(hour|hr|day|week)\b/gi;
const BARS = { rupees: { hour: 300, day: 1500, week: 7000 }, dollars: { hour: 30, day: 200, week: 1000 } };
function highPayPerUnit(clause: string): boolean {
  for (const m of clause.matchAll(PAY_UNIT_RE)) {
    const cur = (m[1] ?? m[6] ?? '').toLowerCase();
    const n = parseFloat((m[2] ?? m[4] ?? '0').replace(/,/g, '')) * ((m[3] ?? m[5]) ? 1000 : 1);
    const unit = m[7].toLowerCase() === 'week' ? 'week' : m[7].toLowerCase() === 'day' ? 'day' : 'hour';
    const table = cur === '$' || cur === 'usd' || cur === 'dollars' ? BARS.dollars : BARS.rupees;
    if (n >= table[unit]) return true;
  }
  return false;
}
const FIXED_TERM_RE = /\b\d+[\s-]*months?\s+contract\b|\bfixed[\s-]term\b|\btemporary\s+position\b|\bterm\s+position\b/i;

function hostOf(u: string | null | undefined): string | null {
  try { return u ? new URL(u).hostname.toLowerCase().replace(/^www\./, '') : null; } catch { return null; }
}
const isShortener = (u: string | null | undefined) => {
  const h = hostOf(u);
  return !!h && SHORTENER_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));
};

export function assessLegitimacy(j: LegitimacyInput): Legitimacy {
  const text = htmlToLines(String(j.description ?? '').slice(0, MAX_SCAN_CHARS * 5)).slice(0, MAX_SCAN_CHARS);
  const descChars = text.replace(/\s+/g, ' ').trim().length;
  const suspicious: string[] = [];
  const caution: string[] = [];
  const info: string[] = [];
  const hit = { fee: false, sensitive: false, pay: false, earn: false, personal: false, chat: false, guarantee: false, noExp: false, dataEntry: false, fixed: false };
  let companyEmail = false;
  const titleDataEntry = DATA_ENTRY_RE.test(String(j.title ?? '').slice(0, 200));
  for (const clause of clausesOf(text)) {
    const earns = EARN_RE.test(clause);
    hit.fee ||= asksFee(clause);
    hit.sensitive ||= asksSensitive(clause);
    hit.pay ||= asksPaymentChannel(clause);
    hit.earn ||= earns;
    hit.personal ||= PERSONAL_CHANNEL_RE.test(clause);
    hit.chat ||= CHAT_APPLY_RE.test(clause);
    hit.guarantee ||= GUARANTEE_RE.test(clause);
    hit.noExp ||= NO_EXPERIENCE_RE.test(clause) && (earns || EARN_PERIOD_RE.test(clause) || highPayPerUnit(clause));
    hit.dataEntry ||= (titleDataEntry || DATA_ENTRY_RE.test(clause)) && highPayPerUnit(clause);
    hit.fixed ||= FIXED_TERM_RE.test(clause);
    for (const m of clause.matchAll(EMAIL_RE)) if (!PERSONAL_DOMAINS.has(m[1].toLowerCase())) companyEmail = true;
  }
  if (hit.fee) suspicious.push('asks the applicant for a fee or deposit');
  if (hit.sensitive) suspicious.push('asks the applicant for sensitive documents or credentials');
  if (hit.pay) suspicious.push('asks the applicant to pay by UPI, wire or transfer');
  if (isShortener(j.apply_url) || isShortener(j.url)) suspicious.push('apply link is a URL shortener or chat/forms host');
  if (hit.earn) suspicious.push('"earn per day/week" pay pitch');
  if ((j.repost_count ?? 0) >= 2) caution.push(`reposted ${j.repost_count} times in 90 days on the same board`);
  if (j.age_days != null && j.age_days > 60) caution.push(`posted ${j.age_days} days ago`);
  const chars = Math.max(descChars, j.snapshot_chars ?? 0);
  const source = String(j.source ?? '').trim().toLowerCase();
  const snippetSource = SNIPPET_SOURCES.has(source) && !(j.snapshot_chars && j.snapshot_chars > 0);
  if (!j.id.startsWith('li-post:') && !snippetSource && chars < 300) caution.push(`thin description (${chars} chars)`);
  if (!j.url && !j.apply_url) caution.push('no posting or apply URL');
  if (hit.personal) caution.push('applications go to a personal mailbox or chat app');
  else if (hit.chat && !j.apply_url && !companyEmail) caution.push('whatsapp or telegram is the only way to apply');
  if (hit.guarantee) caution.push('guaranteed job or placement claim');
  if (hit.noExp) caution.push('no experience needed with an earnings pitch');
  if (hit.dataEntry) caution.push('typing or data-entry job with unusually high pay');
  if (hit.fixed) info.push('info: fixed-term contract');
  const tier = suspicious.length ? 'suspicious' : caution.length ? 'caution' : 'high';
  return { tier, signals: [...suspicious, ...caution, ...info] };
}
