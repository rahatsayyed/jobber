"use client";

import { ArchiveIcon, BellIcon, DotsThreeOutlineIcon, BriefcaseIcon, ChartLineUpIcon, ClipboardTextIcon, EnvelopeSimpleIcon, GearSixIcon, HouseIcon, ListChecksIcon, SignOutIcon, UsersThreeIcon, WarningCircleIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ThemeToggle } from "@/components/dashboard/theme-toggle";
import { InboxView } from "@/components/dashboard/inbox-view";
import { LoadingLines } from "@/components/dashboard/list-kit";
import { AuditView, OutcomesView, RunsView, SettingsView } from "@/components/dashboard/record-views";
import { JobsView, MailView, PeopleView, renderPanel } from "@/components/dashboard/linked-views";
import { PanelProvider } from "@/components/dashboard/panel-context";
import { SessionsView } from "@/components/dashboard/terminal-view";
import { api, readableTime, Snapshot } from "@/lib/dashboard-api";
import { ceilingLabel, funnelHref, funnelLabel, inventoryMetrics, JobCounts, queueStatusInfo, statusLabel, titleWord } from "@/lib/view-models";

type Section = { id: string; label: string; icon: typeof HouseIcon; description: string };
const sections: Section[] = [
  { id: "overview", label: "Overview", icon: HouseIcon, description: "Pipeline health, limits, and the next owner decision." },
  { id: "inbox", label: "Inbox", icon: BellIcon, description: "One list of everything that needs you: replies, problems and flagged text. Filter by type, platform and status." },
  { id: "jobs", label: "Jobs", icon: BriefcaseIcon, description: "Every discovered job with its score, source and state. Open a row for the full picture." },
  { id: "people", label: "People", icon: UsersThreeIcon, description: "Recruiters and peers the agent found, with connection state and message history." },
  { id: "mail", label: "Mail", icon: EnvelopeSimpleIcon, description: "Cold emails that were sent. Open one to read the message." },
  { id: "outcomes", label: "Outcomes", icon: ChartLineUpIcon, description: "Recorded hiring outcomes and the funnel behind them." },
  { id: "runs", label: "Runs", icon: ListChecksIcon, description: "Recent scheduler wakes: when they ran, how long, and how they ended." },
  { id: "sessions", label: "Sessions", icon: ClipboardTextIcon, description: "Live view of the Jobber tmux windows." },
  { id: "settings", label: "Settings", icon: GearSixIcon, description: "Read-only view of the effective limits and flags. Secrets are never shown." },
  { id: "audit", label: "Audit", icon: ArchiveIcon, description: "Sign-ins and operator actions." },
];

/** The four pages kept in the phone tab bar; every other page is one tap away under "More". */
const PRIMARY_TABS = ["overview", "inbox", "jobs", "mail"];
const hrefOf = (id: string) => (id === "overview" ? "/" : `/${id}`);

/** Bottom tab bar for phones (hidden on wide screens by CSS): four main pages plus a "More" sheet that lists all ten. */
function MobileNav({ activeId, inboxOpen, pathname }: { activeId: string; inboxOpen: number; pathname: string }) {
  const [more, setMore] = useState<string | null>(null); // the pathname the sheet was opened on, so a page change closes it
  const isOpen = more === pathname;
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMore(null); };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = previous; };
  }, [isOpen]);
  const badge = (id: string) => (id === "inbox" && inboxOpen > 0 ? <span className="nav-badge" aria-label={`${inboxOpen} open`}>{inboxOpen}</span> : null);
  const otherActive = !PRIMARY_TABS.includes(activeId);
  return <>
    <nav className="tabbar" aria-label="Main pages">
      {sections.filter((x) => PRIMARY_TABS.includes(x.id)).map((item) => { const Icon = item.icon; const on = item.id === activeId;
        return <Link key={item.id} href={hrefOf(item.id)} className="tab" aria-current={on ? "page" : undefined}><span className="tab-icon"><Icon size={22} weight={on ? "fill" : "regular"} aria-hidden="true" />{badge(item.id)}</span><span className="tab-label">{item.label}</span></Link>; })}
      <button type="button" className="tab" aria-haspopup="dialog" aria-expanded={isOpen} aria-current={otherActive ? "page" : undefined} onClick={() => setMore(isOpen ? null : pathname)}>
        <span className="tab-icon"><DotsThreeOutlineIcon size={22} weight={otherActive ? "fill" : "regular"} aria-hidden="true" /></span><span className="tab-label">More</span></button>
    </nav>
    {isOpen ? <div className="more-layer"><div className="more-backdrop" onClick={() => setMore(null)} aria-hidden="true" />
      <div className="more-sheet" role="dialog" aria-modal="true" aria-label="All pages">
        <div className="more-head"><strong>All pages</strong><button type="button" className="icon-button" onClick={() => setMore(null)} aria-label="Close the page list">&times;</button></div>
        <ul className="more-list">{sections.map((item) => { const Icon = item.icon; const on = item.id === activeId;
          return <li key={item.id}><Link href={hrefOf(item.id)} className="more-item" aria-current={on ? "page" : undefined} onClick={() => setMore(null)}><Icon size={20} weight={on ? "fill" : "regular"} aria-hidden="true" /><span>{item.label}</span>{badge(item.id)}</Link></li>; })}</ul>
      </div></div> : null}
  </>;
}

