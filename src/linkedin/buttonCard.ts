// Parser of the card-as-button LinkedIn jobs layout (seen live 14 Nov 2026): the page has no /jobs/view link at all and each
// result is ONE button whose accessible name reads
//   "<Company> <Location> (<Remote|Hybrid|On-site>)? Dismiss <Title> job [<salary>] [Viewed] [· <meta>] [· Easy Apply]"
// followed by a second button "Dismiss <Title> job". Pure text work: all input is untrusted page text, nothing is fetched.
// The job id is NOT here (see jobIdFromUrl and the click resolver): this file only reads the words.

export type Workplace = 'Remote' | 'Hybrid' | 'On-site' | '';
export interface ButtonCard {
  company: string;
  location: string;
  workplace: Workplace;
  title: string;
  salary: string;
  easyApply: boolean;
  /** Useful meta left after the noise (alumni counts, "Actively reviewing applicants" and the like are noise) joined with " · ". */
  meta: string;
}

const NOISE =
  /^(?:promoted|viewed|saved|easy apply|actively (?:recruiting|hiring|reviewing applicants)|be an early applicant|reposted.*|\d+\+?\s*(?:applicants?|connections?|school alumni.*|(?:people )?clicked apply)|\d+\s*(?:school alumni|connections?|alumni).*|\d+\s*(?:s|m|h|d|w|mo)\b.*|\d+\s*(?:seconds?|minutes?|hours?|days?|weeks?|months?)\s+ago|responses? managed off linkedin|no response insights.*)$/i;
const SALARY = /(?:[$€£₹]\s?\d|\d[\d.,]*\s?[KkMmLl]?\s?(?:INR|USD|EUR|GBP|AED|SGD|CAD|AUD)\b)/;
const WORKPLACE = /\s*\((Remote|Hybrid|On-?site|On site)\)\s*$/i;

// Words that end a location in a card name; used only when the card has no separate lines for company and location.
const CITY =
  'Bengaluru|Bangalore|Hyderabad|Pune|Mumbai|Navi Mumbai|Thane|Chennai|Delhi|New Delhi|Gurugram|Gurgaon|Noida|Greater Noida|Ghaziabad|Faridabad|Kolkata|Ahmedabad|Gandhinagar|Vadodara|Surat|Kochi|Cochin|Thiruvananthapuram|Trivandrum|Coimbatore|Jaipur|Indore|Bhopal|Chandigarh|Mohali|Nagpur|Lucknow|Bhubaneswar|Visakhapatnam|Mysuru|Mysore|Mangaluru|Dubai|Abu Dhabi|Sharjah|Riyadh|Doha|Singapore|London|Berlin|Toronto|New York|San Francisco|Remote';
const COUNTRY = 'India|United States|United Kingdom|United Arab Emirates|UAE|Saudi Arabia|Qatar|Kuwait|Oman|Bahrain|Germany|Canada|Netherlands|Ireland|Australia|Worldwide|EMEA|APAC';
const LOC_TAIL = new RegExp(`^(.+?)\\s+((?:(?:${CITY})(?:,\\s*[A-Za-z][A-Za-z .]*){0,3}|(?:${COUNTRY})))$`, 'i');

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Split "pre" (company + location, workplace already removed) into the two, by lines when possible, else by the location tail. */
function splitCompanyLocation(pre: string, lines: string[]): { company: string; location: string } {
  // Lines of the button that are wholly inside `pre` and come before the Dismiss line: company first, location after.
  const before: string[] = [];
  for (const l of lines) {
    const t = collapse(l);
    if (/^dismiss\b/i.test(t)) break;
    if (t && pre.includes(t.replace(WORKPLACE, '').trim())) before.push(t.replace(WORKPLACE, '').trim());
  }
  if (before.length >= 2) return { company: before[0], location: before.slice(1).join(', ') };
  const m = LOC_TAIL.exec(pre);
  if (m) return { company: m[1].trim(), location: m[2].trim() };
  return { company: pre.trim(), location: '' };
}

/**
 * Read one card button. `name` is the accessible name, `dismissTitle` the exact title from the sibling "Dismiss <Title> job"
 * button when the page had one (it settles titles that contain the word "job"), `lines` the visible lines of the button.
 * Returns null when the name has no "Dismiss <Title> job" part.
 */
export function parseButtonCard(name: string, dismissTitle = '', lines: string[] = []): ButtonCard | null {
  const n = collapse(String(name ?? ''));
  let pre: string;
  let title: string;
  let tail: string;
  const exact = dismissTitle ? ` Dismiss ${dismissTitle} job` : '';
  const at = exact ? n.indexOf(exact) : -1;
  if (at >= 0) {
    pre = n.slice(0, at);
    title = dismissTitle;
    tail = n.slice(at + exact.length);
  } else {
    const m = /^(.*?)\s*\bDismiss (.+?) job(?= |$)(.*)$/.exec(n);
    if (!m) return null;
    [, pre, title, tail] = m;
  }
  title = collapse(title);
  if (!title) return null;

  const segs = tail.split(/\s*[·•]\s*/).map(collapse);
  let salary = '';
  let seg0 = segs.shift() ?? '';
  seg0 = collapse(seg0.replace(/\b(?:Viewed|Promoted|Saved)\b/gi, ''));
  if (seg0 && SALARY.test(seg0)) salary = seg0.slice(0, 80);
  else if (seg0) segs.unshift(seg0);
  let easyApply = false;
  const meta: string[] = [];
  for (const s of segs) {
    if (!s) continue;
    if (/^easy apply$/i.test(s)) { easyApply = true; continue; }
    if (NOISE.test(s)) continue;
    meta.push(s.slice(0, 120));
  }

  let workplace: Workplace = '';
  const w = WORKPLACE.exec(pre);
  if (w) {
    const x = w[1].toLowerCase();
    workplace = x === 'remote' ? 'Remote' : x === 'hybrid' ? 'Hybrid' : 'On-site';
    pre = pre.slice(0, w.index);
  }
  const { company, location } = splitCompanyLocation(collapse(pre), lines);
  return { company, location, workplace, title, salary, easyApply, meta: meta.join(' · ') };
}

/**
 * First description line in the convention of board jobs ("Location: <place> (remote)"), so the location gates and the matcher
 * read it. Remote is written lowercase in brackets like for posts; hybrid and on-site likewise.
 */
export function descriptionOf(c: ButtonCard): string {
  const wp = c.workplace === 'Remote' ? '(remote)' : c.workplace === 'Hybrid' ? '(hybrid)' : c.workplace === 'On-site' ? '(on-site)' : '';
  const loc = [c.location, wp].filter(Boolean).join(' ');
  const lines = [loc ? `Location: ${loc}` : '', c.salary ? `Salary: ${c.salary}` : '', c.easyApply ? 'Easy Apply' : '', c.meta].filter(Boolean);
  return lines.join('\n');
}

/** Job id digits from a real page URL: `currentJobId=<digits>` first, else `/jobs/view/<digits>`. Digits only, or null. */
export function jobIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const q = u.searchParams.get('currentJobId');
    if (q && /^\d{6,25}$/.test(q)) return q;
    const m = /\/jobs\/view\/(?:[^/?#]*?-)?(\d{6,25})(?:[/?#]|$)/.exec(u.pathname);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}
