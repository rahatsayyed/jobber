// Pure presentation helpers for the dashboard views. No React, no fetch, no path aliases, so vitest can import this file directly.

export type JobCounts = { discovered?: number; matched?: number; applied?: number; pending?: number; failed?: number };
export type Metric = { key: string; label: string; value: number; hint: string; href: string };

/**
 * Home "Job inventory" tiles. Each label says exactly what is counted; the hint is the tooltip. The numbers come from /api/jobs/counts
 * (buckets of the jobs table) and /api/jobs/facets (scored). Threshold is the MATCH_THRESHOLD the server uses.
 */
export function inventoryMetrics(counts: JobCounts, scored: number, threshold: number): Metric[] {
  return [
    { key: "total", label: "Total jobs", value: counts.discovered ?? 0, hint: "Every job saved so far, including excluded and duplicate ones.", href: "/jobs" },
    { key: "scored", label: "Scored", value: scored, hint: "Jobs that already have a match score.", href: "/jobs?scored=1" },
    { key: "matched", label: `Matched (score ${threshold}+)`, value: counts.matched ?? 0, hint: "Scored at or above the threshold and not excluded (or already contacted). These get outreach.", href: "/jobs?bucket=matched" },
    { key: "applied", label: "Applied", value: counts.applied ?? 0, hint: "Jobs with a submitted application.", href: "/jobs?bucket=applied" },
    { key: "awaiting", label: "Awaiting apply", value: counts.pending ?? 0, hint: "Jobs with outreach still queued, or an application that needs a manual step or an answer.", href: "/jobs?bucket=pending" },
    { key: "failed", label: "Failed", value: counts.failed ?? 0, hint: "Jobs where an email, connect or application attempt failed.", href: "/jobs?bucket=failed" },
  ];
}

/** Where a funnel step leads: the matching filtered list. */
const FUNNEL_HREFS: Record<string, string> = {
  discovered: "/jobs", matched: "/jobs?bucket=matched", contacted: "/jobs?contacted=1",
  replied: "/outcomes?outcome=replied", interview: "/outcomes?outcome=interview", offer: "/outcomes?outcome=offer",
};
export function funnelHref(key: string): string | null { return FUNNEL_HREFS[key] ?? null; }

/** Plain-language names for the outreach queue statuses on Home (outreach_queue.status), with the list each one opens when there is one. */
const QUEUE_STATUS: Record<string, { label: string; hint: string; href: string | null }> = {
  queued: { label: "Queued", hint: "Prepared and waiting to be sent or applied.", href: "/jobs?bucket=pending" },
  done: { label: "Done", hint: "Everything planned for the job was sent or applied.", href: "/mail" },
  skipped: { label: "Skipped", hint: "Dropped on purpose, for example after a reply or a veto.", href: null },
};
export function queueStatusInfo(status: string): { label: string; hint: string; href: string | null } {
  return QUEUE_STATUS[status] ?? { label: humanize(status) || "Unknown", hint: "Queue status as stored.", href: null };
}

/** Daily ceiling names (db.check_and_increment keys) in words. Unknown keys fall back to a readable form of the key. */
const CEILING_LABELS: Record<string, string> = {
  send_email: "Emails sent today", linkedin_invite: "LinkedIn invites today", linkedin_message: "LinkedIn messages today",
  apply_attempt: "Apply attempts today", apply: "Applications submitted today", naukri_message: "Naukri messages today",
  wellfound_message: "Wellfound messages today", naukri_apply: "Naukri applications today", wellfound_apply: "Wellfound applications today",
  wellfound_discover: "Wellfound searches today", linkedin_discover: "LinkedIn searches today", site_account: "New site accounts today",
  external_resolve: "Company-site link lookups today", linkedin_profile_view: "LinkedIn profile views today",
};
export function ceilingLabel(key: string): string { return CEILING_LABELS[key] ?? humanize(key); }

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

// ---- Linked detail panels: ?job=ID, ?mail=ID, ?person=ID
export type PanelKind = "job" | "mail" | "person" | "reply";
export type PanelRef = { kind: PanelKind; id: string };
// job id: same shape the API accepts; mail: queue id or f<followup id>; person: people id or c<contact id>; reply: the stored mail message id.
const PANEL_ID: Record<PanelKind, RegExp> = { job: /^[A-Za-z0-9:_.-]{1,128}$/, mail: /^f?\d{1,12}$/, person: /^c?\d{1,12}$/, reply: /^[A-Za-z0-9._-]{1,128}$/ };
const PANEL_KINDS: PanelKind[] = ["job", "mail", "person", "reply"];

/** The page that hosts a panel by default, for a real link (right click, new tab, share). Any page can open any panel from ?job= ?mail= ?person= ?reply=. */
const PANEL_PAGE: Record<PanelKind, string> = { job: "/jobs", mail: "/mail", person: "/people", reply: "/mail" };
export function panelHref(ref: PanelRef): string {
  return `${PANEL_PAGE[ref.kind]}?${ref.kind}=${encodeURIComponent(ref.id)}`;
}

/** Keys of the Send-keys helper row on the Sessions page (Enter, Ctrl+C, Esc, Tab, arrows). Same bytes xterm sends for these keys. */
export const TERMINAL_HELPER_KEYS: { label: string; keys: string }[] = [
  { label: "Enter", keys: "\r" }, { label: "Ctrl+C", keys: "\x03" }, { label: "Esc", keys: "\x1b" },
  { label: "Tab", keys: "\t" }, { label: "Up", keys: "\x1b[A" }, { label: "Down", keys: "\x1b[B" },
];

/** The panel named by the query string, or null. Only the first valid one is used. */
export function parsePanelParams(params: URLSearchParams): PanelRef | null {
  for (const kind of PANEL_KINDS) {
    const id = params.get(kind);
    if (id !== null && PANEL_ID[kind].test(id)) return { kind, id };
  }
  return null;
}

/** Path plus the other params, with at most one panel param set (the new one) and all older panel params dropped. */
export function buildPanelUrl(pathname: string, params: URLSearchParams, ref: PanelRef | null): string {
  const next = new URLSearchParams(params.toString());
  for (const kind of PANEL_KINDS) next.delete(kind);
  if (ref) next.set(ref.kind, ref.id);
  const qs = next.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

const sameRef = (a: PanelRef, b: PanelRef) => a.kind === b.kind && a.id === b.id;
/** Push a panel on the back stack; opening the one already on top changes nothing. */
export function pushPanel(stack: PanelRef[], ref: PanelRef): PanelRef[] {
  const top = stack[stack.length - 1];
  return top && sameRef(top, ref) ? stack : [...stack, ref];
}
/** Go back one panel; the first panel stays (closing is a separate action). */
export function popPanel(stack: PanelRef[]): PanelRef[] { return stack.length > 1 ? stack.slice(0, -1) : stack; }

/** Breadcrumb text: Job, Mail #12, Follow-up #3, Person #4, Contact #4. */
export function crumbLabel(ref: PanelRef): string {
  if (ref.kind === "job") return "Job";
  if (ref.kind === "mail") return ref.id.startsWith("f") ? `Follow-up #${ref.id.slice(1)}` : `Mail #${ref.id}`;
  if (ref.kind === "reply") return "Reply";
  return ref.id.startsWith("c") ? `Contact #${ref.id.slice(1)}` : `Person #${ref.id}`;
}
