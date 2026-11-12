// Pure model for the Inbox "Apply by hand" group. No React, no fetch, no path aliases, so vitest can import this file directly.
// Titles, companies and notes are untrusted text: this file only counts, compares and builds request bodies; the UI renders text as plain text.

export type ManualItem = {
  id: number; job_id: string; title: string; company: string; platform: string; open_url: string;
  resume_pdf: string | null; resume_download: string | null; ats_note: string | null; reason: string; reason_label: string; fail_reason?: string; since: string;
};
export type ManualPayload = { count: number; easyApplyOff: number; easyApplyEnabled: boolean; items: ManualItem[] };
export type ManualResult = { id: number; ok: boolean; error?: string };

export const NOTE_LIMIT = 500;

/** The one-line banner shown while LinkedIn Easy Apply is off; null when it is on. */
export function easyApplyBanner(p: Pick<ManualPayload, "easyApplyEnabled">): string | null {
  return p.easyApplyEnabled ? null : "LinkedIn Easy Apply is off, so these jobs wait for you to apply by hand.";
}

export function reasonTone(reason: string): "warn" | "bad" | "" {
  if (reason === "easy_apply_failed") return "bad";
  if (reason === "easy_apply_off") return "warn";
  return "";
}

/** Only an https address is ever made a link; anything else (a stored oddity) shows as no link. */
export function safeOpenUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password ? u.toString() : null;
  } catch { return null; }
}

/** A download link is only ever the same-origin manual-apply API path for this row. */
export function safeDownload(item: Pick<ManualItem, "id" | "resume_download">): string | null {
  return item.resume_download === `/api/manual-apply/${item.id}/resume` ? item.resume_download : null;
}

export function toggleId(selected: number[], id: number): number[] {
  return selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id];
}

/** Select all, or clear when everything is already selected. */
export function toggleAll(selected: number[], items: Pick<ManualItem, "id">[]): number[] {
  const all = items.map((i) => i.id);
  return all.length > 0 && all.every((id) => selected.includes(id)) ? [] : all;
}

/** Drop selected ids that are no longer listed (after a reload). */
export function pruneSelection(selected: number[], items: Pick<ManualItem, "id">[]): number[] {
  const live = new Set(items.map((i) => i.id));
  return selected.filter((id) => live.has(id));
}

export function actionBody(ids: number[], note: string): { ids: number[]; note?: string } {
  const n = note.trim();
  return n ? { ids, note: n.slice(0, NOTE_LIMIT) } : { ids };
}

export function noteProblem(note: string): string | null {
  return note.trim().length > NOTE_LIMIT ? `The note is too long: ${note.trim().length} of ${NOTE_LIMIT} characters.` : null;
}

export function bulkLabel(kind: "done" | "skip", n: number): string {
  return kind === "done" ? `I applied to ${n === 1 ? "this job" : `${n} jobs`}` : `Skip ${n === 1 ? "this job" : `${n} jobs`}`;
}

/** Per-id errors from a done/skip response, keyed by queue row id. */
export function errorsFrom(results: unknown): Record<number, string> {
  const out: Record<number, string> = {};
  if (!Array.isArray(results)) return out;
  for (const r of results) {
    const row = r as { id?: unknown; ok?: unknown; error?: unknown };
    if (typeof row.id === "number" && row.ok === false) out[row.id] = typeof row.error === "string" ? row.error : "Not saved.";
  }
  return out;
}

/** The saved message after an action: how many worked, and how many did not. */
export function savedMessage(kind: "done" | "skip", results: unknown): string {
  const list = Array.isArray(results) ? (results as ManualResult[]) : [];
  const ok = list.filter((r) => r.ok).length;
  const failed = list.length - ok;
  const base = kind === "done"
    ? `Saved ${ok} job${ok === 1 ? "" : "s"} as applied by you.`
    : `Skipped ${ok} job${ok === 1 ? "" : "s"}. They will not come back.`;
  return failed > 0 ? `${base} ${failed} could not be saved (already handled, or no longer waiting).` : base;
}

/** The page size of the "Apply by hand" list: ten rows first, then ten more per press. */
export const MANUAL_PAGE = 10;

export type ReasonFacet = { reason: string; label: string; count: number };

/** One chip per reason in the list, biggest first (ties by label), each with its count. */
export function reasonFacets(items: Pick<ManualItem, "reason" | "reason_label">[]): ReasonFacet[] {
  const by = new Map<string, ReasonFacet>();
  for (const i of items) {
    const f = by.get(i.reason) ?? { reason: i.reason, label: i.reason_label || i.reason, count: 0 };
    f.count += 1;
    by.set(i.reason, f);
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** The rows of one reason (empty reason: all rows). */
export function filterByReason<T extends Pick<ManualItem, "reason">>(items: T[], reason: string): T[] {
  return reason ? items.filter((i) => i.reason === reason) : items;
}

/** The first `shown` rows, the rows left and the text of the footer ("10 of 78 shown"). */
export function pageRows<T>(items: T[], shown: number): { visible: T[]; rest: number; text: string } {
  const visible = items.slice(0, Math.max(0, shown));
  return { visible, rest: Math.max(0, items.length - visible.length), text: `${visible.length} of ${items.length} shown` };
}

/** The label of the "show more" button: at most MANUAL_PAGE more. */
export const showMoreLabel = (rest: number): string => `Show ${Math.min(MANUAL_PAGE, rest)} more`;

/** Age text for the "since" stamp: "3d ago", "5h ago". Empty when unknown. */
export function sinceText(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const minutes = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1440)}d ago`;
}
