// file: src/replies.ts
// Adapted from career-ops-hq/career-ops reply-matcher.mjs (MIT, (c) 2026 Santiago Fernandez de Valderrama) and
// MadsLorentzen/ai-job-search .claude/commands/gmail-sync.md (MIT, (c) 2026 Mads Lorentzen). See those repos' LICENSE files.
// Reply text is untrusted input: every scanned string is clamped (MAX_SCAN) and every regex quantifier below is bounded or linear.
// Safety stance: when in doubt the class is the NON-auto-recorded one, and auto-record is OFF unless config/replies.json enables it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Outcome, SentEmail } from './db.js';

export type ReplyClass = 'bounce' | 'noise' | 'auto_ack' | 'rejected' | 'offer' | 'interview' | 'replied' | 'unknown';
export interface IncomingMessage { message_id: string; thread_id?: string | null; from: string; subject: string; date?: string | null; body: string }
export interface ReplyMatch { job_id: string | null; confidence: 'high' | 'medium' | 'low' | 'none'; via: 'thread' | 'sender' | 'domain' | 'company' | 'ambiguous' | 'none'; /** set only when via is 'ambiguous': the competing job ids */ candidates?: string[] }
export interface ReplyDecision { action: 'auto_record' | 'propose' | 'ignore' | 'report'; outcome: Outcome | null; reason: string }
export interface RepliesConfig { auto_record_enabled: boolean }
export interface ReplyClassification { cls: ReplyClass; /** true only for a strong, unambiguous signal from a non-automated sender: the only mails that may ever be auto-recorded */ eligible: boolean }

const MAX_SCAN = 20000;
const clamp = (s: unknown, n = MAX_SCAN): string => String(s ?? '').slice(0, n);

// ---------------------------------------------------------------- config (auto-record is opt-in, off by default)
const here = path.dirname(fileURLToPath(import.meta.url));
const repliesConfigPath = path.join(path.resolve(here, '..'), 'config', 'replies.json');

/** `{auto_record_enabled}` from config/replies.json. Missing, unreadable, invalid or non-boolean => false (never auto-record). */
export function loadRepliesConfig(file: string = repliesConfigPath): RepliesConfig {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).auto_record_enabled : undefined;
    return { auto_record_enabled: v === true };
  } catch {
    return { auto_record_enabled: false };
  }
}

// ---------------------------------------------------------------- senders
const FREEMAIL = ['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.in', 'yahoo.in', 'yahoo.co.uk', 'ymail.com', 'rocketmail.com', 'outlook.com', 'outlook.in', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'live.in', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'protonmail.com', 'proton.me', 'pm.me', 'zoho.com', 'zohomail.in', 'zohomail.com', 'gmx.com', 'gmx.net',
  'mail.com', 'rediffmail.com', 'fastmail.com', 'yandex.com', 'tutanota.com'];
const JOB_BOARDS = ['naukri.com', 'naukrigulf.com', 'linkedin.com', 'indeed.com', 'glassdoor.com', 'foundit.in', 'monster.com', 'monsterindia.com', 'instahyre.com', 'wellfound.com', 'angel.co',
  'cutshort.io', 'hirist.tech', 'hirist.com', 'ziprecruiter.com', 'shine.com', 'timesjobs.com', 'apna.co', 'internshala.com', 'unstop.com', 'dice.com', 'simplyhired.com', 'careerbuilder.com'];
const ATS_DOMAINS = ['greenhouse.io', 'greenhouse-mail.io', 'lever.co', 'ashbyhq.com', 'myworkday.com', 'workday.com', 'smartrecruiters.com', 'icims.com', 'jobvite.com', 'taleo.net',
  'workable.com', 'bamboohr.com', 'recruitee.com', 'breezy.hr', 'zohorecruit.com', 'successfactors.com', 'teamtailor.com', 'pinpointhq.com'];
const SHARED = new Set([...FREEMAIL, ...JOB_BOARDS, ...ATS_DOMAINS]);
const ATS_SENDERS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkday.com', 'smartrecruiters.com', 'icims.com'];
const inList = (dom: string | null, list: readonly string[]) => !!dom && list.some((d) => dom === d || dom.endsWith(`.${d}`));
const isShared = (dom: string | null) => !!dom && (SHARED.has(dom) || inList(dom, JOB_BOARDS) || inList(dom, ATS_DOMAINS));
const AUTOMATED_LOCAL = /no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|^(?:news|newsletter|marketing|digest|alerts?|jobalerts?|notifications?|mailer|updates?|bounce|system)(?![a-z])/i;

