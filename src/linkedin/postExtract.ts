// Pure parsing of one LinkedIn content-search post card (lines already passed through the input gate).
// Nothing here fetches or follows anything: links and emails found in the text are only stored as data.
// Every page-shape assumption (line order, relative time wording, permalink shapes) is unverified against live LinkedIn.
import { POST_TITLE_FALLBACK_PREFIX } from '../lib/postSignals.js';

const ROLE_NOUN =
  '(?:engineer|developer|designer|manager|analyst|architect|lead|scientist|consultant|recruiter|specialist|accountant|intern|programmer|administrator|officer|executive|tester|sdet|devops|director|writer|marketer|associate)s?';

// ---- permalink ----------------------------------------------------------------------------------------------------

export interface PostRef { id: string; url: string }

/** Canonical post reference from a permalink href or a data-urn, or null. Never a profile URL. */
export function postRefFrom(href: string | undefined, urn: string | undefined): PostRef | null {
  const h = String(href ?? '').trim();
  if (h) {
    let path = h;
    try {
      const abs = h.startsWith('/') && !h.startsWith('//') ? `https://www.linkedin.com${h}` : h;
      const u = new URL(abs);
      if (u.protocol !== 'https:' || u.username || u.password || !(u.hostname === 'linkedin.com' || u.hostname.endsWith('.linkedin.com'))) return null;
      path = decodeURIComponent(u.pathname);
    } catch { return null; }
    const a = /\/feed\/update\/urn:li:(activity|share|ugcPost):(\d{6,25})/.exec(path);
    if (a) return build(a[1], a[2]);
    const b = /\/posts\/[^/]+-(activity|share|ugcPost)-(\d{6,25})(?:-|$|\/)/.exec(path);
    if (b) return build(b[1], b[2]);
  }
  const m = /urn:li:(activity|share|ugcPost):(\d{6,25})/.exec(String(urn ?? ''));
  return m ? build(m[1], m[2]) : null;
}
function build(kind: string, num: string): PostRef {
  return { id: `li-post:${num}`, url: `https://www.linkedin.com/feed/update/urn:li:${kind}:${num}/` };
}

// ---- time ---------------------------------------------------------------------------------------------------------

const TIME_LINE = /^(\d{1,3})\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|w|wk|wks|mo|mos|y|yr|yrs)\b(?!\w)/i;
const MS: Record<string, number> = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5, mo: 2592e6, y: 31536e6 };

/** True when a card line starts with a relative time such as "2d", "5h", "3w", "1mo" (an optional " • Edited" tail is fine). */
export function isTimeLine(line: string): boolean { return TIME_LINE.test(line.trim()); }

/** Absolute 'YYYY-MM-DD' (UTC) computed from the relative time text and the fetch time, or null. */
export function relativeToIso(text: string, now: Date): string | null {
  const m = TIME_LINE.exec(String(text ?? '').trim());
  if (!m) return null;
  const u = m[2].toLowerCase();
  const unit = u.startsWith('mo') ? 'mo' : u[0] === 's' ? 's' : u[0] === 'h' ? 'h' : u[0] === 'd' ? 'd' : u[0] === 'w' ? 'w' : u[0] === 'y' ? 'y' : 'm';
  const t = new Date(now.getTime() - Number(m[1]) * MS[unit]);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
}

// ---- hiring classifier ----------------------------------------------------------------------------------------------

