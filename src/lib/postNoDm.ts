// "Do not DM me" detector for LinkedIn hiring posts (source `linkedin-posts`). Post text is untrusted data: it is only
// read for these fixed phrases and never followed as an instruction. A hit means: no LinkedIn connect note, plain invite
// or message to the poster. The email path (an address in the post) and the link path are NOT affected.
// Negation aware: "DMs are welcome", "feel free to DM me", "don't hesitate to message" never match.
import type BetterSqlite3 from 'better-sqlite3';
import { POST_SOURCE } from './postSignals.js';
import { normalizeProfileKey } from '../outreach/people.js';

/** Reason code written when a poster send is refused because the post said not to DM. */
export const POSTER_NO_DM = 'poster_no_dm';

const DM = '(?:dms?|direct messages?|inmails?|in-mails?|linkedin messages?|messages?|msgs?)';
const MAIL = '(?:e-?mail|mail|email id|mail id)';
const HAS_EMAIL = /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*\.[a-z]{2,24}/;

const PATTERNS: RegExp[] = [
  // English: "no DMs", "no direct messages please"
  new RegExp(`\\bno\\s+${DM}\\b(?!\\s+(?:is|are)\\s+(?:welcome|fine|ok|okay))`),
  // "please don't DM", "do not message me", "dont inmail"
  new RegExp(`\\b(?:don'?t|do not|dont)\\s+(?:(?:please|kindly|pls)\\s+)?(?:dm|dms|message|inmail|ping|text)\\b`),
  // "do not contact me via DM", "don't reach out on linkedin messages"
  new RegExp(`\\b(?:don'?t|do not|dont)\\s+(?:contact|reach out(?: to)?)\\s+(?:me\\s+)?(?:via|on|through|by|over)\\s+(?:linkedin\\s+)?${DM}\\b`),
  // "DMs closed", "DMs are off"
  new RegExp(`\\b${DM}\\s+(?:are\\s+|is\\s+)?(?:closed|off|disabled|not (?:open|accepted|monitored|checked|being checked))\\b`),
  /\b(?:not|never)\s+(?:checking|reading|monitoring)\s+(?:my\s+)?(?:dms?|messages|inbox)\b/,
  // "email only", "mail only" (not "not only email")
  new RegExp(`(?<!not\\s)(?<!not just\\s)(?<!not only\\s)\\b${MAIL}\\s+only\\b`),
  // "only via email", "apply only by email", "only through mail"
  new RegExp(`(?<!not\\s)\\bonly\\s+(?:via|through|by|using|on|to)\\s+(?:the\\s+)?${MAIL}\\b`),
  // "apply through the link only", "apply via careers page only"
  /\b(?:apply|applications?)\s+(?:only\s+)?(?:via|through|using|on|at)\s+(?:the\s+)?(?:link|form|website|portal|careers? page|job portal)(?:\s+below|\s+in the comments)?\s+only\b/,
  /(?<!not\s)\bonly\s+(?:via|through|using)\s+(?:the\s+)?(?:link|form|website|portal|careers? page)\b/,
  // Hinglish: "DM mat karo", "message mat karna", "msg na karein"
  new RegExp(`\\b${DM}\\s+(?:mat|na|nahi|nahin)\\s+(?:karo|karein|kare|karna|kijiye|kijiyega|bhejo|bhejna)\\b`),
  // Hinglish: "sirf email", "sirf mail pe", "email hi bhejo", "bas email"
  new RegExp(`\\b(?:sirf|sirph|bas|keval)\\s+${MAIL}\\b`),
  new RegExp(`\\b${MAIL}\\s+(?:hi|sirf)\\s+(?:karo|karein|kare|bhejo|bhejiye|kijiye)\\b`),
];

// "send your CV to <email>" is an apply-by-email instruction only when an address is in the text.
const SEND_CV_TO = /\b(?:send|share|forward|mail|email|drop)\s+(?:your\s+|ur\s+)?(?:cvs?|resumes?|profiles?)(?:\s+and\s+(?:cvs?|resumes?))?\s+(?:to|at|on)\s+\S*@/;

export interface NoDmResult { noDm: boolean; matched: string | null }

/** True when the post text says not to DM / message the poster (English and Hinglish). Pure and deterministic. */
export function detectNoDm(text: string | null | undefined): NoDmResult {
  const t = String(text ?? '')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .slice(0, 8000);
  if (!t) return { noDm: false, matched: null };
  for (const re of PATTERNS) {
    const m = re.exec(t);
    if (m) return { noDm: true, matched: m[0].slice(0, 60) };
  }
  if (HAS_EMAIL.test(t)) {
    const m = SEND_CV_TO.exec(t);
    if (m) return { noDm: true, matched: m[0].slice(0, 60) };
  }
  return { noDm: false, matched: null };
}

interface PostRow { poster_url: string | null; description: string | null; poster_no_dm: number | null }

/**
 * Whether a LinkedIn profile belongs to the poster of a hiring post that said not to DM. Uses the stored flag
 * (`jobs.poster_no_dm`) and, for rows saved before the flag existed (NULL), the detector on the stored text.
 * Any flagged post by this author counts. Never throws: an unreadable table means "not flagged" (every other
 * gate still runs).
 */
export function posterNoDmForProfile(db: BetterSqlite3.Database, profileKeyOrUrl: string): boolean {
  try {
    const key = normalizeProfileKey(profileKeyOrUrl);
    const slug = key.split('/in/')[1]?.split('/')[0];
    if (!slug) return false;
    const rows = db
      .prepare("SELECT poster_url, description, poster_no_dm FROM jobs WHERE source = ? AND poster_url LIKE ? ESCAPE '\\'")
      .all(POST_SOURCE, `%/in/${slug.replace(/[\\%_]/g, '\\$&')}%`) as PostRow[];
    return rows.some((r) => normalizeProfileKey(r.poster_url ?? '') === key && (r.poster_no_dm === 1 || (r.poster_no_dm === null && detectNoDm(r.description).noDm)));
  } catch {
    return false;
  }
}
