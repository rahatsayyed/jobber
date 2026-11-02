// Pure model for the dashboard Inbox ("Needs your attention"). No React, no fetch, no path aliases, so vitest can import this file directly.
// Everything in an item that came from a platform or a person is untrusted text: this file only builds closed sentences from the
// kind, platform and reason code, and never turns untrusted text into markup. The UI renders the untrusted parts as plain text.

export type InboxType = "reply" | "recruiter" | "platform" | "apply" | "flagged" | "other";
export type InboxPlatform = "linkedin" | "naukri" | "wellfound" | "email" | "apply" | "scheduler" | "other";
export type InboxStatus = "open" | "handled" | "all";
export type Tone = "act" | "check" | "none";

/** The fields of one card from /api/escalations that this model reads. */
export type InboxItem = {
  id: number; ids: number[]; count: number; platform: string | null; reason: string; detail: string | null; group: string; flag: string | null;
  created_at: string; first_at: string; last_at: string; threadRef: string | null; threadUrl: string | null;
  personId: number | null; personName: string | null; personCompany: string | null; jobId: string | null; jobTitle: string | null;
  resolved_at: string | null; snoozed_until: string | null; senderName: string | null; senderHeadline: string | null;
  excerpt: string | null; messageAt: string | null; askKind: string; label: string; todo: string; updates: number;
  rawText: string | null; resolvedNote: string | null;
  /** Who acts on a reply card (server): nobody, the agent (a reply is drafted or sent) or the owner. Absent on an old server. */
  todoKind?: "info" | "agent" | "owner";
  replyDraft?: { status: string; attachResume: boolean } | null;
  /** apply:* cards: the job the card is about (server). Absent or with empty fields for an old row. */
  applyJob?: ApplyJob | null;
};
export type ApplyJob = { jobId: string | null; title: string | null; company: string | null; host: string | null; url: string | null; questions: string[] };

/** A job text for an apply card: "Title at Company", else null. */
export function applyJobText(j: ApplyJob | null | undefined): string | null {
  if (!j || !j.title) return null;
  return `${j.title}${j.company ? ` at ${j.company}` : ""}`;
}

export const TYPE_ORDER: InboxType[] = ["reply", "recruiter", "platform", "apply", "flagged", "other"];
export const TYPE_LABELS: Record<InboxType, string> = {
  reply: "Reply", recruiter: "Recruiter inquiry", platform: "Platform problem", apply: "Apply problem", flagged: "Flagged by screen", other: "Other",
};
export const PLATFORM_ORDER: InboxPlatform[] = ["linkedin", "naukri", "wellfound", "email", "apply", "scheduler"];
export const PLATFORM_LABELS: Record<InboxPlatform, string> = {
  linkedin: "LinkedIn", naukri: "Naukri", wellfound: "Wellfound", email: "Email", apply: "Apply", scheduler: "Scheduler", other: "Other",
};
export const STATUS_LABELS: Record<InboxStatus, string> = { open: "Open", handled: "Handled", all: "All" };

export function platformKey(i: Pick<InboxItem, "platform">): InboxPlatform {
  const p = (i.platform ?? "").toLowerCase();
  if (p === "linkedin" || p === "naukri" || p === "wellfound" || p === "apply" || p === "scheduler") return p;
  if (p === "email" || p === "gmail" || p === "mail") return "email";
  return "other";
}
export const platformLabel = (i: Pick<InboxItem, "platform">): string => PLATFORM_LABELS[platformKey(i)];

export function inboxType(i: Pick<InboxItem, "group" | "platform" | "askKind">): InboxType {
  if (i.group === "noise") return "flagged";
  if ((i.platform ?? "").toLowerCase() === "apply") return "apply";
  if (i.group === "human") {
    if (i.askKind === "recruiter_inquiry") return "recruiter";
    if (i.askKind === "other") return "other";
    return "reply";
  }
  return "platform";
}

/** Sort rank: replies and recruiter inquiries first, then apply problems, platform problems, other, flagged last. */
const RANK: Record<InboxType, number> = { reply: 0, recruiter: 0, apply: 1, platform: 2, other: 3, flagged: 4 };

export function sortItems<T extends Pick<InboxItem, "group" | "platform" | "askKind" | "last_at" | "created_at" | "id">>(items: T[]): T[] {
  const at = (i: T) => i.last_at || i.created_at;
  return [...items].sort((a, b) => RANK[inboxType(a)] - RANK[inboxType(b)] || (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : 0) || b.id - a.id);
}