function getSection(id: string) { const key = id === "archive" ? "audit" : id; return sections.find((section) => section.id === key) ?? sections[0]; }

function SectionBody({ id }: { id: string }) {
  switch (id) {
    case "inbox": return <InboxView />;
    case "jobs": return <JobsView />;
    case "people": return <PeopleView />;
    case "mail": return <MailView />;
    case "outcomes": return <OutcomesView />;
    case "runs": return <RunsView />;
    case "sessions": return <SessionsView />;
    case "settings": return <SettingsView />;
    case "audit": return <AuditView />;
    default: return null;
  }
}

function Overview() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [jobCounts, setJobCounts] = useState<JobCounts | null>(null);
  const [scored, setScored] = useState(0);
  const [threshold, setThreshold] = useState(60);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [nextSnapshot, nextCounts, facets, funnel] = await Promise.all([
        api<Snapshot>("/api/status"), api<JobCounts>("/api/jobs/counts"), api<{ scored: number }>("/api/jobs/facets"),
        api<{ threshold: number }>("/api/funnel").catch(() => ({ threshold: 60 })),
      ]);
      setSnapshot(nextSnapshot); setJobCounts(nextCounts); setScored(facets.scored); setThreshold(funnel.threshold); setError(null);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The dashboard data could not be loaded."); }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => { void load(); }, 0);
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load]);
  if (error) return <section className="notice danger"><strong>Dashboard connection unavailable.</strong><br />{error} Configure <code>JOBBER_API_ORIGIN</code> to the existing local Jobber server, then sign in.</section>;
  if (!snapshot || !jobCounts) return <LoadingLines />;
  return <div className="overview-grid"><div className="stack">
    <section className="section"><div className="section-head"><h3>Job inventory</h3><Link href="/jobs">Open jobs</Link></div>
      <div className="metrics">{inventoryMetrics(jobCounts, scored, threshold).map((m) => <Link className="metric" href={m.href} key={m.key} title={`${m.hint} Click to see these jobs.`}><span className="metric-value">{m.value}</span><span className="metric-label">{m.label}</span><span className="metric-hint">{m.hint}</span></Link>)}</div></section>
    <section className="section"><div className="section-head"><h3>Outreach funnel</h3><Link href="/outcomes">View outcomes</Link></div>
      <div className="funnel">{Object.entries(snapshot.funnel).map(([label, value], index) => { const href = funnelHref(label); const inner = <><span>{String(index + 1).padStart(2, "0")}</span><strong>{funnelLabel(label)}</strong><b>{value}</b></>;
        return href ? <Link className="funnel-step" key={label} href={href} title="Open the matching list">{inner}</Link> : <div className="funnel-step" key={label}>{inner}</div>; })}</div>
      <p className="muted">Each step counts jobs, not messages. Click a step to see them.</p></section>
    <section className="section"><div className="section-head"><h3>Outbound queue</h3><span className="updated-at">Last send: {snapshot.lastSend ? readableTime(snapshot.lastSend.at) : "none"}</span></div>
      <div className="data-list">{snapshot.queue.length ? snapshot.queue.map((entry) => { const info = queueStatusInfo(entry.status); const inner = <><div className="data-row-main"><strong>{info.label}</strong><span>{info.hint}</span></div><span className="data-row-value">{entry.count}</span></>;
        return info.href ? <Link className="data-row" key={entry.status} href={info.href}>{inner}</Link> : <div className="data-row" key={entry.status}>{inner}</div>; }) : <div className="empty-state"><h3>Queue is clear</h3>There is no queued outreach right now.</div>}</div></section>
  </div><aside className="stack" id="limits-and-holds">
    <section className="section"><div className="section-head"><h3>Daily ceilings</h3></div><div>{Object.entries(snapshot.ceilings).map(([key, ceiling]) => <div className="limit-row" key={key} title={ceiling.ok ? "Room left today" : "Limit reached for today"}><span>{ceilingLabel(key)}</span><b className={ceiling.ok ? "ok" : "blocked"}>{ceiling.used} of {ceiling.limit}</b></div>)}</div><p className="muted">Used so far today, then the daily limit. Counted over a rolling day.</p></section>
    <section className="section"><div className="section-head"><h3>Safety holds</h3><Link href="/inbox">Open inbox</Link></div>{snapshot.halts.length ? <div className="data-list">{snapshot.halts.map((halt) => <div className="data-row" key={halt.platform}><div className="data-row-main"><strong>{titleWord(halt.platform)}</strong><span>{statusLabel(halt.reason)}{halt.setAt ? ` · since ${readableTime(halt.setAt)}` : ""}</span></div><WarningCircleIcon size={17} color="var(--danger)" aria-label="Halted" /></div>)}</div> : <div className="notice"><strong>No active halts.</strong><br />The scheduler can continue subject to its other guards.</div>}</section>
    {snapshot.degraded.length ? <div className="notice warning"><strong>Partial data</strong><br />Some status sections are unavailable: {snapshot.degraded.join(", ")}.</div> : null}
  </aside></div>;
}