const STRONG_HIRING = /\b(?:we(?:'|’)?re hiring|we are hiring|is hiring|are hiring|now hiring|hiring (?:a|an|for|multiple|\d+)\b|hiring:|#hiring|we(?:'|’)?re looking for|we are looking for|vacancy|job opening|open (?:position|role)s?)/i;
const WEAK_HIRING = /\b(?:looking for|join our team|join us|open position|opening)\b/i;
const APPLY_CUE = /\b(?:apply|send (?:your |me your )?(?:cv|resume|profile)|email|e-mail|dm me|comment (?:below|interested)|share your (?:cv|resume)|interested candidates|drop (?:your|a))\b/i;
const SEEKER =
  /(?:#?open ?to ?work|\bi(?:'|’)?m (?:currently )?(?:looking|searching|seeking)|\bi am (?:currently )?(?:looking|searching|seeking)|\blooking for (?:my next|a new) (?:role|opportunit|job|position|challenge)|\bseeking (?:a )?(?:new )?(?:role|opportunit|position|job)|\bavailable (?:for hire|immediately|to join)|\bactively looking\b|\blaid off\b|\blost my job\b|\bplease refer me\b|\bif you(?:'|’)?re hiring\b|\bif you are hiring\b|#hireme|\bmy resume\b|\bkindly refer\b)/i;
const ROLE_WORD = new RegExp(`\\b${ROLE_NOUN}\\b`, 'i');

export type PostVerdict = { hiring: true } | { hiring: false; reason: 'seeker' | 'not_hiring' | 'no_role' };

/** Conservative keyword rules: reject job-seeker posts, posts with no hiring cue, and promotional posts that name no role. */
export function classifyPost(text: string): PostVerdict {
  const t = String(text ?? '');
  const strong = STRONG_HIRING.test(t);
  if (SEEKER.test(t) && !/\bwe(?:'|’)?re hiring\b|\bwe are hiring\b|\bis hiring\b/i.test(t)) return { hiring: false, reason: 'seeker' };
  const weak = !strong && WEAK_HIRING.test(t) && APPLY_CUE.test(t);
  if (!strong && !weak) return { hiring: false, reason: 'not_hiring' };
  if (!ROLE_WORD.test(t)) return { hiring: false, reason: 'no_role' };
  return { hiring: true };
}

// ---- role / company / location / apply route -----------------------------------------------------------------------

const ROLE_FILLER = /^(?:an?|the|our|new|great|amazing|talented|experienced|multiple|several|\d+|skilled|passionate|awesome)\s+/i;
const cleanRole = (s: string): string => {
  let r = s.replace(/\s+/g, ' ').replace(/[*_#]+/g, '').trim();
  for (let i = 0; i < 3; i++) r = r.replace(ROLE_FILLER, '');
  return r.replace(/[\s:,.;-]+$/, '').slice(0, 80);
};

/** First role-like line or phrase from the post body, or null. */
export function extractRole(bodyLines: string[]): string | null {
  for (const l of bodyLines) {
    const m = /^(?:role|position|title|job title|opening|designation|hiring for)\s*[:\-]\s*(.{3,80})$/i.exec(l.trim());
    if (m) return cleanRole(m[1]) || null;
  }
  const re = new RegExp(
    `\\b(?:hiring|looking for|seeking|vacancy for|opening for|need|position of|role of|open (?:position|role)s? for)\\s*(?::|-)?\\s*((?:[\\w+#./&()-]+\\s+){0,5}?[\\w+#./&()-]*\\s*${ROLE_NOUN})\\b`, 'i',
  );
  const text = bodyLines.join(' ');
  const m = re.exec(text);
  if (m) {
    const r = cleanRole(m[1]);
    if (r && ROLE_WORD.test(r)) return r;
  }
  for (const l of bodyLines) {
    if (l.length <= 80 && ROLE_WORD.test(l) && !/[.!?]$/.test(l)) {
      const r = cleanRole(l.replace(/^[\W_]+/, ''));
      if (r) return r;
    }
  }
  return null;
}

const NOT_COMPANY = new Set(['my', 'our', 'this', 'we', 'who', 'the', 'company', 'team', 'everyone', 'startup', 'hiring', 'i', 'it', 'they', 'someone', 'anyone', 'a', 'an', 'now', 'urgent', 'urgently']);
const NAME = "[A-Z0-9][\\w&'-]*(?:\\.[\\w&'-]+)*(?:\\s+[A-Z0-9][\\w&'-]*(?:\\.[\\w&'-]+)*){0,3}";
const cleanCompany = (s: string): string => {
  let c = s.replace(/[.,;:!\s]+$/, '').replace(/\s+/g, ' ').trim();
  const w = c.split(' ');
  while (w.length && NOT_COMPANY.has(w[w.length - 1].toLowerCase())) w.pop();
  while (w.length && NOT_COMPANY.has(w[0].toLowerCase())) w.shift();
  c = w.join(' ');
  return c.length >= 2 && c.length <= 80 && !NOT_COMPANY.has(c.toLowerCase()) ? c : '';
};

/** Company from the post text ("hiring at X", "X is hiring", "join us at X"), else from the author headline ("... at X"), else ''. */
export function extractCompany(body: string, headline: string): { company: string; from: 'text' | 'headline' | 'none' } {
  const pats: RegExp[] = [
    new RegExp(`\\b(?:hiring|looking for[^.\\n]{0,60}?|openings?|opportunity|role|position|vacancy)\\s+(?:at|@)\\s*(${NAME})`),
    new RegExp(`\\bhiring\\b[^.\\n]{0,80}?\\s(?:at|@)\\s*(${NAME})`),
    new RegExp(`\\b(?:join(?: the team)?(?: us)?|team|come work)\\s+(?:at|@)\\s*(${NAME})`),
    new RegExp(`(${NAME})\\s+is\\s+(?:now\\s+|currently\\s+)?hiring\\b`),
    new RegExp(`\\bwork(?:ing)? (?:at|with)\\s+(${NAME})`),
  ];
  for (const p of pats) {
    const m = p.exec(body);
    if (m) { const c = cleanCompany(m[1]); if (c) return { company: c, from: 'text' }; }
  }
  const h = [...String(headline ?? '').matchAll(new RegExp(`(?:\\sat\\s|\\s@\\s?)(${NAME})`, 'g'))].pop();
  if (h) { const c = cleanCompany(h[1]); if (c) return { company: c, from: 'headline' }; }
  return { company: '', from: 'none' };
}

/** Location and remote hint when the post states them. */
export function extractLocation(bodyLines: string[]): { location: string; remote: boolean } | null {
  const text = bodyLines.join('\n');
  const remote = /\b(?:remote|work from home|wfh|anywhere in india)\b/i.test(text);
  let location = '';
  for (const l of bodyLines) {
    const m = /^(?:location|loc|based in|office)\s*[:\-]\s*([^|•\n]{2,60})$/i.exec(l.trim());
    if (m) { location = m[1].trim(); break; }
  }
  if (!location) {
    const m = /\b(?:based in|located in|office in|onsite in|on-site in|hybrid in|(?:hiring )?in)\s+([A-Z][A-Za-z]+(?:[ ,]+[A-Z][A-Za-z]+){0,2})(?=[\s.,;!|(]|$)/.exec(text);
    if (m && !/^(?:Our|The|This|Your|Us|India Remote)$/i.test(m[1])) location = m[1].trim();
  }
  location = location.replace(/[.,;\s]+$/, '').slice(0, 60);
  if (!location && !remote) return null;
  return { location, remote };
}

export interface ApplyRoute { email: string | null; link: string | null }

/** First email and first external https link in the text. Stored as data only, never opened. */
export function extractApplyRoute(text: string): ApplyRoute {
  const em = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}/.exec(text);
  let link: string | null = null;
  for (const m of text.matchAll(/https?:\/\/[^\s)>\]"']+/gi)) {
    const raw = m[0].replace(/[.,;:!?]+$/, '');
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:' || u.username || u.password) continue;
      if (u.hostname === 'linkedin.com' || u.hostname.endsWith('.linkedin.com')) continue;
      link = raw.slice(0, 300);
      break;
    } catch { /* skip */ }
  }
  return { email: em ? em[0].toLowerCase().slice(0, 120) : null, link };
}

// ---- card layout --------------------------------------------------------------------------------------------------

const DEGREE = /^(?:[•·]\s*)?(?:1st|2nd|3rd\+?)$|^[•·]\s*(?:1st|2nd|3rd\+?)\b/;
const ACTION_BAR = /^(?:like|comment|repost|send|share|react|celebrate|support|love|insightful|funny)$/i;
const MORE = /^(?:…|\.\.\.)?\s*(?:see )?more$/i;

export interface CardLayout { headline: string; timeText: string; bodyLines: string[] }

/**
 * Split card lines (author, [degree], headline, relative time, post text, [more], action bar) by position.
 * Without a recognizable time line the headline is the first line after the author and the rest is the body.
 */
export function splitCardLines(lines: string[], authorName: string): CardLayout {
  const ls = lines.map((l) => l.trim()).filter(Boolean);
  const isAuthor = (l: string) => !!authorName && (l === authorName || l.startsWith(authorName));
  let start = 0;
  while (start < ls.length && (isAuthor(ls[start]) || DEGREE.test(ls[start]))) start++;
  const tIdx = ls.findIndex((l, i) => i >= start && i <= start + 6 && isTimeLine(l));
  let headline = '';
  let timeText = '';
  let bodyStart: number;
  if (tIdx >= 0) {
    headline = ls.slice(start, tIdx).find((l) => !DEGREE.test(l) && !/^follow$/i.test(l)) ?? '';
    timeText = ls[tIdx];
    bodyStart = tIdx + 1;
  } else {
    headline = ls[start] && ls[start].length <= 200 ? ls[start] : '';
    bodyStart = headline ? start + 1 : start;
  }
  const body: string[] = [];
  for (const l of ls.slice(bodyStart)) {
    if (ACTION_BAR.test(l)) break;
    if (MORE.test(l)) continue;
    body.push(l.replace(/\s*(?:…|\.\.\.)\s*(?:see )?more$/i, ''));
  }
  return { headline, timeText, bodyLines: body };
}

export const fallbackTitle = (author: string): string => `${POST_TITLE_FALLBACK_PREFIX}${author || 'unknown author'}`.slice(0, 120);
