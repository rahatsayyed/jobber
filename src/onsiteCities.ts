// Owner rule for India: on-site AND hybrid roles are acceptable only in the `home_onsite` cities (Pune, Hyderabad, Bangalore and their
// metro areas, config/target-regions.json). Everywhere else in India the role must be remote. Gulf targets pass either way and a non-India,
// non-Gulf role keeps the existing remote rule (src/vetoes.ts locationDowngrade). Hybrid counts as on-site (it needs presence).
// Deterministic: it reads only the location string, the `Location:` line, a short first description line, the title and wording in the
// description. Untrusted text: everything is capped and every pattern is linear.
import { mentionedTargetRegion, specificTargets, type TargetRegions } from './targetRegions.js';
import { LOCATION_ONSITE, REMOTE_WORD } from './remotePolicy.js';

/** Indian cities that are NOT on-site friendly (the rest of India is remote only). Used to find and name the city in the verdict. */
export const INDIA_OTHER_CITIES = [
  'Chennai', 'Mumbai', 'Navi Mumbai', 'Thane', 'Delhi', 'New Delhi', 'Delhi NCR', 'NCR', 'Gurgaon', 'Gurugram', 'Noida', 'Greater Noida', 'Ghaziabad', 'Faridabad',
  'Kolkata', 'Calcutta', 'Ahmedabad', 'Gandhinagar', 'Jaipur', 'Kochi', 'Cochin', 'Thiruvananthapuram', 'Trivandrum', 'Technopark', 'Coimbatore', 'Madurai',
  'Indore', 'Bhopal', 'Chandigarh', 'Mohali', 'Panchkula', 'Lucknow', 'Kanpur', 'Nagpur', 'Nashik', 'Bhubaneswar', 'Visakhapatnam', 'Vizag', 'Vijayawada',
  'Vadodara', 'Baroda', 'Surat', 'Rajkot', 'Mysore', 'Mysuru', 'Mangalore', 'Mangaluru', 'Hubli', 'Patna', 'Ranchi', 'Guwahati', 'Dehradun', 'Goa', 'Panaji', 'Pondicherry', 'Puducherry',
];

const fold = (s: unknown) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordRe = (t: string, flags = '') => new RegExp(`(?<![a-z0-9])${esc(fold(t).trim()).replace(/(?:\\?[\s-])+/g, '[\\s-]+')}(?![a-z0-9])`, flags);
const ONSITE_NOW = /(?<![a-z0-9])(?:on-?site|on site|in-?person|in-?office|in office|in the office|office[- ]based|work from office|wfo|hybrid|on-?premises?)(?![a-z0-9])/;
const NO_REMOTE = /(?<![a-z0-9])(?:no remote|not remote|remote (?:work )?(?:is )?not)/;
// location wording right before a city in the description ("Location: Chennai", "based in Chennai", "office in Mumbai")
const CITY_TRIGGER = /(?:location|located|based|office|offices|onsite|on-site|on site|hybrid|work from office|relocat\w*|city)[^a-z0-9\n]{0,4}(?:in|at|from)?[^a-z0-9\n]{0,4}$/;
const NEAR_CHARS = 40;

export type CityVerdict = { verdict: 'FAIL' | 'FLAG'; city: string; reason: string };

/** First of `cities` named in `hay` (already folded), else null. */
function firstCity(hay: string, cities: string[]): string | null {
  let best: { at: number; c: string } | null = null;
  for (const c of cities) {
    const m = wordRe(c).exec(hay);
    if (m && (!best || m.index < best.at)) best = { at: m.index, c };
  }
  return best ? best.c : null;
}

/** Cities named in the description right after location wording. */
function descriptionCities(desc: string, cities: string[]): string[] {
  const hay = fold(desc.slice(0, 20000));
  const out: string[] = [];
  for (const c of cities) {
    for (const m of hay.matchAll(wordRe(c, 'g'))) {
      const before = hay.slice(Math.max(0, (m.index ?? 0) - NEAR_CHARS), m.index);
      if (CITY_TRIGGER.test(before)) { out.push(c); break; }
    }
  }
  return out;
}

/**
 * Owner rule: on-site or hybrid work in India outside `home_onsite` is a FAIL, remote passes, an unclear work mode is a FLAG.
 * Returns null when the rule does not apply (rule off, Gulf role, no non-listed Indian city named, a listed city also named, or remote).
 */
export function onsiteCityVerdict(
  rawJob: { title: string; description: string; location?: string | null; remote?: boolean | null },
  tr: TargetRegions,
): CityVerdict | null {
  const onsiteOk = tr.home_onsite;
  if (!onsiteOk || !onsiteOk.length) return null; // rule not configured (hand-built config): unchanged behaviour
  const desc = String(rawJob.description ?? '');
  const locLine = /^Location: ([^\n]{0,300})/.exec(desc)?.[1] ?? '';
  // Sources without a Location line (LinkedIn jobs) put the place on a short first line ("India (Remote)", "Chennai, Tamil Nadu, India").
  const firstLine = desc.split('\n', 1)[0] ?? '';
  const first = !locLine && firstLine.length <= 100 ? firstLine : '';
  const locText = [rawJob.location, locLine, first].filter((x) => x && String(x).trim()).join('; ');
  const place = fold(`${locText}\n${rawJob.title ?? ''}`);
  // A Gulf (target) place: on-site is fine there (the existing FLAG path covers visa and relocation).
  if (mentionedTargetRegion(place, specificTargets(tr.targets))) return null;
  const inPlace = firstCity(place, INDIA_OTHER_CITIES);
  const named = inPlace ? [inPlace] : descriptionCities(desc, INDIA_OTHER_CITIES);
  if (!named.length) return null;
  // A listed city named in the same posting (multi-location "Pune / Chennai") keeps the role acceptable.
  if (firstCity(place, onsiteOk) || descriptionCities(desc, onsiteOk).length) return null;
  const city = named[0];

  const loc = fold(locText.slice(0, 500));
  const title = fold(String(rawJob.title ?? '').slice(0, 500));
  const all = fold(desc.slice(0, 20000));
  const onsiteLoc = ONSITE_NOW.test(loc) || ONSITE_NOW.test(title) || LOCATION_ONSITE.test(loc) || NO_REMOTE.test(loc) || NO_REMOTE.test(title);
  const remoteLoc = rawJob.remote === true || REMOTE_WORD.test(loc) || REMOTE_WORD.test(title);
  const onsiteDesc = ONSITE_NOW.test(all) || NO_REMOTE.test(all);
  const remoteDesc = REMOTE_WORD.test(all.slice(0, 2000));
  const where = 'remote only outside Pune/Hyderabad/Bangalore';
  const fail: CityVerdict = { verdict: 'FAIL', city, reason: `location: on-site in ${city}, ${where}` };
  const flag: CityVerdict = { verdict: 'FLAG', city, reason: `location FLAG: ${city} work mode unclear (${where}): check the posting` };

  if (onsiteLoc) return remoteLoc ? flag : fail;
  if (remoteLoc) return onsiteDesc ? flag : null;
  if (onsiteDesc) return remoteDesc ? flag : fail;
  return remoteDesc ? null : flag;
}
