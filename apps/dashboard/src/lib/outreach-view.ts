// Plain-language state of one outreach_queue row for the Job panel. Pure: no React, no fetch, no path aliases, so vitest imports it directly.
import { titleWord } from "./view-models";

export type QueueInfo = {
  id: number; status: string; email_status: string | null; connect_status: string | null; apply_status: string | null; ats_coverage: number | null;
  apply_platform: string | null; apply_tier: string | null; apply_note?: string | null;
  has_email?: boolean; has_connect?: boolean; email_sent_at?: string | null; updated_at?: string | null; email_same_as?: number | null;
};
export type AppInfo = { platform: string | null; method: string | null; status: string | null; reason: string | null; applied_at: string | null };

export type Tone = "good" | "warn" | "bad" | "";
/** `at` is a stored time the view formats; `text` is the sentence without it. */
export type State = { text: string; at: string | null; tone: Tone };

const hasValue = (v: string | null | undefined): v is string => typeof v === "string" && v.trim() !== "";
const lower = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();

/** Email half of a queue row. A row with no draft says so; a queued draft is "waiting", a sent one carries its time. */
export function emailState(q: QueueInfo): State {
  if (q.has_email === false) return { text: "No email planned for this job", at: null, tone: "" };
  const s = lower(q.email_status);
  if (s === "sent" || hasValue(q.email_sent_at)) return { text: "Sent", at: q.email_sent_at ?? q.updated_at ?? null, tone: "good" };
  if (s === "failed") return { text: "Failed to send", at: null, tone: "bad" };
  if (lower(q.status) === "skipped") return { text: "Skipped, it will not be sent", at: null, tone: "warn" };
  if (lower(q.status) === "held_review") return { text: "Held until you approve the job source", at: null, tone: "warn" };
  return { text: "Queued, waiting for the send window", at: null, tone: "warn" };
}

/** LinkedIn connect request half of a queue row. */
export function connectState(q: QueueInfo): State {
  if (q.has_connect === false) return { text: "No LinkedIn request planned for this job", at: null, tone: "" };
  const s = lower(q.connect_status);
  if (s === "sent") return { text: "Sent", at: q.updated_at ?? null, tone: "good" };
  if (s === "failed") return { text: "Failed to send", at: null, tone: "bad" };
  if (lower(q.status) === "skipped") return { text: "Skipped, it will not be sent", at: null, tone: "warn" };
  if (lower(q.status) === "held_review") return { text: "Held until you approve the job source", at: null, tone: "warn" };
  return { text: "Queued for the next wake", at: null, tone: "warn" };
}

/** Closed reason codes the apply stage stores in apply_note, in words. */
const APPLY_NOTE_WORDS: Record<string, string> = {
  "external:host_unknown": "the company site is not a supported application site",
  "external:no_apply_button": "no Apply button was found on the page",
  "external:login_required": "the company site needs a login",
};
function applyReason(note: string | null | undefined): string | null {
  if (!hasValue(note)) return null;
  return APPLY_NOTE_WORDS[note.trim()] ?? note.trim().replace(/^external:/, "").replace(/[_:-]+/g, " ");
}

/** Apply half of a queue row. A stored application for the same platform gives the real time. */
export function applyState(q: QueueInfo, apps: readonly AppInfo[] = []): State {
  const platform = lower(q.apply_platform);
  if (!platform || platform === "none") return { text: "Not applicable: the agent cannot apply to this job", at: null, tone: "" };
  const s = lower(q.apply_status);
  const app = apps.find((a) => lower(a.platform) === platform && lower(a.status) === "submitted");
  if (s === "submitted" || app) return { text: "Applied", at: app?.applied_at ?? q.updated_at ?? null, tone: "good" };
  if (s === "failed") return { text: "Failed", at: null, tone: "bad" };
  if (s === "manual_review" || s === "needs_owner" || s === "needs_answer") {
    const why = applyReason(q.apply_note);
    const base = s === "needs_answer" ? "Blocked: a form question needs your answer" : s === "needs_owner" ? "Blocked: it needs you" : "Blocked: it needs your review";
    return { text: why ? `${base} (${why})` : base, at: null, tone: "warn" };
  }
  if (lower(q.status) === "skipped") return { text: "Skipped, it will not be applied", at: null, tone: "warn" };
  return { text: "Waiting for the apply step of a wake", at: null, tone: "warn" };
}

const PLATFORM_NAMES: Record<string, string> = {
  naukri: "Naukri", wellfound: "Wellfound", linkedin: "LinkedIn", linkedin_easy: "LinkedIn Easy Apply", browser: "the company site", greenhouse: "Greenhouse",
  lever: "Lever", ashby: "Ashby", workday: "Workday",
};
const TIER_WORDS: Record<string, string> = { fast: "fast, saved recipe", agent: "agent-driven", never: "never applied automatically" };

/** "Naukri, agent-driven". Null when the job is not apply-capable. */
export function applyVia(platform: string | null | undefined, tier: string | null | undefined): string | null {
  const p = lower(platform);
  if (!p || p === "none") return null;
  const name = PLATFORM_NAMES[p] ?? titleWord(p);
  const t = TIER_WORDS[lower(tier)];
  return t ? `${name}, ${t}` : name;
}

/** The ATS percentage with one line of meaning. */
export function atsMeaning(pct: number | null | undefined): { value: string; meaning: string } {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return { value: "Not measured", meaning: "No keyword check was stored for this resume." };
  const value = `${Math.round(pct)}%`;
  if (pct >= 80) return { value, meaning: "Strong: most keywords of the posting appear in the tailored resume." };
  if (pct >= 50) return { value, meaning: "Fair: about half of the posting's keywords appear in the resume." };
  return { value, meaning: "Low: many keywords of the posting are missing from the resume (the share of its keywords found in it)." };
}

export type QueueCard = {
  id: number; title: string; email: State; emailNote: string | null; connect: State; apply: State; via: string | null; fit: { value: string; meaning: string };
};
/** One card per queue row, newest first. A row that repeats a newer row's email says so instead of listing the message again. */
export function queueCards(queue: readonly QueueInfo[], apps: readonly AppInfo[] = []): QueueCard[] {
  return queue.map((q) => ({
    id: q.id,
    title: `Queue entry #${q.id}`,
    email: emailState(q),
    emailNote: q.email_same_as ? `Same email as queue entry #${q.email_same_as}. It goes out once.` : null,
    connect: connectState(q),
    apply: applyState(q, apps),
    via: applyVia(q.apply_platform, q.apply_tier),
    fit: atsMeaning(q.ats_coverage),
  }));
}
