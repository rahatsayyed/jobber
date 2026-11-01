"use client";

import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { api, readableTime } from "@/lib/dashboard-api";
import { formatDuration, funnelLabel, humanize, safeExternalUrl } from "@/lib/view-models";
import {
  Badge, DebouncedSearch, DetailDrawer, DrawerState, FilterSelect, KV, ListFrame, LoadingLines, Panel, RecordRow, StatusBadge, Toolbar, useDetail, usePaged,
} from "@/components/dashboard/list-kit";

function ExternalLink({ href, children }: { href: unknown; children: ReactNode }) {
  const safe = safeExternalUrl(href);
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
}
const dash = (v: unknown) => (v === null || v === undefined || v === "" ? "Not recorded" : String(v));

// ---------------------------------------------------------------- Jobs
type JobRow = { id: string; title: string; company: string; source: string; score: number | null; status: string | null; excluded_reason: string | null; created_at: string; bucket: string[] };
type JobFull = JobRow & {
  url: string | null; apply_url: string | null; posted_at: string | null; deadline: string | null; confidence: string | null; flags: string[]; strengths: string[]; gaps: string[];
  queue: { id: number; status: string; email_status: string | null; connect_status: string | null; apply_status: string | null; apply_platform: string | null; apply_tier: string | null; ats_coverage: number | null }[];
  applications: { platform: string | null; method: string | null; status: string | null; reason: string | null; applied_at: string | null }[];
  outcomes: { outcome: string; note: string | null; created_at: string }[];
};

function TextList({ title, items }: { title: string; items: string[] }) {
  return items.length ? <><h4>{title}</h4><ul className="plain-list">{items.map((f, i) => <li key={i}>{f}</li>)}</ul></> : null;
}

function JobDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useDetail<JobFull>(`/api/jobs/${encodeURIComponent(id)}`);
  return <DetailDrawer title={data ? data.title : "Job"} subtitle={data?.company} onClose={onClose}>
    <DrawerState data={data} error={error}>{data ? <>
      <KV rows={[
        ["Source", data.source], ["Match score", data.score === null ? "Not scored" : `${data.score}${data.confidence ? ` (${data.confidence} confidence)` : ""}`],
        ["Status", data.excluded_reason ? <span key="s"><Badge tone="bad">Excluded</Badge> {data.excluded_reason}</span> : <StatusBadge key="s" status={data.status ?? "active"} />],
        ["Stages", data.bucket.map(humanize).join(", ")],
        ["Posting", data.url ? <ExternalLink key="u" href={data.url}>Open the posting</ExternalLink> : "No link"],
        ["Apply link", data.apply_url && data.apply_url !== data.url ? <ExternalLink key="a" href={data.apply_url}>Open the apply page</ExternalLink> : null],
        ["Posted", data.posted_at ? readableTime(data.posted_at) : null], ["Deadline", data.deadline ? readableTime(data.deadline) : null], ["Found", readableTime(data.created_at)],
      ]} />
      <TextList title="Flags" items={data.flags} />
      <TextList title="Strengths" items={data.strengths} />
      <TextList title="Gaps" items={data.gaps} />
      <h4>Outreach and apply</h4>
      {data.queue.length || data.applications.length ? <ul className="plain-list">
        {data.queue.map((q) => <li key={`q${q.id}`}>Queue #{q.id}: <StatusBadge status={q.status} /> email {dash(q.email_status)}, connect {dash(q.connect_status)}, apply {dash(q.apply_status)}{q.apply_platform ? `, apply class ${q.apply_platform}${q.apply_tier ? ` / ${q.apply_tier}` : ""}` : ""}{q.ats_coverage !== null ? `, ATS ${q.ats_coverage}%` : ""}</li>)}
        {data.applications.map((a, i) => <li key={`a${i}`}>Application via {dash(a.platform)} ({dash(a.method)}): <StatusBadge status={a.status} />{a.reason ? ` ${a.reason}` : ""}{a.applied_at ? ` · ${readableTime(a.applied_at)}` : ""}</li>)}
      </ul> : <p className="muted">Nothing queued or applied yet.</p>}
      {data.outcomes.length ? <><h4>Outcomes</h4><ul className="plain-list">{data.outcomes.map((o, i) => <li key={i}><StatusBadge status={o.outcome} /> {o.note ?? ""} · {readableTime(o.created_at)}</li>)}</ul></> : null}
    </> : null}</DrawerState>
  </DetailDrawer>;
}

export function JobsView() {
  const [q, setQ] = useState(""); const [source, setSource] = useState(""); const [state, setState] = useState(""); const [bucket, setBucket] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [sources, setSources] = useState<{ source: string; count: number }[]>([]);
  useEffect(() => { api<{ sources: { source: string; count: number }[] }>("/api/jobs/facets").then((f) => setSources(f.sources)).catch(() => undefined); }, []);
  const list = usePaged<JobRow>("/api/jobs", { q: q || undefined, source: source || undefined, state: state || undefined, bucket: bucket || undefined });
  const close = useCallback(() => setOpen(null), []);
  return <Panel title="Jobs" toolbar={<Toolbar onReload={list.reload} loading={list.loading}>
    <DebouncedSearch value={q} onChange={setQ} placeholder="Search title or company" label="Search jobs" />
    <FilterSelect label="Source" value={source} onChange={setSource} options={[{ value: "", label: "All sources" }, ...sources.map((s) => ({ value: s.source, label: `${s.source} (${s.count})` }))]} />
    <FilterSelect label="State" value={state} onChange={setState} options={[{ value: "", label: "Any state" }, { value: "active", label: "Not excluded" }, { value: "excluded", label: "Excluded" }]} />
    <FilterSelect label="Stage" value={bucket} onChange={setBucket} options={[{ value: "", label: "Any stage" }, { value: "matched", label: "Matched" }, { value: "applied", label: "Applied" }, { value: "pending", label: "Awaiting apply" }, { value: "failed", label: "Failed" }]} />
  </Toolbar>}>
    <ListFrame state={list} empty={{ title: "No jobs match", text: "Change the search or filters, or wait for the next discovery run." }}>
      {(items) => items.map((j) => <RecordRow key={j.id} onOpen={() => setOpen(j.id)} title={`${j.title} at ${j.company || "unknown company"}`}
        meta={`${j.source} · found ${readableTime(j.created_at)}${j.excluded_reason ? ` · ${j.excluded_reason}` : ""}`}
        aside={<>{j.score !== null ? <Badge tone={j.score >= 60 ? "good" : ""}>{j.score}</Badge> : <Badge>unscored</Badge>}{j.excluded_reason ? <Badge tone="bad">excluded</Badge> : <StatusBadge status={j.status} />}</>} />)}
    </ListFrame>
    {open ? <JobDetail id={open} onClose={close} /> : null}
  </Panel>;
}

// ---------------------------------------------------------------- People
type PersonRow = { id: number; platform: string; name: string | null; headline: string | null; company: string | null; category: string; stage: string | null; connection_status: string | null; touch_count: number; profile_url: string | null; last_touch_at: string | null; next_due_at: string | null; followups_sent: number | null; paused_reason: string | null };
type Thread = { person: PersonRow; touches: { items: { id: number; job_id: string | null; kind: string; status: string; body: string | null; created_at: string; sent_at: string | null }[] } };

function PersonDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, error } = useDetail<Thread>(`/api/people/${id}/thread?limit=50`);
  const p = data?.person;
  return <DetailDrawer title={p?.name || "Person"} subtitle={p ? [p.headline, p.company].filter(Boolean).join(" · ") : undefined} onClose={onClose}>
    <DrawerState data={data} error={error}>{p && data ? <>
      <KV rows={[
        ["Company", p.company], ["Role / headline", p.headline], ["Source", p.platform], ["Category", humanize(p.category)],
        ["Profile", p.profile_url ? <ExternalLink key="p" href={p.profile_url}>Open the profile</ExternalLink> : "No profile link"],
        ["Connection", p.connection_status ? <StatusBadge key="c" status={p.connection_status} /> : "No connection request"], ["Stage", p.stage ? humanize(p.stage) : null],
        ["Follow-ups sent", p.followups_sent], ["Last touch", p.last_touch_at ? readableTime(p.last_touch_at) : null], ["Next due", p.next_due_at ? readableTime(p.next_due_at) : null], ["Paused", p.paused_reason],
      ]} />
      <h4>Touches ({data.touches.items.length})</h4>
      {data.touches.items.length ? <ul className="plain-list">{data.touches.items.map((t) => <li key={t.id}><strong>{humanize(t.kind)}</strong> <StatusBadge status={t.status} /> · {readableTime(t.sent_at ?? t.created_at)}{t.job_id ? ` · job ${t.job_id}` : ""}{t.body ? <p className="quote">{t.body}</p> : null}</li>)}</ul> : <p className="muted">No messages sent to this person yet.</p>}
    </> : null}</DrawerState>
  </DetailDrawer>;
}

