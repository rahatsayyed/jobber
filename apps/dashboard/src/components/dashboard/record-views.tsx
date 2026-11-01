"use client";

import { useEffect, useMemo, useState } from "react";
import { api, readableTime } from "@/lib/dashboard-api";
import { formatDuration, funnelLabel, humanize } from "@/lib/view-models";
import {
  Badge, DebouncedSearch, FilterSelect, ListFrame, LoadingLines, Panel, StatusBadge, Toolbar, usePaged,
} from "@/components/dashboard/list-kit";

// ---------------------------------------------------------------- Outcomes
type Funnel = { threshold: number; discovered: number; matched: number; contacted: number; replied: number; interview: number; offer: number; rates: Record<string, number | null>; first_response_days_median: number | null };
type OutcomeRow = { id: number; job_id: string; title: string | null; company: string | null; outcome: string; note: string | null; created_at: string };
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : `${Math.round(v * 1000) / 10}%`);

export function OutcomesView() {
  const [funnel, setFunnel] = useState<Funnel | null>(null); const [fErr, setFErr] = useState<string | null>(null); const [outcome, setOutcome] = useState("");
  useEffect(() => { api<Funnel>("/api/funnel").then(setFunnel).catch((e) => setFErr(e instanceof Error ? e.message : "Could not load the funnel.")); }, []);
  const list = usePaged<OutcomeRow>("/api/outcomes", { outcome: outcome || undefined });
  return <div className="stack">
    <section className="section"><div className="section-head"><h3>Funnel</h3><span className="updated-at">{funnel ? `match threshold ${funnel.threshold}` : ""}</span></div>
      {fErr ? <div className="notice danger">{fErr}</div> : !funnel ? <LoadingLines /> : <>
        <div className="funnel">{(["discovered", "matched", "contacted", "replied", "interview", "offer"] as const).map((k, i) => <div className="funnel-step" key={k}><span>{String(i + 1).padStart(2, "0")}</span><strong>{funnelLabel(k)}</strong><b>{funnel[k]}</b></div>)}</div>
        <p className="muted">Reply rate {pct(funnel.rates.reply)} · interview rate {pct(funnel.rates.interview)} · rejection rate {pct(funnel.rates.rejection)} · median days to first response {funnel.first_response_days_median ?? "n/a"}</p></>}
    </section>
    <Panel title="Recorded outcomes" toolbar={<Toolbar onReload={list.reload} loading={list.loading}>
      <FilterSelect label="Outcome" value={outcome} onChange={setOutcome} options={[{ value: "", label: "Any outcome" }, ...["replied", "interview", "offer", "hired", "rejected", "no_response"].map((o) => ({ value: o, label: humanize(o) }))]} />
    </Toolbar>}>
      <ListFrame state={list} empty={{ title: "No outcomes recorded yet", text: "Outcomes appear when a reply is approved in /checkreplies or you run /outcome <job_id> <outcome>." }}>
        {(items) => items.map((o) => <div className="object-row" key={o.id}><div><strong>{[o.title, o.company].filter(Boolean).join(" at ") || o.job_id}</strong><p>{o.note ?? "No note"} · {readableTime(o.created_at)}</p></div><StatusBadge status={o.outcome} /></div>)}
      </ListFrame>
    </Panel>
  </div>;
}

// ---------------------------------------------------------------- Runs
type RunRow = { id: string; trigger: string; status: string; planned_at: string; started_at: string | null; ended_at: string | null; wall_sec: number | null; dry_run: boolean; stop_reason: string | null; tool_calls: number; operators: string[] };

export function RunsView() {
  const [status, setStatus] = useState(""); const [hideSkipped, setHideSkipped] = useState(true);
  const list = usePaged<RunRow>("/api/runs", { status: status || undefined, hideSkipped: hideSkipped && !status ? "1" : undefined });
  const [statuses, setStatuses] = useState<{ status: string; count: number }[]>([]);
  useEffect(() => { api<{ statuses?: { status: string; count: number }[] }>("/api/runs?limit=1").then((r) => setStatuses(r.statuses ?? [])).catch(() => undefined); }, []);
  return <Panel title="Scheduler runs" toolbar={<Toolbar onReload={list.reload} loading={list.loading}>
    <FilterSelect label="Status" value={status} onChange={setStatus} options={[{ value: "", label: "Any status" }, ...statuses.map((s) => ({ value: s.status, label: `${humanize(s.status)} (${s.count})` }))]} />
    <label className="check"><input type="checkbox" checked={hideSkipped} onChange={(e) => setHideSkipped(e.target.checked)} disabled={!!status} /> Hide skipped wakes</label>
  </Toolbar>}>
    <ListFrame state={list} empty={{ title: "No runs yet", text: "The scheduler has not recorded a wake." }}>
      {(items) => items.map((r) => <div className="object-row" key={r.id}>
        <div><strong>{humanize(r.trigger)} wake{r.dry_run ? " (dry run)" : ""}</strong>
          <p>{readableTime(r.started_at ?? r.planned_at)} · {formatDuration(r.wall_sec)} · {r.tool_calls} tool calls{r.stop_reason ? ` · ${humanize(r.stop_reason)}` : ""}</p>
          {r.operators.length ? <p>{r.operators.join(" | ")}</p> : null}</div>
        <StatusBadge status={r.status} /></div>)}
    </ListFrame>
  </Panel>;
}

// ---------------------------------------------------------------- Audit
type AuditRow = { id: number; at: string; kind: string; ip: string | null; note: string | null };

export function AuditView() {
  const list = usePaged<AuditRow>("/api/audit", {}, "before");
  return <Panel title="Audit log" toolbar={<Toolbar onReload={list.reload} loading={list.loading} />}>
    <ListFrame state={list} empty={{ title: "No audit events", text: "Sign-ins and operator actions are recorded here." }}>
      {(items) => items.map((a) => <div className="object-row" key={a.id}>
        <div><strong>{humanize(a.kind)}</strong><p>{readableTime(a.at)}{a.ip ? ` · from ${a.ip}` : ""}{a.note ? ` · ${a.note}` : ""}</p></div><code>#{a.id}</code></div>)}
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
    {groups.map(([section, rows]) => <details className="setting-group" key={section} open={!!q}><summary>{humanize(section)} <span className="muted">({rows.length})</span></summary>
      <div className="object-list">{rows.map((i) => <div className="object-row" key={i.name}>
        <div><strong><code>{i.name}</code></strong><p>{i.about}</p><p>Default {i.default ?? "none"}{i.restart && i.restart !== "none" ? ` · restart ${i.restart}` : ""}</p></div>
        <span>{i.masked ? <Badge tone={i.value === "set" ? "good" : ""}>{i.value}</Badge> : <Badge tone={i.value !== "unset" ? "warn" : ""}>{i.value === "unset" ? `default ${i.default ?? "none"}` : i.value}</Badge>}</span></div>)}</div></details>)}
  </Panel>;
}
