"use client";

import { ArchiveIcon, ArrowClockwiseIcon, BellIcon, BriefcaseIcon, ChartLineUpIcon, ClipboardTextIcon, EnvelopeSimpleIcon, GearSixIcon, HouseIcon, ListChecksIcon, SignOutIcon, UsersThreeIcon, WarningCircleIcon } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, detailFor, labelFor, readableTime, Snapshot, WorkspaceItem } from "@/lib/dashboard-api";

type Section = { id: string; label: string; icon: typeof HouseIcon; endpoint?: string; description: string };
const sections: Section[] = [
  { id: "overview", label: "Overview", icon: HouseIcon, description: "Pipeline health, limits, and the next owner decision." },
  { id: "inbox", label: "Inbox", icon: BellIcon, endpoint: "/api/escalations", description: "Replies and exceptions that need your attention." },
  { id: "jobs", label: "Jobs", icon: BriefcaseIcon, endpoint: "/api/jobs", description: "The current job inventory and match states." },
  { id: "people", label: "People", icon: UsersThreeIcon, endpoint: "/api/people", description: "Contacts and conversation history." },
  { id: "mail", label: "Mail", icon: EnvelopeSimpleIcon, endpoint: "/api/emails", description: "Delivered outreach and follow-up activity." },
  { id: "outcomes", label: "Outcomes", icon: ChartLineUpIcon, endpoint: "/api/outcomes", description: "Recorded hiring outcomes and funnel context." },
  { id: "runs", label: "Runs", icon: ListChecksIcon, endpoint: "/api/runs", description: "Recent pipeline activity." },
  { id: "sessions", label: "Sessions", icon: ClipboardTextIcon, endpoint: "/api/sessions", description: "Connected worker sessions." },
  { id: "settings", label: "Settings", icon: GearSixIcon, endpoint: "/api/config", description: "Read-only configuration and pending changes." },
  { id: "archive", label: "Audit", icon: ArchiveIcon, endpoint: "/api/audit", description: "Authentication and operator audit events." },
];

function getSection(id: string) { return sections.find((section) => section.id === id) ?? sections[0]; }
function asItems(payload: unknown): WorkspaceItem[] { if (!payload || typeof payload !== "object") return []; const data = payload as { items?: WorkspaceItem[]; sessions?: WorkspaceItem[] }; return Array.isArray(data.items) ? data.items : Array.isArray(data.sessions) ? data.sessions : []; }
function LoadingLines() { return <div className="loading" aria-label="Loading"><span /><span /><span /></div>; }

function SectionList({ section }: { section: Section }) {
  const [items, setItems] = useState<WorkspaceItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const load = useCallback(async () => {
    if (!section.endpoint) return;
    setReloading(true); setError(null);
    try { setItems(asItems(await api<unknown>(`${section.endpoint}?limit=12`))); } catch (reason) { setError(reason instanceof Error ? reason.message : "The data could not be loaded."); } finally { setReloading(false); }
  }, [section.endpoint]);
  useEffect(() => {
    const initial = window.setTimeout(() => { void load(); }, 0);
    return () => window.clearTimeout(initial);
  }, [load]);
  return <section className="workspace-panel" aria-live="polite"><div className="workspace-panel-header"><h3>Latest records</h3><button className="icon-button" onClick={() => void load()} type="button" aria-label="Refresh records" disabled={reloading}><ArrowClockwiseIcon size={16} aria-hidden="true" /></button></div>{items === null && !error ? <div className="object-list"><LoadingLines /></div> : null}{error ? <div className="notice danger"><strong>Could not load this view.</strong><br />{error}</div> : null}{items?.length ? <div className="object-list">{items.map((item, index) => <article className="object-row" key={String(item.id ?? index)}><div><strong>{labelFor(item)}</strong><p>{detailFor(item)}</p></div><code>{String(item.id ?? item.status ?? "")}</code></article>)}</div> : null}{items && !items.length ? <div className="empty-state"><h3>No records yet</h3>This area will populate as the pipeline produces relevant activity.</div> : null}</section>;
}

