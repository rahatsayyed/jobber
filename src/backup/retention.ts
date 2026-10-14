export const BACKUP_NAME_RE = /^jobber-backup-(\d{8}T\d{6}Z)\.tar\.gz\.age$/;

export interface RetentionPolicy { daily: number; weekly: number; monthly: number }

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

export function backupName(at: Date): string {
  const s =
    `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
    `T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`;
  return `jobber-backup-${s}.tar.gz.age`;
}

function parseStamp(name: string): Date | null {
  const m = BACKUP_NAME_RE.exec(name);
  if (!m) return null;
  const s = m[1];
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15)));
  if (Number.isNaN(d.getTime())) return null;
  // reject impossible dates that Date.UTC would roll over
  return backupName(d) === name ? d : null;
}

function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${pad(week)}`;
}

const dayKey = (d: Date) => `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
const monthKey = (d: Date) => `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}`;

export function planRetention(
  names: string[],
  policy: RetentionPolicy,
  now: Date,
): { keep: string[]; remove: string[] } {
  const seen = new Set<string>();
  const items: { name: string; at: Date }[] = [];
  for (const name of names) {
    if (seen.has(name)) continue;
    const at = parseStamp(name);
    if (!at) continue;
    seen.add(name);
    items.push({ name, at });
  }
  items.sort((a, b) => b.at.getTime() - a.at.getTime() || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  if (items.length === 0) return { keep: [], remove: [] };

  const keepSet = new Set<string>([items[0].name]);
  const nowMs = now.getTime();
  const dayCut = nowMs - policy.daily * 86_400_000;
  const weekCut = nowMs - policy.weekly * 7 * 86_400_000;
  const monthCutDate = new Date(now.getTime());
  monthCutDate.setUTCMonth(monthCutDate.getUTCMonth() - policy.monthly);
  const monthCut = monthCutDate.getTime();

  const dBuckets = new Set<string>();
  const wBuckets = new Set<string>();
  const mBuckets = new Set<string>();
  for (const it of items) {
    const t = it.at.getTime();
    if (policy.daily > 0 && t >= dayCut) {
      const k = dayKey(it.at);
      if (!dBuckets.has(k)) { dBuckets.add(k); keepSet.add(it.name); }
    }
    if (policy.weekly > 0 && t >= weekCut) {
      const k = isoWeekKey(it.at);
      if (!wBuckets.has(k)) { wBuckets.add(k); keepSet.add(it.name); }
    }
    if (policy.monthly > 0 && t >= monthCut) {
      const k = monthKey(it.at);
      if (!mBuckets.has(k)) { mBuckets.add(k); keepSet.add(it.name); }
    }
  }

  const keep: string[] = [];
  const remove: string[] = [];
  for (const it of items) {
    if (keepSet.has(it.name)) keep.push(it.name);
    else remove.push(it.name, `${it.name}.sha256`);
  }
  return { keep, remove };
}