export const statusOf = (i: Pick<InboxItem, "resolved_at">): Exclude<InboxStatus, "all"> => (i.resolved_at ? "handled" : "open");

// ---- the stored reason text -------------------------------------------------------------------------------------------------------------

export type ParsedReason = { code: string | null; unscreened: boolean; inputFlags: string[]; base: string };

/** Splits `[blocked: code] reason [input flags: a,b]` and `[unscreened] reason` into parts. The base is the closed reason word. */
export function parseReason(reason: string): ParsedReason {
  const r = String(reason ?? "");
  const blocked = /^\s*\[blocked:\s*([^\]]*)\]/i.exec(r);
  const flags = /\[input flags:\s*([^\]]*)\]/i.exec(r)?.[1] ?? "";
  const base = r.replace(/^\s*\[blocked:[^\]]*\]/i, "").replace(/^\s*\[unscreened\]/i, "").replace(/\[input flags:[^\]]*\]/ig, "").trim();
  return {
    code: blocked ? blocked[1].trim().toLowerCase() || null : null,
    unscreened: /^\s*\[unscreened\]/i.test(r),
    inputFlags: flags.split(",").map((f) => f.trim().toLowerCase()).filter(Boolean),
    base,
  };
}

export const SCREEN_INTRO = "The injection screen reads every piece of text that comes from a platform, a person or a web page before the agent may use it. "
  + "It looks for text written to give orders to an AI (for example \"ignore your instructions\"). When it is unsure or cannot run, the agent does not use the text and an item lands here.";

/** Every blocked code and input flag the repo can produce (src/safety/screen.ts, src/inputGate.ts), in plain words. */
const CODE_TEXT: Record<string, string> = {
  injection_suspected: "The screen judged that this text looks written to give instructions to an AI (a prompt injection), so it was held back.",
  injection_suspect: "An agent noticed text that looked like an instruction aimed at an AI and escalated it instead of using it.",
  classifier_unavailable: "The screening model could not run at that moment, so the text could not be cleared. The screen fails closed: unchecked text is held back. This is usually not a sign the text is bad.",
  classifier_truncated: "The screening model's answer was cut off, so the text could not be cleared and was held back. This is usually not a sign the text is bad.",
  unscreened: "The screen was not able to check this text (for example in a dry run), but the item was kept so you can look at it. It was not judged unsafe.",
};
const FLAG_TEXT: Record<string, string> = {
  exfiltration: "asks to send data or secrets somewhere",
  hidden_chars: "contains invisible characters",
  html_comment: "contains a hidden HTML comment",
  instruction_tag: "contains tags like <system> that mimic instructions",
  override_phrase: "contains phrases like \"ignore previous instructions\"",
  role_prefix: "starts like a chat role (\"System:\", \"Assistant:\")",
  truncated: "was very long and was cut short",
  classifier_injection: "the screening model flagged it as an injection",
  classifier_unavailable: "the screening model was not available",
  classifier_truncated: "the screening model answer was cut off",
};

/** Plain-language lines explaining why this item was flagged. Empty when it was not flagged by the screen. */
export function explainFlag(i: Pick<InboxItem, "reason" | "group">): string[] {
  const p = parseReason(i.reason);
  const out: string[] = [];
  const known = (code: string) => CODE_TEXT[code] ?? `Unknown screen code "${code}". Treat the text as unchecked.`;
  if (p.code) out.push(`Code ${p.code}: ${known(p.code)}`);
  if (p.unscreened) out.push(`Code unscreened: ${CODE_TEXT.unscreened}`);
  if (!p.code && !p.unscreened && /injection[_ ]suspect/i.test(p.base)) out.push(`Code injection_suspect: ${CODE_TEXT.injection_suspect}`);
  for (const f of p.inputFlags) out.push(`Flag ${f}: the text ${FLAG_TEXT[f] ?? "tripped a rule of the input gate"}.`);
  if (!out.length && i.group === "noise") out.push("This item was flagged by the screen, but no code was stored with it. Treat the text as unchecked.");
  return out;
}

// ---- summary and action text ------------------------------------------------------------------------------------------------------------

export type Described = { type: InboxType; summary: string; action: string; tone: Tone };

