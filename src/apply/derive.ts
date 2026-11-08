// Values the answer book may DERIVE from user-data/resume.json when the owner's answer file does not state them. Deterministic and
// documented: nothing here estimates, rounds up or guesses. If the resume cannot support a value, the function returns null and the
// question is asked of the owner instead.

export interface DerivedAnswers {
  years_experience: number | null;
  current_location: string | null;
  skills: string | null;
}

const MONTH = /^(\d{4})-(\d{2})/;

function monthIndex(s: unknown): number | null {
  const m = typeof s === 'string' ? MONTH.exec(s.trim()) : null;
  if (!m) return null;
  const mo = Number(m[2]);
  return mo >= 1 && mo <= 12 ? Number(m[1]) * 12 + (mo - 1) : null;
}

/** Whole years of work: the union of the experience date ranges (overlaps and gaps are not double counted), rounded DOWN. An open end means `now`. */
export function yearsFromExperience(experience: unknown, now: Date): number | null {
  const months = monthsFromExperience(experience, now);
  return months === null ? null : Math.floor(months / 12);
}

/** Months of work (union of the date ranges, an open end means `now`); the exact figure behind "over N years" questions. */
export function monthsFromExperience(experience: unknown, now: Date): number | null {
  if (!Array.isArray(experience)) return null;
  const nowIdx = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const spans: Array<[number, number]> = [];
  for (const e of experience) {
    const start = monthIndex((e as { start?: unknown })?.start);
    if (start === null) continue;
    const rawEnd = (e as { end?: unknown })?.end;
    const end = rawEnd === null || rawEnd === undefined || /^(present|current|now)$/i.test(String(rawEnd).trim()) ? nowIdx : monthIndex(rawEnd);
    if (end === null || end < start) continue;
    spans.push([start, end + 1]);
  }
  if (!spans.length) return null;
  spans.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let [cs, ce] = spans[0];
  for (const [s, e] of spans.slice(1)) {
    if (s <= ce) ce = Math.max(ce, e);
    else { months += ce - cs; cs = s; ce = e; }
  }
  months += ce - cs;
  return months;
}

export function skillsFromResume(skills: unknown, maxChars = 400): string | null {
  if (!Array.isArray(skills)) return null;
  const items = skills.flatMap((s) => (Array.isArray((s as { items?: unknown })?.items) ? ((s as { items: unknown[] }).items) : []))
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
  if (!items.length) return null;
  const out: string[] = [];
  let used = 0;
  for (const i of items) {
    if (used + i.length + 2 > maxChars) break;
    out.push(i);
    used += i.length + 2;
  }
  return out.join(', ');
}

export function deriveFromResume(resume: Record<string, unknown> | null, now: Date = new Date()): DerivedAnswers {
  const loc = typeof resume?.location === 'string' && resume.location.trim() ? resume.location.trim() : null;
  return {
    years_experience: resume ? yearsFromExperience(resume.experience, now) : null,
    current_location: loc,
    skills: resume ? skillsFromResume(resume.skills) : null,
  };
}