function Overview() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [jobCounts, setJobCounts] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => { try { const [nextSnapshot, nextCounts] = await Promise.all([api<Snapshot>("/api/status"), api<Record<string, number>>("/api/jobs/counts")]); setSnapshot(nextSnapshot); setJobCounts(nextCounts); setError(null); } catch (reason) { setError(reason instanceof Error ? reason.message : "The dashboard data could not be loaded."); } }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => { void load(); }, 0);
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load]);
  if (error) return <section className="notice danger"><strong>Dashboard connection unavailable.</strong><br />{error} Configure <code>JOBBER_API_ORIGIN</code> to the existing local Jobber server, then sign in.</section>;
  if (!snapshot || !jobCounts) return <LoadingLines />;
  return <div className="overview-grid"><div className="stack"><section className="section"><div className="section-head"><h3>Job inventory</h3><Link href="/jobs">Open jobs</Link></div><div className="metrics">{Object.entries(jobCounts).map(([label, value]) => <div className="metric" key={label}><span className="metric-value">{value}</span><span className="metric-label">{label}</span></div>)}</div></section><section className="section"><div className="section-head"><h3>Pipeline</h3><Link href="/outcomes">View outcomes</Link></div><div className="funnel">{Object.entries(snapshot.funnel).map(([label, value], index) => <div className="funnel-step" key={label}><span>{String(index + 1).padStart(2, "0")}</span><strong>{label}</strong><b>{value}</b></div>)}</div></section><section className="section"><div className="section-head"><h3>Outbound queue</h3><span className="updated-at">Last send: {snapshot.lastSend ? readableTime(snapshot.lastSend.at) : "none"}</span></div><div className="data-list">{snapshot.queue.length ? snapshot.queue.map((entry) => <div className="data-row" key={entry.status}><div className="data-row-main"><strong>{entry.status}</strong><span>Current queue status</span></div><span className="data-row-value">{entry.count}</span></div>) : <div className="empty-state"><h3>Queue is clear</h3>There is no queued outreach right now.</div>}</div></section></div><aside className="stack"><section className="section"><div className="section-head"><h3>Daily ceilings</h3></div><div>{Object.entries(snapshot.ceilings).map(([key, ceiling]) => <div className="limit-row" key={key}><span>{key}</span><b className={ceiling.ok ? "ok" : "blocked"}>{ceiling.used} / {ceiling.limit}</b></div>)}</div></section><section className="section"><div className="section-head"><h3>Safety holds</h3><Link href="/inbox">Open inbox</Link></div>{snapshot.halts.length ? <div className="data-list">{snapshot.halts.map((halt) => <div className="data-row" key={halt.platform}><div className="data-row-main"><strong>{halt.platform}</strong><span>{halt.reason}</span></div><WarningCircleIcon size={17} color="var(--danger)" aria-label="Halted" /></div>)}</div> : <div className="notice"><strong>No active halts.</strong><br />The scheduler can continue subject to its other guards.</div>}</section>{snapshot.degraded.length ? <div className="notice warning"><strong>Partial data</strong><br />Some status sections are unavailable: {snapshot.degraded.join(", ")}.</div> : null}</aside></div>;
}

export function DashboardShell({ section: initialSection }: { section: string }) {
  const pathname = usePathname(); const router = useRouter(); const section = useMemo(() => getSection(initialSection), [initialSection]); const [mode, setMode] = useState<"DRY RUN" | "LIVE" | null>(null); const [csrf, setCsrf] = useState<string | null>(null);
  useEffect(() => {
    if (window.location.hash.startsWith("#token=")) { router.replace(`/login${window.location.hash}`); return; }
    api<{ mode?: { mode?: "DRY RUN" | "LIVE" }; csrf?: string }>("/api/session").then((session) => { setMode(session.mode?.mode ?? null); setCsrf(session.csrf ?? null); }).catch(() => router.replace("/login"));
  }, [router]);
  async function signOut() { if (csrf) await fetch("/api/logout", { method: "POST", headers: { "X-CSRF-Token": csrf } }).catch(() => undefined); router.replace("/login"); }
  return <div className="app-shell"><aside className="rail"><Link className="brand" href="/"><span className="brand-mark" aria-hidden="true" /><strong>Jobber</strong><span>operator</span></Link><nav className="rail-nav" aria-label="Dashboard sections">{sections.map((item) => { const Icon = item.icon; const href = item.id === "overview" ? "/" : `/${item.id}`; const active = item.id === section.id && (item.id !== "overview" || pathname === "/"); return <Link key={item.id} href={href} className="nav-link" aria-current={active ? "page" : undefined}><Icon size={18} weight={active ? "fill" : "regular"} aria-hidden="true" /><span>{item.label}</span></Link>; })}</nav><div className="rail-footer"><strong>Local operator surface</strong>Actions remain protected by the Jobber API.</div></aside><main className="workspace"><header className="topbar"><h1>Jobber</h1><div className="topbar-actions"><span className={`status-chip ${mode === "DRY RUN" ? "dry" : mode === "LIVE" ? "live" : ""}`}><i aria-hidden="true" />{mode ?? "Connecting"}</span><button className="icon-button" type="button" onClick={() => void signOut()} aria-label="Sign out"><SignOutIcon size={17} aria-hidden="true" /></button></div></header><div className="content"><header className="page-heading"><div><h2>{section.label}</h2><p>{section.description}</p></div>{section.id === "overview" ? <p className="updated-at">Refreshes every 30 seconds</p> : null}</header>{section.id === "overview" ? <><section className="mode-callout"><div><strong>{mode === "LIVE" ? "Live mode is active" : "Dry-run mode is active"}</strong><span>Review current limits and holds before asking the pipeline to do work.</span></div><Link href="/inbox" className="button">Review inbox</Link></section><Overview /></> : <SectionList section={section} />}</div></main></div>;
}