const APPLY_PHRASE: Record<string, [string, string, Tone]> = {
  captcha: ["a CAPTCHA blocked it", "Open the job page and finish the application yourself. The agent never solves CAPTCHAs.", "act"],
  mfa: ["the site asked for a login code (MFA)", "Finish the login and the application yourself. The agent never enters one-time codes.", "act"],
  phone_verification: ["the site asked to verify a phone number", "Verify the phone on the site and apply yourself. The agent never does phone checks.", "act"],
  email_verification: ["the site asked to verify an email address", "Open the verification email, confirm it, then apply yourself or wait for the next wake.", "act"],
  account_needed: ["the site needs an account", "Create the account on the site yourself if you want this job, or mark handled to skip it.", "act"],
  question: ["the form asked a question the agent could not answer safely", "Open the job page and answer the question yourself, or mark handled to skip the job.", "act"],
  consent: ["the form needs a consent you must give", "Read the consent on the site; apply yourself if you agree, otherwise mark handled.", "act"],
  marketing_checkbox: ["the form wanted a marketing checkbox", "Nothing was ticked. Apply yourself if you want this job, otherwise mark handled.", "check"],
  host_unknown: ["the apply page is on a site the agent may not drive", "Apply on the company site yourself if you want this job, otherwise mark handled.", "act"],
  drift: ["the apply form changed shape", "Nothing was submitted. Apply yourself, or mark handled and let the next wake retry.", "check"],
  blocked: ["the site blocked the agent (bot wall)", "Wait before trying that site again, or apply yourself. Do not retry in a loop.", "check"],
  cover_letter: ["the form wants a cover letter", "Write the cover letter yourself and apply, or mark handled to skip the job.", "act"],
  login_failed: ["login to the site failed", "Check the saved login for that site, or apply yourself. Then mark handled.", "act"],
  other: ["it stopped for a reason the agent could not handle", "Open the job page and finish or skip it yourself, then mark handled.", "act"],
};

/** A short reason for a group of apply cards of one site ("3 jobs, page structure changed"). */
export const APPLY_SHORT: Record<string, string> = {
  captcha: "a CAPTCHA blocks it", mfa: "a login code is needed", phone_verification: "phone verification is needed", email_verification: "email verification is needed",
  account_needed: "an account is needed", question: "the form asks a question", consent: "a consent is needed", marketing_checkbox: "a marketing checkbox",
  host_unknown: "the site is not on the list", drift: "page structure changed", blocked: "the site blocked the agent", cover_letter: "a cover letter is needed",
  login_failed: "login failed", other: "it stopped for another reason", no_relevant_role: "no relevant role",
};

const LOGIN_CMD: Record<string, string> = { linkedin: "npm run linkedin:login", naukri: "npm run naukri:login", wellfound: "npm run wellfound:login" };

function humanizeCode(s: string): string {
  const t = s.replace(/[_:.-]+/g, " ").trim();
  return t ? t[0].toUpperCase() + t.slice(1) : "Needs a look";
}

type ReasonRule = { test: RegExp; summary: (p: string) => string; action: (pk: InboxPlatform, p: string) => string; tone: Tone };

