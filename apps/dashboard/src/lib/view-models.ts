// Pure presentation helpers for the dashboard views. No React, no fetch, no path aliases, so vitest can import this file directly.

export type JobCounts = { discovered?: number; matched?: number; applied?: number; pending?: number; failed?: number };
export type Metric = { key: string; label: string; value: number; hint: string };

/**
 * Home "Job inventory" tiles. Each label says exactly what is counted; the hint is the tooltip. The numbers come from /api/jobs/counts
 * (buckets of the jobs table) and /api/jobs/facets (scored). Threshold is the MATCH_THRESHOLD the server uses.
 */
export function inventoryMetrics(counts: JobCounts, scored: number, threshold: number): Metric[] {
  return [
    { key: "total", label: "Total jobs", value: counts.discovered ?? 0, hint: "Every job saved so far, including excluded and duplicate ones." },
    { key: "scored", label: "Scored", value: scored, hint: "Jobs that already have a match score." },
    { key: "matched", label: `Matched (score ${threshold}+)`, value: counts.matched ?? 0, hint: "Scored at or above the threshold and not excluded (or already contacted). These get outreach." },
    { key: "applied", label: "Applied", value: counts.applied ?? 0, hint: "Jobs with a submitted application." },
    { key: "awaiting", label: "Awaiting apply", value: counts.pending ?? 0, hint: "Jobs with outreach still queued, or an application that needs a manual step or an answer." },
    { key: "failed", label: "Failed", value: counts.failed ?? 0, hint: "Jobs where an email, connect or application attempt failed." },
  ];
}

const FUNNEL_LABELS: Record<string, string> = {
  discovered: "Jobs found", matched: "Matched jobs", contacted: "Jobs contacted", replied: "Jobs with a reply", interview: "Interviews", offer: "Offers",
};
export function funnelLabel(key: string): string { return FUNNEL_LABELS[key] ?? key; }

export type EscGroupKey = "human" | "platform" | "noise";
export type EscLike = {
  id: number; ids?: number[]; group: EscGroupKey | string; platform: string | null; reason: string; label: string; todo: string;
  personName: string | null; senderName: string | null; personCompany: string | null; jobTitle: string | null; count?: number;
  created_at: string; last_at?: string; excerpt: string | null; askKind?: string; detail?: string | null;
};

export const ESC_GROUPS: { key: EscGroupKey; title: string; blurb: string }[] = [
  { key: "human", title: "Replies and recruiter inquiries", blurb: "A real person wrote, or an application needs you." },
  { key: "platform", title: "Platform and tool problems", blurb: "Something broke or hit a limit. Usually nothing to do." },
  { key: "noise", title: "Flagged messages", blurb: "Blocked or unscreened text. Hidden by default." },
];

export function groupEscalations<T extends EscLike>(items: T[]): { key: EscGroupKey; title: string; blurb: string; items: T[] }[] {
  return ESC_GROUPS.map((g) => ({ ...g, items: items.filter((i) => i.group === g.key) })).filter((g) => g.items.length > 0);
}

/** A readable inbox title: who or what, never the bare platform name. */
export function escalationTitle(i: EscLike): string {
  const who = i.senderName || i.personName;
  if (i.group === "human" && who) return `${who}${i.personCompany ? ` at ${i.personCompany}` : ""}`;
  if (i.group === "human" && i.jobTitle) return i.jobTitle;
  if (i.group === "human" && i.platform === "apply") return "Application needs you";
  return i.label || "Needs a look";
}

/** One short line under the title: the plain reason, the platform and the related job when known. */
export function escalationLine(i: EscLike): string {
  return [i.label, i.platform, i.jobTitle].filter(Boolean).join(" · ");
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return "n/a";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Only http(s) links are ever made clickable. */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function buildQuery(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined && String(v) !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** "success", "warn", "bad" or "" for a status word, used for badge colour. */
export function statusTone(status: string | null | undefined): "good" | "warn" | "bad" | "" {
  const s = (status ?? "").toLowerCase();
  if (/^(ok|sent|submitted|connected|done|active|live|approved|offer|hired|interview|accepted)$/.test(s)) return "good";
  if (/(fail|error|crash|bounce|reject|blocked|denied|killed|bad_)/.test(s)) return "bad";
  if (/(skip|queued|pending|running|budget|usage|limit|duplicate|repeat|new|manual|needs|sending)/.test(s)) return "warn";
  return "";
}

export function humanize(value: string | null | undefined): string {
  return (value ?? "").replace(/[_-]+/g, " ").trim();
}

export type TerminalFrame = { cols: number; rows: number; cx: number; cy: number; text: string };

/** Escape string that repaints a whole captured pane: clear, home, lines joined with CRLF, then place the cursor. */
export function frameToTerminal(f: TerminalFrame): string {
  const lines = f.text.replace(/\n$/, "").split("\n");
  const body = lines.map((l) => `${l}\x1b[0m`).join("\r\n");
  const cx = Number.isFinite(f.cx) ? Math.max(0, f.cx) : 0;
  const cy = Number.isFinite(f.cy) ? Math.max(0, f.cy) : 0;
  return `\x1b[2J\x1b[H${body}\x1b[${cy + 1};${cx + 1}H`;
}

/** Bounded reconnect delay: 1s, 2s, 4s ... up to 15s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(15_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 4)));
}
