// Pure layout model for the dashboard Inbox: the fixed order of the groups, the sticky summary row and the grouping of apply problems by site.
// No React, no fetch, no path aliases, so vitest can import this file directly. Titles, hosts and reasons are untrusted text: this file only
// counts, compares and builds closed sentences from reason codes.
import { APPLY_SHORT, inboxType, parseReason, sortItems, statusOf, type InboxItem } from "./inbox-model";

/** The five groups of the Inbox, top to bottom: people first, then what the agent needs from you, then things to fix, then manual work, then the rest. */
export type SectionId = "replies" | "needs-answer" | "platform" | "manual" | "other";
export const SECTION_ORDER: SectionId[] = ["replies", "needs-answer", "platform", "manual", "other"];
export const SECTION_LABELS: Record<SectionId, string> = {
  replies: "Replies and recruiters", "needs-answer": "Needs your answer", platform: "Platform problems", manual: "Apply by hand", other: "Flagged and other",
};
/** The DOM id of a group (the summary row links to it). */
export const sectionAnchor = (id: SectionId): string => `inbox-${id}`;

export type EscalationSection = "replies" | "platform" | "other";

/** Which group an escalation card belongs to: replies and recruiter inquiries, platform and apply problems, or flagged and other. */
export function sectionOfItem(i: Pick<InboxItem, "group" | "platform" | "askKind">): EscalationSection {
  const t = inboxType(i);
  if (t === "reply" || t === "recruiter") return "replies";
  if (t === "platform" || t === "apply") return "platform";
  return "other";
}

export type SplitSections = Record<EscalationSection, InboxItem[]>;

/** The cards split into their groups, each in display order. */
export function splitSections(items: InboxItem[]): SplitSections {
  const out: SplitSections = { replies: [], platform: [], other: [] };
  for (const i of sortItems(items)) out[sectionOfItem(i)].push(i);
  return out;
}

export type SectionCounts = { replies: number; needsAnswer: number; platform: number; manual: number; other: number };

/** Open (not handled) cards per escalation group. */
export function openSectionCounts(items: InboxItem[]): Pick<SectionCounts, "replies" | "platform" | "other"> {
  const out = { replies: 0, platform: 0, other: 0 };
  for (const i of items) if (statusOf(i) === "open") out[sectionOfItem(i)] += 1;
  return out;
}

export type SummaryEntry = { id: SectionId; label: string; count: number; href: string };

/** The sticky summary row: every group in the fixed order with its count and an anchor link. */
export function buildSummary(c: SectionCounts): SummaryEntry[] {
  const counts: Record<SectionId, number> = { replies: c.replies, "needs-answer": c.needsAnswer, platform: c.platform, manual: c.manual, other: c.other };
  return SECTION_ORDER.map((id) => ({ id, label: SECTION_LABELS[id], count: counts[id], href: `#${sectionAnchor(id)}` }));
}

/** The total the summary and the nav badge agree on: each job is counted once, because the server hides duplicate apply cards. */
export const summaryTotal = (entries: SummaryEntry[]): number => entries.reduce((n, e) => n + e.count, 0);

// ---- apply problems grouped by site -----------------------------------------------------------------------------------------------------

export type HostGroup = { kind: "host"; key: string; host: string | null; reasonKey: string; title: string; items: InboxItem[] };
export type CardBlock = { kind: "card"; item: InboxItem } | HostGroup;

const applyKey = (i: InboxItem): string => (/^apply:(.+)$/i.exec(parseReason(i.reason).base)?.[1] ?? "other").toLowerCase();

/** "kompatibleminds.com: 3 jobs, page structure changed". */
export function hostGroupTitle(host: string | null, n: number, reasonKey: string): string {
  return `${host ?? "Unknown site"}: ${n} job${n === 1 ? "" : "s"}, ${APPLY_SHORT[reasonKey] ?? reasonKey.replace(/[_:.-]+/g, " ")}`;
}

/**
 * Apply cards of one site with the same reason become ONE group block (expandable); a single card stays a card. A group sits where its first
 * card was, so the order of the list is kept. Cards that are not apply problems are never grouped.
 */
export function groupApplyByHost(items: InboxItem[]): CardBlock[] {
  const buckets = new Map<string, InboxItem[]>();
  for (const i of items) {
    if (inboxType(i) !== "apply" || /^apply:needs_(answer|human)/i.test(i.reason)) continue;
    const key = `${i.applyJob?.host ?? ""}\u0001${applyKey(i)}`;
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(i);
  }
  const out: CardBlock[] = [];
  const placed = new Set<string>();
  for (const i of items) {
    const key = inboxType(i) === "apply" && !/^apply:needs_(answer|human)/i.test(i.reason) ? `${i.applyJob?.host ?? ""}\u0001${applyKey(i)}` : null;
    const group = key ? buckets.get(key) : undefined;
    if (!key || !group || group.length < 2) { out.push({ kind: "card", item: i }); continue; }
    if (placed.has(key)) continue;
    placed.add(key);
    const host = i.applyJob?.host ?? null;
    out.push({ kind: "host", key, host, reasonKey: applyKey(i), title: hostGroupTitle(host, group.length, applyKey(i)), items: group });
  }
  return out;
}

/** Every escalation row id behind a block (what "mark handled" sends). */
export const blockIds = (b: CardBlock): number[] => (b.kind === "card" ? b.item.ids : b.items.flatMap((i) => i.ids));

/** The first `shown` blocks and how many are left. */
export function pageBlocks<T>(blocks: T[], shown: number): { visible: T[]; rest: number } {
  return { visible: blocks.slice(0, shown), rest: Math.max(0, blocks.length - shown) };
}