export function DashboardShell({ section: initialSection }: { section: string }) {
  const pathname = usePathname(); const router = useRouter(); const section = useMemo(() => getSection(initialSection), [initialSection]); const [mode, setMode] = useState<"DRY RUN" | "LIVE" | null>(null); const [csrf, setCsrf] = useState<string | null>(null); const [inboxOpen, setInboxOpen] = useState(0);
  useEffect(() => {
    const refresh = () => { api<{ badge?: number; cards?: number; open?: number }>("/api/escalations/count").then((c) => setInboxOpen(c.badge ?? c.cards ?? c.open ?? 0)).catch(() => undefined); };
    refresh(); const timer = window.setInterval(refresh, 60_000); window.addEventListener("inbox-changed", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("inbox-changed", refresh); };
  }, []);
  useEffect(() => {
    if (window.location.hash.startsWith("#token=")) { router.replace(`/login${window.location.hash}`); return; }
    api<{ mode?: { mode?: "DRY RUN" | "LIVE" }; csrf?: string }>("/api/session").then((session) => { setMode(session.mode?.mode ?? null); setCsrf(session.csrf ?? null); }).catch(() => router.replace("/login"));
  }, [router]);
  async function signOut() { if (csrf) await fetch("/api/logout", { method: "POST", headers: { "X-CSRF-Token": csrf } }).catch(() => undefined); router.replace("/login"); }
  return <PanelProvider render={renderPanel}><div className="app-shell"><aside className="rail"><Link className="brand" href="/"><span className="brand-mark" aria-hidden="true" /><strong>Jobber</strong><span>operator</span></Link>
    <nav className="rail-nav" aria-label="Dashboard sections">{sections.map((item) => { const Icon = item.icon; const href = item.id === "overview" ? "/" : `/${item.id}`; const active = item.id === section.id && (item.id !== "overview" || pathname === "/"); return <Link key={item.id} href={href} className="nav-link" aria-label={item.label} title={item.label} aria-current={active ? "page" : undefined}><Icon size={18} weight={active ? "fill" : "regular"} aria-hidden="true" /><span>{item.label}</span>{item.id === "inbox" && inboxOpen > 0 ? <span className="nav-badge" aria-label={`${inboxOpen} open`}>{inboxOpen}</span> : null}</Link>; })}</nav>
    <div className="rail-footer"><strong>Local operator surface</strong>Actions remain protected by the Jobber API.</div></aside>
    <main className="workspace"><header className="topbar"><h1>Jobber</h1><div className="topbar-actions"><span className={`status-chip ${mode === "DRY RUN" ? "dry" : mode === "LIVE" ? "live" : ""}`}><i aria-hidden="true" />{mode ?? "Connecting"}</span><ThemeToggle /><button className="icon-button" type="button" onClick={() => void signOut()} aria-label="Sign out" title="Sign out"><SignOutIcon size={17} aria-hidden="true" /></button></div></header>
      <div className="content"><header className="page-heading"><div><h2>{section.label}</h2><p>{section.description}</p></div>{section.id === "overview" ? <p className="updated-at">Refreshes every 30 seconds</p> : null}</header>
        {section.id === "overview" ? <><section className="mode-callout"><div><strong>{mode === "LIVE" ? "Live mode is active" : "Dry-run mode is active"}</strong><span>Review current limits and holds before asking the pipeline to do work.</span></div><a href="#limits-and-holds" className="button">Review limits and holds</a></section><Overview /></> : <SectionBody id={section.id} />}
      </div></main><MobileNav activeId={section.id} inboxOpen={inboxOpen} pathname={pathname} /></div></PanelProvider>;
}