export function emailAddress(from: string): string | null {
  const f = clamp(from, 500);
  const m = /<([^>\s]+@[^>\s]+)>/.exec(f) ?? /([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/.exec(f);
  return m ? m[1].toLowerCase() : null;
}

export function domainOf(addr: string | null | undefined): string | null {
  const m = /@([\w.-]+)$/.exec(clamp(addr, 500).trim().toLowerCase());
  return m ? m[1] : null;
}

const localOf = (addr: string | null) => (addr ? addr.slice(0, addr.lastIndexOf('@')) : '');

// ---------------------------------------------------------------- phrase tables
const BOUNCE_SENDER = /\b(?:mailer-daemon|mailerdaemon|postmaster|mail delivery (?:sub)?system)\b/i;
const BOUNCE_TEXT = [/delivery status notification/i, /\bundeliverable\b/i, /\bundelivered mail\b/i, /\b(?:wasn't|was not|could not be|couldn't be|failed to be) delivered\b/i,
  /\baddress not found\b/i, /\bdelivery has failed\b/i, /\bmail delivery failed\b/i, /\bdelivery failure\b/i, /\bno such user\b|\buser unknown\b/i,
  /\b(?:mailbox|inbox) (?:is )?(?:full|unavailable|not found)\b/i, /\b5\d\d [45]\.\d\.\d\b/];
const NOISE = [/\bjob alerts?\b/i, /\bjobs you may be interested in\b/i, /\brecommended jobs\b/i, /\bnewsletter\b/i, /\bwebinar\b/i, /\blive (?:session|webinar|event)\b/i,
  /\b(?:profile|application) (?:was |has been )?viewed\b/i, /\bviewed your (?:profile|application)\b/i];
const OUT_OF_OFFICE = [/\bout of (?:the )?office\b/i, /\bautomatic reply\b|\bauto[- ]?repl(?:y|ied)\b|\bautoreply\b/i, /(?:^|\n)\s*auto:/i,
  /\b(?:i am|i'm|i will be|i'll be|currently|we are|we're) (?:currently )?(?:away|out of town|travell?ing|unavailable)\b/i,
  /\b(?:i am|i'm|i will be|i'll be|currently|we are|we're) (?:currently )?on (?:[a-z-]+ ){0,2}?(?:leave|vacation|holiday|holidays|break|pto|sabbatical|furlough)\b/i,
  /\baway until\b|\baway till\b|\baway from (?:my )?(?:desk|email)\b/i, /\bon (?:[a-z-]+ ){0,2}?(?:vacation|leave|holiday) (?:until|till)\b/i, /\bwith (?:limited|no) (?:access to )?(?:e-?mail|internet)\b/i,
  /\bchecking (?:my )?(?:e-?mails?|messages) (?:only )?(?:intermittently|occasionally|infrequently|sporadically)\b/i, /\bchh?utti\b/i, /\bout of town\b/i,
  /\b(?:will be|am|i'm) (?:back|returning) (?:on|in|by)\b/i, /\bnicht im b(?:ü|u|ue)ro\b/i, /\babsente? du bureau\b/i,
  /\bwill (?:respond|reply|get back to you|be back|return)\b[^.]{0,30}\b(?:when|once|after|upon) i\b/i];

// Rejections. STRONG phrases are unambiguous and make a mail auto-record ELIGIBLE; WEAK phrases still classify rejected but are proposal-only.
const REJECT_STRONG = [/\bregret to (?:inform|tell|let)\b/i, /\bdecided (?:not to|to not) (?:proceed|move forward|progress|pursue|continue|move ahead|take)\b/i,
  /\b(?:will not|won't|are not|aren't|am not|not|cannot|can't|unable to)\s+(?:be\s+)?(?:move|moving|proceed|proceeding|progress|progressing|go|going|take|taking)\s+(?:ahead|forward|further|with|your|this)\b/i,
  /\b(?:proceed(?:ed|ing)?|mov(?:e|ed|ing)|go(?:ne|ing)?)\s+(?:ahead\s+|forward\s+)?with\s+(?:other|another|different|someone|a different)\b/i,
  /\bpursu(?:e|ing) other (?:candidates|applicants)\b/i, /\bfound (?:another|a better) (?:candidate|fit)\b/i,
  /\b(?:position|role|job|vacancy|opening|requisition) (?:has|have) (?:already )?been (?:filled|closed|cancell?ed)\b/i,
  /\bno longer (?:available|open|accepting|considering|hiring|looking)\b/i, /\bnot (?:been )?(?:selected|shortlisted|chosen)\b/i,
  /\bcurrent status:?\s*(?:no longer under consideration|not selected|rejected|unsuccessful)\b/i, /\bno longer under consideration\b/i];
const REJECT_WEAK = [/\bnot (?:a )?(?:good )?(?:fit|match)\b/i, /\b(?:(?:are|is|am) not|aren't|isn't|'re not|'m not)\s+(?:currently\s+)?(?:hiring|looking|recruiting)\b/i,
  /\b(?:don't|do not|doesn't|does not|have no|has no)\s+(?:currently\s+)?(?:have\s+)?(?:an?\s+|any\s+)?(?:suitable\s+|matching\s+|relevant\s+|open\s+|current\s+|available\s+)*(?:openings?|positions?|vacanc(?:y|ies)|roles?)\b/i,
  /\bunable to (?:offer|proceed|move forward|consider)\b/i, /\bno (?:open )?(?:positions|openings|vacancies)\b/i,
  /\b(?:position|role|job|hiring|requisition|vacancy|opening)\b[^.]{0,30}\b(?:on hold|frozen|freeze)\b|\bhiring (?:freeze|pause)\b/i,
  /\b(?:was|been|is|has been) unsuccessful\b/i, /\brespectfully decline\b/i, /\bdifferent direction\b/i, /\bcandidates whose\b/i,
  /\bnot (?:be )?(?:extending|making|sending|issuing) (?:you )?(?:an|the) offer\b/i,
  /\b(?:does not|doesn't|did not|didn't) (?:match|meet|fit) (?:our|the) (?:current )?(?:requirements|needs|criteria)\b/i,
  /\bnahi le (?:ja|jaa) rahe\b/i, /\bclose ho (?:gayi|gaya|gai)\b/i,
  /\b(?:cannot|can't|can not|unable to) make (?:you )?an offer\b/i, /\bclosed the (?:req|requisition)\b/i, /\binternal candidate\b/i, /\bpursu(?:e|ing) candidates (?:with|who|whose)\b/i,
  /\baage nahi badh\b/i, /\bkisi aur ko finali[sz]e\b/i, /\blamentablemente\b/i];
const OFFER = [/\b(?:pleased|delighted|happy|thrilled) to offer\b/i, /\boffer letter\b/i, /\bextend(?:ing)? (?:you )?an offer\b/i, /\bmake you an offer\b/i,
  /\boffer you (?:the|a) (?:role|position|job)\b/i, /\bjob offer\b/i, /\boffer of employment\b/i];
const NEGATION = /\b(?:not|never|unable|cannot|can't|won't|wouldn't|no longer|n't)\b/i;

// Interview/scheduling. A scheduling VERB alone decides nothing: it needs a concrete time or day (TIME) in the text. STANDALONE signals are concrete on their own.
const TIME = /\b(?:today|tomorrow|tonight|this (?:week|evening|afternoon|morning)|next (?:week|month|mon|tue|wed|thu|fri|sat|sun)\w*|(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?|\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)|\d{1,2}(?:st|nd|rd|th)\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|what times?|slots?)\b/i;
const SCHED_VERB = [/\b(?:schedule|scheduling|set up|setting up|arrange|arranging|book|booking|organi[sz]e)\s+(?:a|an|the|your|our|some|another|that|this)?\s*(?:[\w-]+\s+){0,3}?(?:call|chat|interview|meeting|conversation|discussion|round|screen|screening|time|slot)\b/i,
  /\b(?:can|could) we (?:connect|talk|chat|speak|catch up|hop on|jump on|meet|discuss)\b/i, /\blet'?s (?:connect|talk|chat|speak|catch up|schedule|set up|hop)\b/i,
  /\b(?:would like to|want to|like to|can|could|will) (?:call|phone|ring|speak (?:to|with)|talk (?:to|with)) you\b/i, /\bgive you a (?:call|ring)\b/i];
// A scheduling ASK addressed to the candidate ("let's set up a call", "can we talk next Monday"): only these (with a concrete time) beat an
// out-of-office phrase. A delegation ("schedule a call with him") or a promise ("will call you on my return") does not.
const HUMAN_ASK = [/\blet'?s (?:connect|talk|chat|speak|catch up|schedule|set up|hop on|jump on|meet)\b/i, /\b(?:can|could|shall) we (?:connect|talk|chat|speak|catch up|hop on|jump on|meet|discuss|schedule|set up|do)\b/i];
const SCHEDULED_CONFIRM =/\b(?:is|are|has been|have been|been) (?:scheduled|confirmed) (?:for|on)\b|\binterview (?:is |has been )?(?:scheduled|confirmed)\b|\binterview with [\w .&'-]{1,60} has been (?:scheduled|confirmed)\b|\binvited to the following event\b/i;
// "your availability" only counts as a request (share/confirm/send/let me know ...) alongside an invitation or scheduling verb; a bare mention ("got your availability") decides nothing.
const AVAIL_REQUEST = /\b(?:share|confirm|send|provide|let me know)\b[^.?!]{0,30}\bavailability\b/i;
const INVITE_VERB = /\b(?:invite[ds]?|invitation|schedule[ds]?|set up|arrange|book|interview|call|chat|round|meeting|screen|discussion)\b/i;
// A reschedule/cancellation mail talks about a live interview and must never be read as a verdict.
const RESCHEDULE_VETO = /\b(?:reschedul\w*|cancel{1,2}(?:ed|ing|led)|postpon\w*|stands cancel{1,2}ed|new slot|another (?:time|slot|day)|alternative (?:time|slot)|move our (?:call|interview|meeting)|(?:can't|cannot|can not) make (?!an offer)|unwell|sick|emergency)\b/i;
const REFUSED_OBJECT = /^\s*(?:with |on |for )?(?:the |our |your |this |that |a |an |next )?(?:[\w'-]+ ){0,2}?(?:call|slot|interview|meeting|day|week|today|tomorrow|(?:mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;
const INTERVIEW_STANDALONE = [/\bcalendly\.com\b|\bcal\.com\/|\bzoom\.us\b|\bmeet\.google\.com\b|\bteams\.microsoft\.com\/l\/meetup/i,
  /\bare you (?:free|available)\b/i, /\bwhen (?:are|would|will) you (?:be )?(?:free|available)\b/i, /\bwhat times? (?:work|suit)s?\b/i,
  /\bshare (?:a|your|some) (?:good |convenient |suitable |preferred )?(?:times?|slots?)\b/i, /\bconvenient (?:time|slot)\b/i, /\bconfirm (?:your |the |a )?(?:availability|slot|time)\b/i, /\bbook a slot\b/i,
  SCHEDULED_CONFIRM, /\bcome in (?:on|for|tomorrow|today|this|next)\b/i,
  /\b(?:take[\s-]home|coding (?:challenge|test|assessment)|technical (?:assessment|test)|online (?:test|assessment)|assignment brief|attached assignment|complete (?:this|the) (?:test|assessment|assignment))\b/i,
  /\bhackerrank\b|\bcodility\b|\bcodesignal\b/i, /\b(?:can|could) (?:you|we) do (?:mon|tue|wed|thu|fri|sat|sun|tomorrow|today|next|this)/i];

// Acknowledgements. STRONG ones win before rejection/interview/offer (only when none of those fired); WEAK ones ("thanks for applying") only when nothing else did.
const ACK_STRONG = [/\b(?:we have|we've|we) received your (?:application|email|e-mail|message|request|resume|cv|enquiry|inquiry)\b/i,
  /\byour (?:application|request|message|email|submission) (?:has|have) been (?:received|submitted|forwarded)\b/i, /\bthis is an? (?:automated|automatic|auto-generated)\b/i,
  /\bplease do not reply\b|\bdo not reply to this\b/i, /\b(?:get back to you|reach out|contact you|be in touch|let you know) if\b/i,
  /\b(?:if|should) (?:you are |you're |we |your profile is )?(?:not )?(?:shortlisted|selected|a match|a fit)\b/i, /\bonly (?:selected|shortlisted) candidates\b/i, /\bshortlisted candidates (?:will|take|are)\b/i,
  /\bnext steps?:?\s*our team (?:reviews|will review)\b/i, /\bwill be (?:reviewed|reviewing|considered)\b/i, /\bunder review\b/i, /\brespond within \d+/i];
// "our team will review it there" is an acknowledgement only from an automated sender; from a human it is a plain reply.
const ACK_AUTOMATED_ONLY = /\bteam (?:will|is|are) (?:still )?(?:review|reviewing)\b/i;
const HUMAN_ACTION = /\b(?:i|i've|i have|i'll|i will|i just|i've just|i have just|i already)\s+(?:have\s+)?(?:just\s+|already\s+)?(?:forwarded|passed (?:on|along)|shared|sent|referred)\s+(?:your|you)\b/i;
const ACK_WEAK =[/\bthank(?:s| you) for (?:contacting|applying|your (?:application|interest|email|message|submission))\b/i, /\bwill (?:get back|respond|reply|revert) to you (?:shortly|soon|within)\b/i];
// A sentence that only says what happens "if/should/once" something occurs is not a statement about THIS application.
const CONDITIONAL = /\b(?:if|in case|should|unless|once|whenever)\b/i;
const PIVOT = /\b(?:but|however|although|though)\b/i;
// After a "but" the sentence turns to something else (a referral, another role, a call): the rejection before it is then not the message's verdict.
const REDIRECT = /\b(?:refer\w*|passed|forwarded|pass(?:ing)?|might|may|could|who is|other (?:team|role|opening|position)|another (?:team|role|opening|position)|senior|call|schedule|interview|assignment|talk|chat|meet|reconnect|revisit|in january|next quarter|hiring freeze|later)\b/i;

// ---------------------------------------------------------------- quote stripping
const ent: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', ndash: '-', mdash: '-', hellip: '...',
  copy: '(c)', reg: '(r)', trade: '(tm)', bull: '*', middot: '.', laquo: '"', raquo: '"', eacute: 'e', egrave: 'e', agrave: 'a', ccedil: 'c' };
/** Decode entities in ONE pass (so `&amp;lt;` stays `&lt;`, never becomes `<`). */
function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([\da-fA-F]{1,6})|([a-zA-Z]{2,8}));/g, (all, dec?: string, hex?: string, name?: string) => {
    if (name) return ent[name.toLowerCase()] ?? all;
    const cp = dec ? parseInt(dec, 10) : parseInt(hex ?? '', 16);
    if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return all;
    return cp === 0xa0 ? ' ' : String.fromCodePoint(cp);
  });
}

/** HTML-only mail (gmail.read_email returns the raw HTML when there is no text part): drop comments, mso conditionals and hidden
 *  (display:none) blocks, cut quoted history, strip tags, decode entities once. All quantifiers bounded. */
function htmlToText(html: string): string {
  const clean = html
    .replace(/<!--[\s\S]{0,5000}?-->/g, ' ')
    .replace(/<!\[(?:if|endif)[^\]]{0,200}\]>/gi, ' ')
    .replace(/<(div|span|p|td|tr|table|font)\b[^>]{0,300}(?:display\s{0,5}:\s{0,5}none|mso-hide\s{0,5}:\s{0,5}all|visibility\s{0,5}:\s{0,5}hidden)[^>]{0,300}>[\s\S]{0,5000}?<\/\1>/gi, ' ');
  const cut = clean.search(/<[a-z][^>]{0,500}?(?:class="[^"]{0,200}(?:gmail_quote|yahoo_quoted|moz-cite-prefix|protonmail_quote|OutlookMessageHeader)|id="(?:divRplyFwdMsg|appendonsend)")|<blockquote/i);
  const head = cut >= 0 ? clean.slice(0, cut) : clean;
  return decodeEntities(head
    .replace(/<(style|script|head)\b[\s\S]{0,5000}?<\/\1>/gi, ' ')
    .replace(/<br\s{0,20}\/?>|<\/(?:p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]{1,500}>/g, ''))
    .replace(/[ \t]+\n/g, '\n');
}

const WROTE = /(?:wrote|a écrit|a ecrit|schrieb|escribió|escribio|ha scritto|escreveu)\s{0,3}:?\s{0,3}$/i;

/** Cut quoted history so our own words cannot classify the reply: HTML quotes, "> " lines, "On ... wrote:" (and a few languages), Outlook headers/underscore
 *  lines, forwarded blocks, and an UNMARKED quote (a second greeting line like "Hi Neha," after the first paragraph: our own mail was addressed to them). */
export function stripQuoted(body: string): string {
  const raw = clamp(body);
  const text = /<\s*(?:html|body|div|p|br|blockquote|span|table|a)\b|<!--/i.test(raw) ?htmlToText(raw) : raw;
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let hasText = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1] ?? '';
    if (/^\s*On\b.{3,250}\bwrote:\s*$/.test(line) || (/^\s*On\b.{3,250}$/.test(line) && /^\s*wrote:\s*$/.test(next))) break;
    if (/^\s*(?:Le|Am|El|Il|Em)\b.{3,250}$/.test(line) && WROTE.test(line)) break;
    if (/^-{2,}\s*(?:Original Message|Forwarded message)\s*-{2,}/i.test(line.trim()) || /^_{5,}\s*$/.test(line.trim())) break;
    if (/^\s*From:\s.+@/.test(line)) break;
    if (/^\s*From:\s/.test(line) && lines.slice(i + 1, i + 6).some((l) => /^\s*(?:Sent|Date|To|Cc|Subject):/i.test(l))) break;
    if (hasText && /^\s*(?:hi|hello|dear|hey)\s+[A-Za-z][\w .'-]{0,40}[,:]/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    if (line.trim()) hasText = true;
    out.push(line);
  }
  return out.join('\n').trim();
}

// A sign-off line ("Best,", "Regards,", "Thanks,") or a "-- " signature delimiter ends the reply's own content: what follows is a
// signature or a marketing footer ("Join our webinar", "Subscribe to our newsletter") and must not decide noise or out-of-office.
const SIGNOFF = /^\s*(?:best|best regards|best wishes|kind regards|warm regards|warmest regards|regards|many thanks|thanks|thanks (?:and|&) regards|thank you|cheers|sincerely|yours sincerely|yours truly|br|thanks again)\s*[,.!]?\s*$/i;
const SIG_DELIM = /^\s*--\s*$/;
/** The reply's own text before the first sign-off or signature delimiter that follows some content; the whole text when there is none. */
export function mainContent(own: string): string {
  const lines = own.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!SIG_DELIM.test(lines[i]) && !SIGNOFF.test(lines[i])) continue;
    const before = lines.slice(0, i).join('\n');
    if (before.trim()) return before;
  }
  return own;
}

/** True for a mass/automated sender: no-reply style local parts, ATS and job-board domains, and bounce daemons. A human address is anything else. */
export function isAutomatedSender(from: string | null | undefined): boolean {
  const f = clamp(from, 500);
  if (BOUNCE_SENDER.test(f)) return true;
  const addr = emailAddress(f) ?? (f.includes('@') ? f.trim().toLowerCase() : null);
  const dom = domainOf(addr);
  return AUTOMATED_LOCAL.test(localOf(addr)) || inList(dom, ATS_DOMAINS) || inList(dom, JOB_BOARDS);
}

const sentences = (t: string) => t.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Defence in depth for quote styles `stripQuoted` does not know: drop every reply sentence (20+ chars) that is verbatim a sentence of OUR sent email. */
function withoutOurs(text: string, ours: string): string {
  if (!ours.trim()) return text;
  const o = ` ${norm(clamp(ours))} `;
  return sentences(text).filter((s) => { const n = norm(s); return n.length < 20 || !o.includes(` ${n} `); }).join('\n');
}

/** A rejection phrase in `s` that survives the "but" rule: if the sentence pivots to something else (a referral, another role, a call) the rejection is not its verdict. */
function rejectionHit(s: string, patterns: RegExp[]): boolean {
  if (!patterns.some((r) => r.test(s))) return false;
  const p = PIVOT.exec(s);
  return !(p && REDIRECT.test(s.slice(p.index + p[0].length)));
}

/** Classification plus whether the mail is ELIGIBLE for auto-record (strong unambiguous signal, non-automated sender). Order: bounce, noise (text or
 *  job-board sender), out-of-office, strong auto-acknowledgement, then rejection / offer / interview (a mail with BOTH an interview and a rejection signal is
 *  only `replied`), weak acknowledgement, any other human text = replied, empty = unknown. Signals come only from the subject and the reply's own text. */
export function classifyReplyDetail(subject: string, body: string, from = '', ours = ''): ReplyClassification {
  const own = withoutOurs(stripQuoted(body), ours);
  const head = own.slice(0, 3000).replace(/[‘’]/g, "'");
  const subj = clamp(subject, 1000).replace(/[‘’]/g, "'");
  const text = `${subj}\n${head}`;
  const addr = emailAddress(from);
  const dom = domainOf(addr);
  const automated = AUTOMATED_LOCAL.test(localOf(addr)) || inList(dom, ATS_DOMAINS);
  const no = (cls: ReplyClass): ReplyClassification => ({ cls, eligible: false });
  const firmOf = (s: string, body: string) => [s, ...sentences(body)].filter((x) => !CONDITIONAL.test(x)).join('\n');
  const schedOf = (f: string) => INTERVIEW_STANDALONE.some((r) => r.test(f)) || (TIME.test(f) && SCHED_VERB.some((r) => r.test(f))) || (AVAIL_REQUEST.test(f) && INVITE_VERB.test(f));

  if (BOUNCE_SENDER.test(clamp(from, 500)) || BOUNCE_TEXT.some((r) => r.test(text))) return no('bounce');
  // Noise and out-of-office are judged on the reply's own content only (not its signature/footer). A human sender's scheduling ask in that
  // content ("are you available Tuesday at 3pm", "I'm travelling, could we do Monday 11am?") wins over both; such a mail is never auto-recorded.
  const main = `${subj}\n${mainContent(head)}`;
  const mainFirm = firmOf(subj, mainContent(head));
  const humanSched = !automated && (INTERVIEW_STANDALONE.some((r) => r.test(mainFirm)) || (TIME.test(mainFirm) && HUMAN_ASK.some((r) => r.test(mainFirm))) || (AVAIL_REQUEST.test(mainFirm) && INVITE_VERB.test(mainFirm)));
  const mixed = NOISE.some((r) => r.test(main)) || OUT_OF_OFFICE.some((r) => r.test(main));
  if (!humanSched && NOISE.some((r) => r.test(main))) return no('noise');
  if (!humanSched && OUT_OF_OFFICE.some((r) => r.test(main))) return no('auto_ack');

  const firmSentences = [subj, ...sentences(head)].filter((s) => !CONDITIONAL.test(s));
  const firm = firmSentences.join('\n');
  const rejStrong = firmSentences.some((s) => rejectionHit(s, REJECT_STRONG));
  const rejWeak = !rejStrong && firmSentences.some((s) => rejectionHit(s, REJECT_WEAK));
  const rej = rejStrong || rejWeak;
  const offer = firmSentences.some((s) => OFFER.some((r) => r.test(s)) && !NEGATION.test(s));
  const sched = humanSched || schedOf(firm);
  // An automated sender (no-reply, ATS notification) can only evidence an interview by a plain "has been scheduled/confirmed" or a calendar invite.
  const interview = sched && (!automated || SCHEDULED_CONFIRM.test(firm));

  // A job-board mailer is noise, unless it carries a rejection or a confirmed interview: then a human must look (proposal, never ignored).
  if (inList(dom, JOB_BOARDS)) return no(rej || SCHEDULED_CONFIRM.test(firm) ? 'replied' : 'noise');
  // Reschedule / cancellation talk, or a rejection whose refused object is a call/slot/interview/day: about a live interview, never a verdict. Proposal only.
  const refusedSchedule = firmSentences.some((s) => REJECT_STRONG.some((r) => { const m = r.exec(s); return !!m && REFUSED_OBJECT.test(s.slice(m.index + m[0].length, m.index + m[0].length + 70)); }));
  if ((rej || interview || offer) && (RESCHEDULE_VETO.test(text) || refusedSchedule)) return no('replied');
  // Scheduling vocabulary from an ATS/automated sender that is not a plain confirmation is still shown to the user, never silently ignored.
  if (automated && sched && !interview && !rej) return no('replied');

  // "I have forwarded your resume to the hiring manager" from a human is a person acting on THIS application: a reply, never an acknowledgement.
  const personal = !automated && HUMAN_ACTION.test(firm);
  if (!personal && ACK_STRONG.some((r) => r.test(text)) && !rej && !offer && !interview) return no('auto_ack');
  if (automated && ACK_AUTOMATED_ONLY.test(text) && !rej && !offer && !interview) return no('auto_ack');
  if (rej && interview) return no('replied');
  if (rej) return { cls: 'rejected', eligible: rejStrong && !mixed };
  if (offer) return no('offer');
  if (interview) return { cls: 'interview', eligible: !automated && !mixed };
  if (!personal && ACK_WEAK.some((r) => r.test(text))) return no('auto_ack');
  if (!own.trim()) return no('unknown');
  // Leftover text from an automated sender is not a human reply: an ATS notification is an acknowledgement, anything else (newsletter, no-reply) is noise.
  if (automated) return no(inList(dom, ATS_DOMAINS) ? 'auto_ack' : 'noise');
  return no('replied');
}

export function classifyReply(subject: string, body: string, from = '', ours = ''): ReplyClass {
  return classifyReplyDetail(subject, body, from, ours).cls;
}

// ---------------------------------------------------------------- matching
const LEGAL = /\b(?:inc|llc|ltd|limited|pvt|private|plc|gmbh|corp|corporation|co|company|llp)\b\.?/g;
const normCompany = (c: string) => c.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim();
function companyMentioned(text: string, company: string | null): boolean {
  if (!company) return false;
  const key = normCompany(company);
  if (!key) return false;
  const hay = ` ${text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;
  return hay.includes(` ${key} `);
}

function pick(level: ReplyMatch['confidence'], via: ReplyMatch['via'], hits: SentEmail[]): ReplyMatch | null {
  const ids = [...new Set(hits.map((h) => h.job_id))];
  if (ids.length === 1) return { job_id: ids[0], confidence: level, via };
  if (ids.length > 1) return { job_id: null, confidence: 'none', via: 'ambiguous', candidates: ids };
  return null;
}

export function matchReply(msg: IncomingMessage, sent: SentEmail[]): ReplyMatch {
  if (msg.thread_id) {
    const r = pick('high', 'thread', sent.filter((s) => s.thread_id && s.thread_id === msg.thread_id));
    if (r) return r;
  }
  const addr = emailAddress(msg.from);
  if (addr) {
    const r = pick('high', 'sender', sent.filter((s) => (s.email_to ?? '').toLowerCase() === addr));
    if (r) return r;
    const dom = domainOf(addr);
    if (dom && !isShared(dom)) {
      const r2 = pick('medium', 'domain', sent.filter((s) => domainOf(s.email_to) === dom));
      if (r2) return r2;
    }
  }
  const hay = `${clamp(msg.subject, 1000)}\n${stripQuoted(msg.body)}`;
  const r3 = pick('low', 'company', sent.filter((s) => companyMentioned(hay, s.company)));
  return r3 ?? { job_id: null, confidence: 'none', via: 'none' };
}

// ---------------------------------------------------------------- decisions
const OUTCOME: Partial<Record<ReplyClass, Outcome>> = { rejected: 'rejected', offer: 'offer', interview: 'interview', replied: 'replied' };
// Auto-record only climbs the ladder none/replied -> interview or rejected. Anything else already recorded (interview, rejected, offer, hired) needs the user.
const LADDER_START: ReadonlySet<Outcome | null> = new Set<Outcome | null>([null, 'no_response', 'replied']);

/** Only `interview` and `rejected` (strong phrase, non-automated sender = `eligible`) can ever be auto-recorded, and only when the config enables it, on a
 *  high-confidence match, and only from no outcome / no_response / replied (never rejected over interview or interview over rejected). Everything that would
 *  have been auto-recorded is a PROPOSAL when auto-record is off (the default). `replied` and `offer` are always proposed. A bounce is never an outcome: it is reported. */
export function decideReply(cls: ReplyClass, m: ReplyMatch, latest: Outcome | null = null, config: RepliesConfig = loadRepliesConfig(), eligible = true): ReplyDecision {
  if (cls === 'bounce') return { action: 'report', outcome: null, reason: m.job_id ? `bounce for job ${m.job_id} via ${m.via}` : 'bounce (job unknown)' };
  const outcome = OUTCOME[cls] ?? null;
  if (!outcome) return { action: 'ignore', outcome: null, reason: `${cls} is not an outcome` };
  if (!m.job_id) return { action: 'ignore', outcome: null, reason: `unmatched (${m.via})` };
  if (cls === 'offer') return { action: 'propose', outcome, reason: 'offers always need approval' };
  if (cls === 'replied') return { action: 'propose', outcome, reason: 'a plain reply is proposed, never auto-recorded' };
  if (m.confidence !== 'high') return { action: 'propose', outcome, reason: `${m.confidence}-confidence match via ${m.via}` };
  if (!eligible) return { action: 'propose', outcome, reason: 'signal is not strong enough to auto-record' };
  if (!LADDER_START.has(latest)) return { action: 'propose', outcome, reason: `would not raise the recorded outcome (${latest})` };
  if (!config.auto_record_enabled) return { action: 'propose', outcome, reason: 'auto-record is off (config/replies.json auto_record_enabled)' };
  return { action: 'auto_record', outcome, reason: `${cls} reply via ${m.via}` };
}

// ---------------------------------------------------------------- Gmail query
const ADDRESS = /^[\w.+'-]+@[\w.-]+$/;

/** LEGACY single query (capped at 20 companies/domains/addresses, so it can miss jobs): list_sent_emails uses buildReplyQueries.
 *  Gmail query for replies: never `in:inbox` (it hides archived/filtered mail). Newest sends first so the 20-term caps keep recent jobs;
 *  shared-domain recipients (gmail.com etc.) get an exact `from:<address>`; 60 days matches the stale sweep. `-in:sent` is also what
 *  keeps our own messages out of the results (the watcher does not filter by own address). */
export function buildReplyQuery(sent: SentEmail[], newerThanDays = 60): string {
  const newest = [...sent].sort((a, b) => b.sent_at.localeCompare(a.sent_at));
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];
  const companies = uniq(newest.map((s) => (s.company ?? '').replace(/["{}]/g, '').trim()).filter(Boolean)).slice(0, 20).map((c) => `"${c}"`);
  const recipients = newest.map((s) => (s.email_to ?? '').trim().toLowerCase()).filter((a) => ADDRESS.test(a));
  const domains = uniq(recipients.map((a) => domainOf(a)).filter((d): d is string => !!d && !isShared(d))).slice(0, 20);
  const addresses = uniq(recipients.filter((a) => isShared(domainOf(a)))).slice(0, 20);
  const terms = [...companies, ...[...domains, ...addresses, ...ATS_SENDERS].map((d) => `from:${d}`)];
  return `newer_than:${newerThanDays}d -in:sent -in:drafts {${terms.join(' ')}}`;
}

/** The stale threshold (days since last contact) shared by the stale sweep and the follow-up cut-off. */
export const STALE_DAYS = 60;
/** ONE reply-search window: it must reach past the stale threshold so every job that can still be a follow-up candidate or stale is covered. */
export const REPLY_WINDOW_DAYS = Math.max(60, STALE_DAYS + 10);
export const QUERY_MAX_TERMS = 15;

/** Every company, recipient domain (exact address for shared domains like gmail.com) and ATS sender, with NO cap, split into several
 *  Gmail queries of at most `maxTerms` OR-terms each (newest sends first). The reply watcher runs every one of them. */
export function buildReplyQueries(sent: SentEmail[], newerThanDays = REPLY_WINDOW_DAYS, maxTerms = QUERY_MAX_TERMS): string[] {
  const newest = [...sent].sort((a, b) => String(b.sent_at ?? '').localeCompare(String(a.sent_at ?? '')));
  const uniq = <T,>(xs: T[]) => [...new Set(xs)];
  const companies = uniq(newest.map((s) => (s.company ?? '').replace(/["{}]/g, '').trim()).filter(Boolean)).map((c) => `"${c}"`);
  const recipients = newest.map((s) => (s.email_to ?? '').trim().toLowerCase()).filter((a) => ADDRESS.test(a));
  const domains = uniq(recipients.map((a) => domainOf(a)).filter((d): d is string => !!d && !isShared(d)));
  const addresses = uniq(recipients.filter((a) => isShared(domainOf(a))));
  const terms = uniq([...companies, ...[...domains, ...addresses, ...ATS_SENDERS].map((d) => `from:${d}`)]);
  const size = Math.max(1, Math.floor(maxTerms));
  const out: string[] = [];
  for (let i = 0; i < terms.length; i += size) out.push(`newer_than:${newerThanDays}d -in:sent -in:drafts {${terms.slice(i, i + size).join(' ')}}`);
  return out;
}