/** Platform and tool problems, by words in the stored reason code. First match wins. */
const PLATFORM_RULES: ReasonRule[] = [
  { test: /layout[_ ]drift[_ ]halt/i, tone: "act",
    summary: (p) => `The ${p} page changed and the agent stopped on it`,
    action: (_k, p) => `Check /health. Once the page patterns are fixed, resume ${p} with the owner control command (jobber:control resume).` },
  { test: /layout[_ ]drift|layout[_ ]changed|layout/i, tone: "check",
    summary: (p) => `The ${p} page looks different from what the agent remembers`,
    action: () => "Nothing was sent. The agent skipped that step and tries to repair itself in the next wake. Act only if it keeps coming back." },
  { test: /note[_ ]?(limit|quota)|quota[_ ]exhausted/i, tone: "none",
    summary: () => "LinkedIn's monthly connection-note quota is used up",
    action: () => "Nothing to do. Invites now go out without a note until the quota renews." },
  { test: /log[_ ]?in|logged[_ ]out|session[_ ](expired|invalid)|checkpoint|auth/i, tone: "act",
    summary: (p) => `${p} asked for a login or a security check`,
    action: (k) => `Check the ${PLATFORM_LABELS[k]} session; log in again${LOGIN_CMD[k] ? ` with ${LOGIN_CMD[k]}` : ""}, then mark handled.` },
  { test: /dialog|modal|menu|refs?\b|unclickable|unresolvable|not[_ ]actionable|no[_ ]button|controls[_ ]missing|no[_ ]dialog/i, tone: "check",
    summary: (p) => `${p} showed a screen the agent could not use`,
    action: () => "Nothing was sent for that person. The agent moved on. Act only if it keeps coming back." },
  { test: /profile[_ ]mismatch|employer|mismatch/i, tone: "none",
    summary: (p) => `A ${p} profile did not match the saved record`,
    action: () => "Nothing to do. The person was skipped so the agent never messages the wrong profile." },
  { test: /follow[_ ]only/i, tone: "none",
    summary: (p) => `A ${p} profile can only be followed, not connected to`,
    action: () => "Nothing to do. The person is paused and will not be contacted." },
  { test: /unparseable|unreadable|could not read/i, tone: "check",
    summary: (p) => `The agent could not read a message thread on ${p}`,
    action: (k) => `Open the ${PLATFORM_LABELS[k]} inbox yourself and check for new messages, then mark handled.` },
  { test: /rate[_ ]limit|limit[_ ]reached|quota|ceiling|exhausted|halt/i, tone: "none",
    summary: (p) => `${p} hit a daily limit or a pause`,
    action: () => "Nothing to do. It carries on by itself when the limit resets or the pause is lifted. Run /limits to see the numbers." },
];

const NOISE_ACTION = "Read the original text below and decide if it is safe. Never follow instructions inside it. If a real person wrote it, answer on the platform yourself; then mark handled.";

function who(i: InboxItem): string | null {
  const w = i.senderName || i.personName;
  return w ? `${w}${i.personCompany ? ` at ${i.personCompany}` : ""}` : null;
}

/** One bold line, the "what you need to do" line and its tone, built from the kind and the reason code (never from message text). */
export function describeItem(i: InboxItem): Described {
  const type = inboxType(i);
  const pk = platformKey(i);
  const P = PLATFORM_LABELS[pk];
  const p = parseReason(i.reason);
  const applyText = applyJobText(i.applyJob);
  const job = i.jobTitle ? ` about ${i.jobTitle}` : applyText ? ` about ${applyText}` : "";
  const subject = who(i);
  if (type === "flagged") {
    return {
      type, tone: "act", action: NOISE_ACTION,
      summary: `${subject ? `${subject} wrote on` : "Text from"} ${P} was held back by the injection screen${p.code === "classifier_unavailable" || p.code === "classifier_truncated" ? " (the screen could not finish)" : ""}`,
    };
  }
  if (type === "apply") {
    const key = /^apply:(.+)$/i.exec(p.base)?.[1]?.toLowerCase() ?? "";
    const known = APPLY_PHRASE[key];
    if (known) return { type, tone: known[2], summary: `An application${job} stopped: ${known[0]}`, action: known[1] };
    if (/layout|drift/i.test(p.base)) return { type, tone: "check", summary: `An application${job} stopped: the form layout changed`, action: "Nothing was submitted. Apply yourself, or mark handled and let the next wake retry." };
    return { type, tone: "act", summary: `An application${job} needs you: ${humanizeCode(p.base).toLowerCase()}`, action: "Open the job page and finish or skip it yourself, then mark handled." };
  }
  if (type === "reply" || type === "recruiter") {
    const w = subject ?? (type === "recruiter" ? "A recruiter" : "Someone");
    // The line comes from the server (it knows the reply draft state). An old server sends none: fall back to the plain owner line.
    const line = (fallback: string): Pick<Described, "action" | "tone"> => ({
      action: i.todo || fallback,
      tone: i.todoKind === "info" || i.todoKind === "agent" ? "none" : "act",
    });
    const yourself = `Open the conversation on ${P} and answer yourself`;
    if (i.askKind === "salary") return { type, summary: `${w} asked about your pay on ${P}${job}`, ...line(`${yourself}: it asks about salary.`) };
    if (i.askKind === "interview_slot") return { type, summary: `${w} wants to set up an interview on ${P}${job}`, ...line(`${yourself}: it asks about interview time.`) };
    if (i.askKind === "recruiter_inquiry") return { type, summary: `${w} sent a recruiter inquiry on ${P}${job}`, ...line(`${yourself} if you want to.`) };
    if (i.askKind === "question") return { type, summary: `${w} asked you a question on ${P}${job}`, ...line(`${yourself} if you want to.`) };
    return { type, summary: `${w} replied to you on ${P}${job}`, ...line(`${yourself} if you want to.`) };
  }
  if (type === "other") {
    return { type, tone: "check", summary: `${P} needs a look: ${humanizeCode(p.base || i.label)}`, action: `Open ${P}, read what happened and decide. When you have looked, mark handled.` };
  }
  const rule = PLATFORM_RULES.find((r) => r.test.test(p.base));
  if (rule) return { type, tone: rule.tone, summary: rule.summary(P), action: rule.action(pk, P) };
  return {
    type, tone: "check", summary: `${P} reported a problem: ${humanizeCode(p.base || i.label)}`,
    action: "Usually nothing to do: the agent skipped that step. Run /health if it keeps coming back, then mark handled.",
  };
}

