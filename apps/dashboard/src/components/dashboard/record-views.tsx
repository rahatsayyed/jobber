"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, readableTime } from "@/lib/dashboard-api";
import { formatDuration, funnelHref, funnelLabel, statusLabel, titleWord, triggerName } from "@/lib/view-models";
import {
  Badge, DebouncedSearch, FilterGroup, FilterSelect, ListFrame, LoadingLines, Panel, RecordRow, StatusBadge, Toolbar, usePaged,
} from "@/components/dashboard/list-kit";
import { usePanels } from "@/components/dashboard/panel-context";
import { useUrlParam } from "@/components/dashboard/linked-views";

const OUTCOME_KINDS = ["replied", "interview", "offer", "hired", "rejected", "no_response"] as const;

// ---------------------------------------------------------------- Outcomes
type Funnel = { threshold: number; discovered: number; matched: number; contacted: number; replied: number; interview: number; offer: number; rates: Record<string, number | null>; first_response_days_median: number | null };
type OutcomeRow = { id: number; job_id: string; title: string | null; company: string | null; outcome: string; note: string | null; created_at: string };
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${Math.round(v * 1000) / 10}%`);

export function OutcomesView() {
  const { open } = usePanels();
  const [funnel, setFunnel] = useState<Funnel | null>(null); const [fErr, setFErr] = useState<string | null>(null);
  const [outcome, setOutcome] = useState(useUrlParam("outcome", OUTCOME_KINDS)); // /outcomes?outcome=interview from Home
  useEffect(() => { api<Funnel>("/api/funnel").then(setFunnel).catch((e) => setFErr(e instanceof Error ? e.message : "Could not load the funnel.")); }, []);
  const list = usePaged<OutcomeRow>("/api/outcomes", { outcome: outcome || undefined });
  return <div className="stack">
    <section className="section"><div className="section-head"><h3>Funnel</h3><span className="updated-at">{funnel ? `match threshold ${funnel.threshold}` : ""}</span></div>
      {fErr ? <div className="notice danger">{fErr}</div> : !funnel ? <LoadingLines /> : <>
        <div className="funnel">{(["discovered", "matched", "contacted", "replied", "interview", "offer"] as const).map((k, i) => { const href = funnelHref(k); const inner = <><span>{String(i + 1).padStart(2, "0")}</span><strong>{funnelLabel(k)}</strong><b>{funnel[k]}</b></>;
          return href ? <Link className="funnel-step" key={k} href={href} title="Open the matching list">{inner}</Link> : <div className="funnel-step" key={k}>{inner}</div>; })}</div>
        <p className="muted">Each step counts jobs, not messages. Reply rate {pct(funnel.rates.reply)} of contacted jobs · interview rate {pct(funnel.rates.interview)} · rejection rate {pct(funnel.rates.rejection)} · median days to first response {funnel.first_response_days_median ?? "n/a"}</p></>}
    </section>
    <Panel title="Recorded outcomes" toolbar={<Toolbar onReload={list.reload} loading={list.loading}>
      <FilterGroup activeCount={outcome ? 1 : 0}><FilterSelect label="Outcome" value={outcome} onChange={setOutcome} options={[{ value: "", label: "Any outcome" }, ...OUTCOME_KINDS.map((o) => ({ value: o, label: statusLabel(o) }))]} /></FilterGroup>
    </Toolbar>}>
      <ListFrame state={list} empty={{ title: "No outcomes recorded yet", text: "An outcome is saved when you approve a reply proposal or record one yourself (for example an interview or a rejection)." }}>
        {(items) => items.map((o) => <RecordRow key={o.id} onOpen={() => open({ kind: "job", id: o.job_id })}
          title={[o.title, o.company].filter(Boolean).join(" at ") || "Job no longer in the database"}
          meta={`${o.note ?? "No note"} · ${readableTime(o.created_at)}`} aside={<StatusBadge status={o.outcome} />} />)}
      </ListFrame>
    </Panel>
  </div>;
}

// ---------------------------------------------------------------- Runs
type RunRow = { id: string; trigger: string; status: string; planned_at: string; started_at: string | null; ended_at: string | null; wall_sec: number | null; dry_run: boolean; stop_reason: string | null; tool_calls: number; operators: string[]; escalations: number };

export function RunsView() {
  const { open } = usePanels();
  const [status, setStatus] = useState(""); const [hideSkipped, setHideSkipped] = useState(true);
  const list = usePaged<RunRow>("/api/runs", { status: status || undefined, hideSkipped: hideSkipped && !status ? "1" : undefined });
  const [statuses, setStatuses] = useState<{ status: string; count: number }[]>([]);
  useEffect(() => { api<{ statuses?: { status: string; count: number }[] }>("/api/runs?limit=1").then((r) => setStatuses(r.statuses ?? [])).catch(() => undefined); }, []);
  return <Panel title="Scheduler runs" toolbar={<Toolbar onReload={list.reload} loading={list.loading}>
    <FilterGroup activeCount={(status ? 1 : 0) + (!hideSkipped && !status ? 1 : 0)}>
      <FilterSelect label="Status" value={status} onChange={setStatus} options={[{ value: "", label: "Any result" }, ...statuses.map((r) => ({ value: r.status, label: `${statusLabel(r.status)} (${r.count})` }))]} />
      <label className="check"><input type="checkbox" checked={hideSkipped} onChange={(e) => setHideSkipped(e.target.checked)} disabled={!!status} /> Hide skipped wakes</label>
    </FilterGroup>
  </Toolbar>}>
    <ListFrame state={list} empty={{ title: "No runs yet", text: "The scheduler has not recorded a wake." }}>
      {(items) => items.map((r) => <RecordRow key={r.id} onOpen={() => open({ kind: "run", id: r.id })}
        title={`${triggerName(r.trigger)}${r.dry_run ? " (dry run, nothing real was sent)" : ""}`}
        meta={[`${readableTime(r.started_at ?? r.planned_at)} · took ${formatDuration(r.wall_sec)} · ${r.tool_calls} tool calls`, r.stop_reason ? `stopped: ${statusLabel(r.stop_reason)}` : null,
          r.operators.length ? `work planned: ${r.operators.join(" | ")}` : null, r.escalations ? `${r.escalations} inbox ${r.escalations === 1 ? "item" : "items"} from this run` : null].filter(Boolean).join(" · ")}
        aside={<StatusBadge status={r.status} />} />)}
    </ListFrame>
  </Panel>;
}

// ---------------------------------------------------------------- Audit
type AuditRow = { id: number; at: string; kind: string; ip: string | null; note: string | null };

export function AuditView() {
  const list = usePaged<AuditRow>("/api/audit", {}, "before");
  return <Panel title="Audit log" toolbar={<Toolbar onReload={list.reload} loading={list.loading} />}>
    <p className="muted">Who signed in and what they did in this dashboard, newest first. Typed terminal keys and message text are never recorded.</p>
    <ListFrame state={list} empty={{ title: "No audit events", text: "Sign-ins and operator actions are recorded here." }}>
      {(items) => items.map((a) => <div className="object-row" key={a.id}>
        <div><strong>{statusLabel(a.kind)}</strong><p>{readableTime(a.at)}{a.ip ? ` · from ${a.ip}` : ""}{a.note ? ` · ${a.note}` : ""}</p>
          {a.kind.startsWith("terminal_") ? <p><Link href="/sessions">Open Sessions</Link></p> : null}</div><span className="muted" title="Audit event number">event {a.id}</span></div>)}
    </ListFrame>
  </Panel>;
}

// ---------------------------------------------------------------- Settings (read only)
type ConfigItem = { name: string; value: string; masked: boolean; section?: string; feature?: string; about?: string; default?: string | null; restart?: string };

export function SettingsView() {
  const [items, setItems] = useState<ConfigItem[] | null>(null); const [error, setError] = useState<string | null>(null); const [q, setQ] = useState("");
  useEffect(() => { api<{ env: ConfigItem[] }>("/api/config").then((d) => setItems(d.env)).catch((e) => setError(e instanceof Error ? e.message : "Could not load settings.")); }, []);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const map = new Map<string, ConfigItem[]>();
    for (const i of items ?? []) {
      if (!i.section) continue; // names found only in .env.example have no description; they stay out of this page
      if (needle && !`${i.name} ${i.about ?? ""} ${i.feature ?? ""}`.toLowerCase().includes(needle)) continue;
      map.set(i.section, [...(map.get(i.section) ?? []), i]);
    }
    return [...map.entries()];
  }, [items, q]);
  return <Panel title="Effective settings (read only)" toolbar={<div className="toolbar"><DebouncedSearch value={q} onChange={setQ} placeholder="Search a setting" label="Search settings" /></div>}>
    <p className="muted">Values are what the dashboard process sees from <code>.env</code> and the environment. Secrets show only whether they are set. To change one, edit <code>.env</code> and restart the named service.</p>
    {error ? <div className="notice danger"><strong>Could not load settings.</strong><br />{error}</div> : null}
    {!items && !error ? <LoadingLines /> : null}
    {items && !groups.length ? <div className="empty-state"><h3>No setting matches</h3>Try another search word.</div> : null}
    {groups.map(([section, rows]) => <details className="setting-group" key={section} open={!!q}><summary>{titleWord(section)} <span className="muted">({rows.length})</span></summary>
      <div className="object-list">{rows.map((i) => <div className="object-row" key={i.name}>
        <div><strong><code>{i.name}</code></strong><p>{i.about}</p><p>Default {i.default ?? "none"}{i.restart && i.restart !== "none" ? ` · restart ${i.restart}` : ""}</p></div>
        <span>{i.masked ? <Badge tone={i.value === "set" ? "good" : ""}>{i.value}</Badge> : <Badge tone={i.value !== "unset" ? "warn" : ""}>{i.value === "unset" ? `default ${i.default ?? "none"}` : i.value}</Badge>}</span></div>)}</div></details>)}
  </Panel>;
}
