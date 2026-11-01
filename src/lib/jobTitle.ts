// Job title cleaning. LinkedIn's "verified" badge has accessible text ("with verification") that can leak
// into a card's accessible name and so into `jobs.title`. Strip it, and collapse a title that the page
// repeated twice ("Engineer Engineer" or "Engineer with verification Engineer").
const BADGE = /\s*[-–—|,]?\s*\bwith verification\b\s*/gi;

export function cleanJobTitle(title: string | null | undefined): string {
  let t = String(title ?? '');
  if (!/with verification/i.test(t) && !/^(.{3,}?)\s+\1$/i.test(t.trim())) return t.trim();
  t = t.replace(BADGE, ' ').replace(/\s+/g, ' ').trim();
  const dup = /^(.{3,}?)\s+\1$/i.exec(t);
  if (dup) t = dup[1]!.trim();
  return t.replace(/\s*[-–—|,]\s*$/, '').trim();
}