/** "5m ago", "3h ago", "2d ago" for an ISO time; empty when it cannot be read. */
export function ageText(iso: string | null | undefined, now: Date): string {
  const t = Date.parse(iso ?? "");
  if (!Number.isFinite(t)) return "";
  const min = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)}h ago`;
  return `${Math.floor(min / 1440)}d ago`;
}

// ---- links ------------------------------------------------------------------------------------------------------------------------------

const HOSTS: Record<string, string[]> = { linkedin: ["linkedin.com"], naukri: ["naukri.com"], wellfound: ["wellfound.com"] };

/** An external "Open on <platform>" link only for an https URL on that platform's own host, no credentials, no port. Else null. */
export function platformUrl(platform: string | null, raw: unknown): string | null {
  const hosts = HOSTS[(platform ?? "").toLowerCase()];
  if (!hosts || typeof raw !== "string") return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    const h = u.hostname.toLowerCase();
    return hosts.some((d) => h === d || h.endsWith(`.${d}`)) ? u.toString() : null;
  } catch {
    return null;
  }
}

// ---- filters ----------------------------------------------------------------------------------------------------------------------------

export type Filters = { type: string; platform: string; status: InboxStatus; q: string };
export const DEFAULT_FILTERS: Filters = { type: "", platform: "", status: "open", q: "" };

function haystack(i: InboxItem): string {
  const d = describeItem(i);
  return [d.summary, d.action, i.senderName, i.personName, i.personCompany, i.jobTitle, i.platform, i.reason, i.excerpt, i.detail, i.applyJob?.title, i.applyJob?.company, i.applyJob?.host]
    .filter(Boolean).join("\n").toLowerCase();
}

type Skip = "type" | "platform" | "status";
function matches(i: InboxItem, f: Filters, skip?: Skip): boolean {
  if (skip !== "type" && f.type && inboxType(i) !== f.type) return false;
  if (skip !== "platform" && f.platform && platformKey(i) !== f.platform) return false;
  if (skip !== "status" && f.status !== "all" && statusOf(i) !== f.status) return false;
  const needle = f.q.trim().toLowerCase();
  return !needle || haystack(i).includes(needle);
}

/** Items that pass every filter, in display order. */
export function filterItems(items: InboxItem[], f: Filters): InboxItem[] {
  return sortItems(items.filter((i) => matches(i, f)));
}

export type FacetCounts = { type: Record<string, number>; platform: Record<string, number>; status: Record<string, number> };

/** Count per filter value, each with the OTHER filters applied (so a count says what choosing that value would show). */
export function facetCounts(items: InboxItem[], f: Filters): FacetCounts {
  const out: FacetCounts = { type: {}, platform: {}, status: {} };
  for (const t of TYPE_ORDER) out.type[t] = 0;
  for (const p of [...PLATFORM_ORDER, "other"]) out.platform[p] = 0;
  for (const s of ["open", "handled", "all"]) out.status[s] = 0;
  for (const i of items) {
    if (matches(i, f, "type")) out.type[inboxType(i)] += 1;
    if (matches(i, f, "platform")) out.platform[platformKey(i)] += 1;
    if (matches(i, f, "status")) {
      out.status[statusOf(i)] += 1;
      out.status.all += 1;
    }
  }
  return out;
}