export function PeopleView() {
  const [q, setQ] = useState(""); const [stage, setStage] = useState(""); const [open, setOpen] = useState<number | null>(null);
  const [stages, setStages] = useState<string[]>([]);
  useEffect(() => { api<{ stages: string[] }>("/api/people/stages").then((s) => setStages(s.stages)).catch(() => undefined); }, []);
  const list = usePaged<PersonRow>("/api/people", { q: q || undefined, stage: stage || undefined });
  const close = useCallback(() => setOpen(null), []);
  return <Panel title="People" toolbar={<Toolbar onReload={list.reload} loading={list.loading}>
    <DebouncedSearch value={q} onChange={setQ} placeholder="Search name, company or role" label="Search people" />
    <FilterSelect label="Stage" value={stage} onChange={setStage} options={[{ value: "", label: "Any stage" }, ...stages.map((s) => ({ value: s, label: humanize(s) }))]} />
  </Toolbar>}>
    <ListFrame state={list} empty={{ title: "No people match", text: "Contacts appear after the contact finder runs for matched jobs." }}>
      {(items) => items.map((p) => <RecordRow key={p.id} onOpen={() => setOpen(p.id)} title={p.name || "Unnamed contact"}
        meta={[p.headline, p.company, p.platform].filter(Boolean).join(" · ")}
        aside={<>{p.category ? <Badge>{humanize(p.category)}</Badge> : null}{p.connection_status ? <StatusBadge status={p.connection_status} /> : p.stage ? <StatusBadge status={p.stage} /> : null}</>} />)}
    </ListFrame>
    {open !== null ? <PersonDetail id={open} onClose={close} /> : null}
  </Panel>;
}

// ---------------------------------------------------------------- Mail
type MailRow = { id: number; job_id: string; title: string | null; company: string | null; to: string | null; subject: string | null; sent_at: string | null; status: string | null; has_reply: boolean };
type MailFull = MailRow & { body: string | null; followups: { id: number; n: number; status: string; subject: string | null; sent_at: string | null }[]; replies: { message_id: string; classification: string | null; from_addr: string | null; subject: string | null; reply_date: string | null }[] };

function MailDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, error } = useDetail<MailFull>(`/api/emails/${id}`);
  return <DetailDrawer title={data?.subject || "Email"} subtitle={data ? `To ${dash(data.to)}` : undefined} onClose={onClose}>
    <DrawerState data={data} error={error}>{data ? <>
      <KV rows={[
        ["Job", [data.title, data.company].filter(Boolean).join(" at ") || data.job_id], ["To", data.to], ["Subject", data.subject], ["Status", <StatusBadge key="s" status={data.status} />],
        ["Sent", data.sent_at ? readableTime(data.sent_at) : "Not sent"], ["Reply", data.has_reply ? <Badge key="r" tone="good">reply on file</Badge> : "No reply on file"],
      ]} />
      <h4>Message</h4>
      {data.body ? <pre className="mail-body">{data.body}</pre> : <p className="muted">No body stored.</p>}
      {data.followups.length ? <><h4>Follow-ups</h4><ul className="plain-list">{data.followups.map((f) => <li key={f.id}>#{f.n} <StatusBadge status={f.status} /> {f.subject ?? ""}{f.sent_at ? ` · ${readableTime(f.sent_at)}` : ""}</li>)}</ul></> : null}
      {data.replies.length ? <><h4>Replies and bounces</h4><ul className="plain-list">{data.replies.map((r) => <li key={r.message_id}><StatusBadge status={r.classification} /> {r.from_addr ?? ""} · {r.subject ?? ""}{r.reply_date ? ` · ${readableTime(r.reply_date)}` : ""}</li>)}</ul></> : null}
    </> : null}</DrawerState>
  </DetailDrawer>;
}

export function MailView() {
  const [q, setQ] = useState(""); const [open, setOpen] = useState<number | null>(null);
  const list = usePaged<MailRow>("/api/emails", { q: q || undefined });
  const close = useCallback(() => setOpen(null), []);
  return <Panel title="Sent mail" toolbar={<Toolbar onReload={list.reload} loading={list.loading}>
    <DebouncedSearch value={q} onChange={setQ} placeholder="Search subject, address or company" label="Search mail" />
  </Toolbar>}>
    <ListFrame state={list} empty={{ title: "No sent mail", text: "Emails sent by the mail drip lane appear here." }}>
      {(items) => items.map((m) => <RecordRow key={m.id} onOpen={() => setOpen(m.id)} title={m.subject || "(no subject)"}
        meta={`To ${dash(m.to)} · ${[m.title, m.company].filter(Boolean).join(" at ") || m.job_id} · ${m.sent_at ? readableTime(m.sent_at) : "not sent"}`}
        aside={<><StatusBadge status={m.status} />{m.has_reply ? <Badge tone="good">replied</Badge> : null}</>} />)}
    </ListFrame>
    {open !== null ? <MailDetail id={open} onClose={close} /> : null}
  </Panel>;
}

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
