"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ReactNode, useEffect, useState } from "react";
import { api, readableTime } from "@/lib/dashboard-api";
import { formatDuration, PanelRef, safeExternalUrl, statusLabel, titleWord, triggerName } from "@/lib/view-models";
import { AppInfo, queueCards, QueueInfo, State } from "@/lib/outreach-view";
import {
  Badge, DebouncedSearch, DetailDrawer, DrawerState, FilterGroup, FilterSelect, KV, LinkRow, ListFrame, LoadingLines, Panel, RecordRow, StatusBadge, Toolbar, useDetail, usePaged,
} from "@/components/dashboard/list-kit";
import { PanelNav, usePanels } from "@/components/dashboard/panel-context";

function ExternalLink({ href, children }: { href: unknown; children: ReactNode }) {
  const safe = safeExternalUrl(href);
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
}
/** A stored value, or a plain sentence saying what is true when there is none. */
const orText = (v: unknown, whenEmpty: string) => (v === null || v === undefined || v === "" ? whenEmpty : String(v));
const when = (v: string | null | undefined) => (v ? readableTime(v) : null);

// ---------------------------------------------------------------- shared link types (see src/dash/queries/links.ts)
type JobBrief = { id: string; title: string; company: string; status: string | null; score: number | null; excluded_reason: string | null };
type PersonLink = { ref: string | null; name: string | null; role: string | null; channel: string; email: string | null; status: string | null; verified: boolean | null; note: string | null };
type MailLink = { ref: string | null; kind: "cold" | "followup" | "feedback" | "reply"; n: number | null; job_id: string; label: string; status: string | null; to: string | null; from: string | null; subject: string | null; sent_at: string | null; created_at: string | null; current?: boolean; duplicates?: number };
type OtherTouch = { kind: string; status: string; at: string | null; platform: string; person_ref: string | null; person_name: string | null };
type EscalationLink = { id: number; reason: string; platform: string | null; created_at: string | null; resolved: boolean; person_ref: string | null };
type TimelineItem = {
  at: string | null; type: string; direction: "out" | "in"; title: string; status: string | null; preview: string | null;
  job: { id: string; title: string; company: string } | null; open: { kind: PanelRef["kind"]; id: string } | null; inbox_id: number | null;
};

/** What the stored kind of an email contact means. */
const CONTACT_TYPES: Record<string, string> = { role: "Team address (for example careers@)", personal: "Personal address", generic: "General address", hr: "HR address", recruiter: "Recruiter address" };
const personTitle =(p: PersonLink) => p.name || p.email || "Unnamed contact";
const jobTitle = (j: { title: string; company: string }) => `${j.title || "Untitled job"}${j.company ? ` at ${j.company}` : ""}`;
/** Deep link to an inbox item. The Inbox page owns the `item` query parameter. */
const inboxHref = (id: number) => `/inbox?item=${id}`;

/** A company name as two real links: all jobs and all people of that company. */
function CompanyLinks({ company }: { company: string | null | undefined }) {
  if (!company) return null;
  const q = encodeURIComponent(company);
  return <span>{company} · <Link href={`/jobs?q=${q}`}>jobs here</Link> · <Link href={`/people?q=${q}`}>people here</Link></span>;
}

/** Reads one query parameter once (the first render), so a link like /jobs?bucket=matched opens the list already filtered. */
export function useUrlParam(name: string, allowed?: readonly string[]): string {
  const sp = useSearchParams();
  const v = sp.get(name) ?? "";
  return allowed && !allowed.includes(v) ? "" : v;
}

function LinksState<T>({ links, children }: { links: { data: T | null; error: string | null }; children: (d: T) => ReactNode }) {
  if (links.error) return <p className="muted">Related records could not be loaded: {links.error}</p>;
  if (!links.data) return <LoadingLines />;
  return <>{children(links.data)}</>;
}

/** Row that opens a job panel. Exported for the Inbox and any other page: <JobLinkRow job={{ id, title, company, status, score, excluded_reason }} /> (inside the shell's panel provider). */
export function JobLinkRow({ job }: { job: JobBrief }) {
  const { open } = usePanels();
  return <LinkRow onOpen={() => open({ kind: "job", id: job.id })} title={jobTitle(job)}
    meta={job.excluded_reason ?? undefined}
    aside={<>{job.score !== null ? <Badge tone={job.score >= 60 ? "good" : ""}>{job.score}</Badge> : null}{job.excluded_reason ? <Badge tone="bad">excluded</Badge> : <StatusBadge status={job.status} />}</>} />;
}

/** Row that opens a person (ref = people id) or an email contact (ref = "c" + contacts id). Exported for the Inbox. */
export function PersonLinkRow({ p }: { p: PersonLink }) {
  const { open } = usePanels();
  const meta = [p.channel === "email" && p.role ? (CONTACT_TYPES[p.role] ?? titleWord(p.role)) : p.role, titleWord(p.channel), p.email && p.name ? p.email : null, p.note].filter(Boolean).join(" · ");
  return <LinkRow onOpen={p.ref ? () => open({ kind: "person", id: p.ref as string }) : undefined} title={personTitle(p)} meta={meta}
    aside={<><StatusBadge status={p.status} />{p.verified === false ? <Badge tone="warn">unverified</Badge> : null}</>} />;
}

/** Row for one message of a mail thread: a cold email or follow-up opens the mail panel, an inbound reply opens the reply panel. */
export function MailLinkRow({ m, showJob, jobName }: { m: MailLink; showJob?: boolean; jobName?: string }) {
  const { open } = usePanels();
  const reply = m.kind === "reply";
  const time = reply ? (m.sent_at ? `received ${when(m.sent_at)}` : null)
    : m.sent_at ? `sent ${when(m.sent_at)}` : m.created_at ? `${m.kind === "cold" ? "queued" : "drafted"} ${when(m.created_at)}` : null;
  const dup = m.duplicates ? `+${m.duplicates} duplicate${m.duplicates === 1 ? "" : "s"} hidden (same email, same recipient)` : null;
  const meta = [m.from ? `From ${m.from}` : m.to ? `To ${m.to}` : null, time, m.ref === null ? (reply ? "the text of this message is not stored" : "not sent yet, so there is nothing to open") : null, dup, showJob ? (jobName ?? "another job") : null].filter(Boolean).join(" · ");
  return <LinkRow current={m.current} onOpen={m.ref ? () => open({ kind: reply ? "reply" : "mail", id: m.ref as string }) : undefined}
    title={<>{m.label}{m.subject ? `: ${m.subject}` : ""}</>} meta={meta}
    aside={<>{m.current ? <Badge>viewing</Badge> : null}<StatusBadge status={m.status} /></>} />;
}

/** A person's or contact's whole conversation, oldest first: every row says who sent it, when, its status and a text preview, and opens the right panel. */
function Conversation({ path }: { path: string }) {
  const { open } = usePanels();
  const { data, error } = useDetail<{ items: TimelineItem[] }>(path);
  if (error) return <p className="muted">The conversation could not be loaded: {error}</p>;
  if (!data) return <LoadingLines />;
  if (!data.items.length) return <p className="muted">Nothing has been sent to or received from this record yet.</p>;
  return <ol className="timeline">{data.items.map((t, i) => <li key={i}>
    <LinkRow onOpen={t.open ? () => open(t.open as PanelRef) : undefined} title={t.title}
      meta={[when(t.at), t.job ? jobTitle(t.job) : null].filter(Boolean).join(" · ")}
      aside={<><Badge>{t.direction === "in" ? "Received" : "Sent"}</Badge><StatusBadge status={t.status} /></>} />
    {t.preview ? <p className="quote">{t.preview}</p> : null}
    {t.job && t.open?.kind !== "job" ? <button type="button" className="text-link" onClick={() => open({ kind: "job", id: (t.job as { id: string }).id })}>open job</button> : null}
    {t.inbox_id !== null ? <Link href={inboxHref(t.inbox_id)}>open in inbox</Link> : null}
  </li>)}</ol>;
}

/** One labelled line of a queue card: the state in words, a tone colour and the time when there is one. */
function StateRow({ label, s, note }: { label: string; s: State; note?: string | null }) {
  return <div><dt>{label}</dt><dd><Badge tone={s.tone}>{s.text}</Badge>{s.at ? <span className="muted"> {readableTime(s.at)}</span> : null}{note ? <span className="muted block">{note}</span> : null}</dd></div>;
}

function TextList({ title, items }: { title: string; items: string[] }) {
  return items.length ? <><h4>{title}</h4><ul className="plain-list">{items.map((f, i) => <li key={i}>{f}</li>)}</ul></> : null;
}

// ---------------------------------------------------------------- Job panel
type JobRow = { id: string; title: string; company: string; source: string; score: number | null; status: string | null; excluded_reason: string | null; created_at: string; bucket: string[] };
type JobFull = JobRow & {
  url: string | null; apply_url: string | null; posted_at: string | null; deadline: string | null; confidence: string | null; flags: string[]; strengths: string[]; gaps: string[];
  queue: QueueInfo[];
  applications: AppInfo[];
  outcomes: { outcome: string; note: string | null; created_at: string }[];
};

function JobDetail({ id, nav }: { id: string; nav: PanelNav }) {
  const { open } = usePanels();
  const { data, error } = useDetail<JobFull>(`/api/jobs/${encodeURIComponent(id)}`);
  const links = useDetail<{ people: PersonLink[]; mails: MailLink[]; other: OtherTouch[]; escalations: EscalationLink[] }>(`/api/jobs/${encodeURIComponent(id)}/links`);
  return <DetailDrawer title={data ? data.title : "Job"} subtitle={data?.company} onClose={nav.onClose} crumbs={nav.crumbs} onBack={nav.onBack}>
    <DrawerState data={data} error={error}>{data ? <>
      <KV rows={[
        ["Company", data.company ? <CompanyLinks key="co" company={data.company} /> : null],
        ["Source", data.source], ["Match score", data.score === null ? "Not scored" : `${data.score}${data.confidence ? ` (${data.confidence} confidence)` : ""}`],
        ["Status", data.excluded_reason ? <span key="s"><Badge tone="bad">Excluded</Badge> {data.excluded_reason}</span> : <StatusBadge key="s" status={data.status ?? "active"} />],
        ["Stages", data.bucket.map(statusLabel).join(", ")],
        ["Posting", data.url ? <ExternalLink key="u" href={data.url}>Open the posting</ExternalLink> : "No link"],
        ["Apply link", data.apply_url && data.apply_url !== data.url ? <ExternalLink key="a" href={data.apply_url}>Open the apply page</ExternalLink> : null],
        ["Posted", data.posted_at ? readableTime(data.posted_at) : null], ["Deadline", data.deadline ? readableTime(data.deadline) : null], ["Found", readableTime(data.created_at)],
      ]} />
      <TextList title="Flags" items={data.flags} />
      <TextList title="Strengths" items={data.strengths} />
      <TextList title="Gaps" items={data.gaps} />
      <h4>Outreach and apply</h4>
      {data.queue.length || data.applications.length ? <>
        {queueCards(data.queue, data.applications).map((c) => <section className="queue-card" key={`q${c.id}`} aria-label={c.title}>
          <h5>{c.title}</h5>
          <dl className="state-grid">
            <StateRow label="Email" s={c.email} note={c.emailNote} />
            <StateRow label="LinkedIn connect" s={c.connect} />
            <StateRow label="Apply" s={c.apply} />
            {c.via ? <div><dt>Apply via</dt><dd>{c.via}</dd></div> : null}
            <div><dt>Resume fit (ATS)</dt><dd><b>{c.fit.value}</b><span className="muted"> {c.fit.meaning}</span></dd></div>
          </dl>
        </section>)}
        {data.applications.length ? <>
          <p className="related-label">Applications on record</p>
          <ul className="plain-list">{data.applications.map((a, i) => <li key={`a${i}`}>{titleWord(a.platform || "unknown site")}{a.method ? `, ${titleWord(a.method)}` : ""}: <StatusBadge status={a.status} />{a.reason ? ` ${a.reason}` : ""}{a.applied_at ? ` · ${readableTime(a.applied_at)}` : ""}</li>)}</ul>
        </> : null}
      </> : <p className="muted">Nothing is queued for this job and no application was made.</p>}
      {data.outcomes.length ? <><h4>Outcomes</h4><ul className="plain-list">{data.outcomes.map((o, i) => <li key={i}><StatusBadge status={o.outcome} /> {o.note ?? ""} · {readableTime(o.created_at)}</li>)}</ul>
        <p className="muted"><Link href="/outcomes">All outcomes and the funnel</Link></p></> : null}
      <LinksState links={links}>{(l) => <>
        <h4>People ({l.people.length})</h4>
        {l.people.length ? <div>{l.people.map((p, i) => <PersonLinkRow key={`${p.ref ?? "x"}${i}`} p={p} />)}</div> : <p className="muted">No one is tied to this job yet. Contacts appear after the contact finder runs.</p>}
        <h4>Email thread ({l.mails.length})</h4>
        <p className="muted">The cold email, each follow-up and every reply that was matched to this job, oldest first.</p>
        {l.mails.length ? <div>{l.mails.map((m, i) => <MailLinkRow key={`${m.ref ?? "x"}${i}`} m={m} />)}</div> : <p className="muted">No email has been queued or sent for this job.</p>}
        <h4>Inbox items ({l.escalations.length})</h4>
        {l.escalations.length ? <ul className="plain-list">{l.escalations.map((e) => <li key={e.id}>
          <Link href={inboxHref(e.id)}>Inbox item #{e.id}</Link> <Badge tone={e.resolved ? "" : "warn"}>{e.resolved ? "resolved" : "open"}</Badge>
          <p className="muted">{[statusLabel(e.reason), titleWord(e.platform), when(e.created_at)].filter(Boolean).join(" · ")}</p></li>)}</ul>
          : <p className="muted">Nothing from the people of this job needed you.</p>}
        <h4>Other outreach ({l.other.length})</h4>
        {l.other.length ? <div>{l.other.map((o, i) => <LinkRow key={i} onOpen={o.person_ref ? () => open({ kind: "person", id: o.person_ref as string }) : undefined}
          title={`${statusLabel(o.kind)}${o.person_name ? ` to ${o.person_name}` : ""}`} meta={[titleWord(o.platform), when(o.at)].filter(Boolean).join(" · ")} aside={<StatusBadge status={o.status} />} />)}</div>
          : <p className="muted">No LinkedIn or Naukri messages for this job.</p>}
      </>}</LinksState>
    </> : null}</DrawerState>
  </DetailDrawer>;
}

export function JobsView() {
  const { open } = usePanels();
  // Links from Home and the panels pre-set these: /jobs?bucket=matched, ?scored=1, ?contacted=1, ?state=excluded, ?source=, ?q=
  const urlQ = useUrlParam("q"); const urlSource = useUrlParam("source"); const urlState = useUrlParam("state", ["active", "excluded"]);
  const urlBucket = useUrlParam("bucket", ["matched", "applied", "pending", "failed"]); const urlScored = useUrlParam("scored") === "1"; const urlContacted = useUrlParam("contacted") === "1";
  const [q, setQ] = useState(urlQ); const [source, setSource] = useState(urlSource); const [state, setState] = useState(urlState); const [bucket, setBucket] = useState(urlBucket);
  const [scored, setScored] = useState(urlScored); const [contacted, setContacted] = useState(urlContacted);
  const [sources, setSources] = useState<{ source: string; count: number }[]>([]);
  useEffect(() => { api<{ sources: { source: string; count: number }[] }>("/api/jobs/facets").then((f) => setSources(f.sources)).catch(() => undefined); }, []);
  const list = usePaged<JobRow>("/api/jobs", { q: q || undefined, source: source || undefined, state: state || undefined, bucket: bucket || undefined, scored: scored ? "1" : undefined, contacted: contacted ? "1" : undefined });
  return <Panel title="Jobs" toolbar={<Toolbar onReload={list.reload} loading={list.loading}>
    {scored || contacted ? <button type="button" className="button" onClick={() => { setScored(false); setContacted(false); }} title="Remove this filter">{scored ? "Only scored jobs" : "Only contacted jobs"} ×</button> : null}
    <DebouncedSearch value={q} onChange={setQ} placeholder="Search title or company" label="Search jobs" />
    <FilterGroup activeCount={[source, state, bucket, scored, contacted].filter(Boolean).length}>
    <FilterSelect label="Source" value={source} onChange={setSource} options={[{ value: "", label: "All sources" }, ...sources.map((s) => ({ value: s.source, label: `${s.source} (${s.count})` }))]} />
    <FilterSelect label="State" value={state} onChange={setState} options={[{ value: "", label: "Any state" }, { value: "active", label: "Not excluded" }, { value: "excluded", label: "Excluded" }]} />
    <FilterSelect label="Stage" value={bucket} onChange={setBucket} options={[{ value: "", label: "Any stage" }, { value: "matched", label: "Matched" }, { value: "applied", label: "Applied" }, { value: "pending", label: "Awaiting apply" }, { value: "failed", label: "Failed" }]} />
    </FilterGroup>
  </Toolbar>}>
    <ListFrame state={list} empty={{ title: "No jobs match", text: "Change the search or filters, or wait for the next discovery run." }}>
      {(items) => items.map((j) => <RecordRow key={j.id} onOpen={() => open({ kind: "job", id: j.id })} title={`${j.title} at ${j.company || "unknown company"}`}
        meta={`${j.source} · found ${readableTime(j.created_at)}${j.excluded_reason ? ` · ${j.excluded_reason}` : ""}`}
        aside={<>{j.score !== null ? <Badge tone={j.score >= 60 ? "good" : ""}>{j.score}</Badge> : <Badge>unscored</Badge>}{j.excluded_reason ? <Badge tone="bad">excluded</Badge> : <StatusBadge status={j.status} />}</>} />)}
    </ListFrame>
  </Panel>;
}

// ---------------------------------------------------------------- Person and contact panel
type PersonRow = { id: number; platform: string; name: string | null; headline: string | null; company: string | null; category: string; stage: string | null; connection_status: string | null; touch_count: number; job_count: number; last_job_id: string | null; last_job_title: string | null; profile_url: string | null; last_touch_at: string | null; next_due_at: string | null; followups_sent: number | null; paused_reason: string | null };
type Thread = { person: PersonRow };
type ContactFull = { id: number; company: string | null; email: string | null; type: string | null; verified: boolean | null; source: string | null; created_at: string | null };
type PersonLinksData = { jobs: (JobBrief & { via: string[] })[]; mails: MailLink[] };

/** The jobs a person or contact is linked to. The messages are in the Conversation list below it. */
function RelatedRecords({ links }: { links: { data: PersonLinksData | null; error: string | null } }) {
  return <LinksState links={links}>{(l) => <>
    <h4>Jobs ({l.jobs.length})</h4>
    {l.jobs.length ? <div>{l.jobs.map((j) => <LinkRowJob key={j.id} j={j} />)}</div> : <p className="muted">No job is linked to this record yet.</p>}
  </>}</LinksState>;
}
function LinkRowJob({ j }: { j: JobBrief & { via: string[] } }) {
  const { open } = usePanels();
  return <LinkRow onOpen={() => open({ kind: "job", id: j.id })} title={jobTitle(j)} meta={j.via.join(", ")}
    aside={<>{j.score !== null ? <Badge tone={j.score >= 60 ? "good" : ""}>{j.score}</Badge> : null}{j.excluded_reason ? <Badge tone="bad">excluded</Badge> : <StatusBadge status={j.status} />}</>} />;
}

function PersonDetail({ id, nav }: { id: number; nav: PanelNav }) {
  const { data, error } = useDetail<Thread>(`/api/people/${id}/thread?limit=1`);
  const links = useDetail<PersonLinksData>(`/api/people/${id}/links`);
  const p = data?.person;
  return <DetailDrawer title={p?.name || "Person"} subtitle={p ? [p.headline, p.company].filter(Boolean).join(" · ") : undefined} onClose={nav.onClose} crumbs={nav.crumbs} onBack={nav.onBack}>
    <DrawerState data={data} error={error}>{p && data ? <>
      <KV rows={[
        ["Company", p.company ? <CompanyLinks key="co" company={p.company} /> : null], ["Role / headline", p.headline], ["Source", titleWord(p.platform)], ["Category", titleWord(p.category)],
        ["Profile", p.profile_url ? <ExternalLink key="p" href={p.profile_url}>Open the profile</ExternalLink> : "No profile link"],
        ["Connection", p.connection_status ? <StatusBadge key="c" status={p.connection_status} /> : "No connection request"], ["Stage", p.stage ? statusLabel(p.stage) : null],
        ["Follow-ups sent", p.followups_sent], ["Last touch", p.last_touch_at ? readableTime(p.last_touch_at) : null], ["Next due", p.next_due_at ? readableTime(p.next_due_at) : null], ["Paused", p.paused_reason],
      ]} />
      <RelatedRecords links={links} />
      <h4>Conversation</h4>
      <p className="muted">Connection requests, messages, inbox items and the emails and replies of the linked jobs, oldest first (newest 50).</p>
      <Conversation path={`/api/people/${id}/timeline`} />
    </> : null}</DrawerState>
  </DetailDrawer>;
}

function ContactDetail({ id, nav }: { id: number; nav: PanelNav }) {
  const { data, error } = useDetail<ContactFull>(`/api/contacts/${id}`);
  const links = useDetail<PersonLinksData>(`/api/people/c${id}/links`);
  return <DetailDrawer title={data?.email || "Email contact"} subtitle={data?.company ?? undefined} onClose={nav.onClose} crumbs={nav.crumbs} onBack={nav.onBack}>
    <DrawerState data={data} error={error}>{data ? <>
      <KV rows={[
        ["Email", data.email], ["Company", data.company ? <CompanyLinks key="co" company={data.company} /> : null], ["Type", data.type ? titleWord(data.type) : null],
        ["Verified", data.verified === null ? "Not checked" : data.verified ? <Badge key="v" tone="good">verified</Badge> : <Badge key="v" tone="warn">unverified</Badge>],
        ["Found by", data.source], ["Added", when(data.created_at)],
      ]} />
      <RelatedRecords links={links} />
      <h4>Conversation</h4>
      <p className="muted">Emails sent to this address, their follow-ups and the replies matched to those jobs, oldest first (newest 50).</p>
      <Conversation path={`/api/people/c${id}/timeline`} />
    </> : null}</DrawerState>
  </DetailDrawer>;
}

export function PeopleView() {
  const { open } = usePanels();
  const [q, setQ] = useState(""); const [stage, setStage] = useState("");
  const [stages, setStages] = useState<string[]>([]);
  useEffect(() => { api<{ stages: string[] }>("/api/people/stages").then((s) => setStages(s.stages)).catch(() => undefined); }, []);
  const list = usePaged<PersonRow>("/api/people", { q: q || undefined, stage: stage || undefined });
  return <Panel title="People" toolbar={<Toolbar onReload={list.reload} loading={list.loading}>
    <DebouncedSearch value={q} onChange={setQ} placeholder="Search name, company or role" label="Search people" />
    <FilterGroup activeCount={stage ? 1 : 0}><FilterSelect label="Stage" value={stage} onChange={setStage} options={[{ value: "", label: "Any stage" }, ...stages.map((s) => ({ value: s, label: statusLabel(s) }))]} /></FilterGroup>
  </Toolbar>}>
    <ListFrame state={list} empty={{ title: "No people match", text: "Contacts appear after the contact finder runs for matched jobs." }}>
      {(items) => items.map((p) => <RecordRow key={p.id} onOpen={() => open({ kind: "person", id: String(p.id) })} title={p.name || "Unnamed contact"}
        meta={[p.headline, p.company, p.platform, `${p.touch_count} ${p.touch_count === 1 ? "message" : "messages"}`, p.job_count ? `${p.job_count} ${p.job_count === 1 ? "job" : "jobs"}` : null, p.last_job_title ? `latest: ${p.last_job_title}` : null].filter(Boolean).join(" · ")}
        aside={<>{p.category ? <Badge>{titleWord(p.category)}</Badge> : null}{p.connection_status ? <StatusBadge status={p.connection_status} /> : p.stage ? <StatusBadge status={p.stage} /> : null}</>} />)}
    </ListFrame>
  </Panel>;
}

// ---------------------------------------------------------------- Mail panel (cold email 12, follow-up f3)
type MailRow = { id: number; job_id: string; title: string | null; company: string | null; to: string | null; subject: string | null; sent_at: string | null; status: string | null; has_reply: boolean; followups_sent: number };
type MailFull = MailRow & { body: string | null; replies: { message_id: string; classification: string | null; from_addr: string | null; subject: string | null; reply_date: string | null }[] };
type FollowupFull = { id: number; job_id: string; n: number; label: string; status: string; subject: string | null; body: string | null; to: string | null; created_at: string | null; sent_at: string | null; decided_at: string | null; title: string | null; company: string | null; has_reply: boolean };
type MailLinksData = { job: JobBrief | null; job_id: string | null; contact: PersonLink | null; timeline: MailLink[]; parent: MailLink | null };

function RelatedBlock({ links }: { links: { data: MailLinksData | null; error: string | null } }) {
  return <section className="related" aria-label="Related">
    <h4>Related</h4>
    <LinksState links={links}>{(l) => <>
      <p className="related-label">Replies to</p>
      {l.parent ? <MailLinkRow m={l.parent} /> : <p className="muted">Nothing. This is the first message of the thread.</p>}
      <p className="related-label">Job</p>
      {l.job ? <JobLinkRow job={l.job} /> : <p className="muted">{l.job_id ? `The job for this email (${l.job_id}) is no longer in the database.` : "This email has no job on record."}</p>}
      <p className="related-label">Contact</p>
      {l.contact ? <PersonLinkRow p={l.contact} /> : <p className="muted">No recipient address on record.</p>}
      {l.timeline.length > 1 ? <>
        <p className="related-label">Whole thread ({l.timeline.length}), oldest first</p>
        <ol className="timeline">{l.timeline.map((m, i) => <li key={`${m.ref ?? "x"}${i}`}><MailLinkRow m={m} /></li>)}</ol>
      </> : null}
    </>}</LinksState>
  </section>;
}

/** One inbound mail (a reply, bounce or automatic answer). The reply text is not stored; only who wrote, when and how it was classified. */
type ReplyFull = {
  message_id: string; job_id: string | null; classification: string | null; label: string; action: string | null; proposed_outcome: string | null;
  from_addr: string | null; subject: string | null; received_at: string | null; job: JobBrief | null; parent: MailLink | null; timeline: MailLink[];
};
function ReplyDetail({ id, nav }: { id: string; nav: PanelNav }) {
  const { data, error } = useDetail<ReplyFull>(`/api/replies/${encodeURIComponent(id)}`);
  return <DetailDrawer title={data?.subject || data?.label || "Reply"} subtitle={data ? `${data.label} from ${orText(data.from_addr, "an unknown sender")}` : undefined} onClose={nav.onClose} crumbs={nav.crumbs} onBack={nav.onBack}>
    <DrawerState data={data} error={error}>{data ? <>
      <section className="related" aria-label="Related">
        <h4>Related</h4>
        <p className="related-label">Replies to</p>
        {data.parent ? <MailLinkRow m={data.parent} /> : <p className="muted">No sent mail of this job is on record.</p>}
        <p className="related-label">Job</p>
        {data.job ? <JobLinkRow job={data.job} /> : <p className="muted">{data.job_id ? `The job (${data.job_id}) is no longer in the database.` : "This message was not matched to a job."}</p>}
        {data.timeline.length > 1 ? <>
          <p className="related-label">Whole thread ({data.timeline.length}), oldest first</p>
          <ol className="timeline">{data.timeline.map((m, i) => <li key={`${m.ref ?? "x"}${i}`}><MailLinkRow m={m} /></li>)}</ol>
        </> : null}
      </section>
      <KV rows={[
        ["Kind", <StatusBadge key="k" status={data.classification} />], ["From", data.from_addr], ["Subject", data.subject], ["Received", when(data.received_at)],
        ["Handled as", data.action ? statusLabel(data.action) : null], ["Proposed outcome", data.proposed_outcome ? statusLabel(data.proposed_outcome) : null],
      ]} />
      <p className="muted">The text of the reply is not stored in the dashboard database. Open it in Gmail.</p>
    </> : null}</DrawerState>
  </DetailDrawer>;
}

function ColdMailDetail({ id, nav }: { id: number; nav: PanelNav }) {
  const { data, error } = useDetail<MailFull>(`/api/emails/${id}`);
  const links = useDetail<MailLinksData>(`/api/emails/${id}/links`);
  return <DetailDrawer title={data?.subject || "Email"} subtitle={data ? `To ${orText(data.to, "an unknown address")}` : undefined} onClose={nav.onClose} crumbs={nav.crumbs} onBack={nav.onBack}>
    <DrawerState data={data} error={error}>{data ? <>
      <RelatedBlock links={links} />
      <KV rows={[
        ["To", data.to], ["Subject", data.subject], ["Status", <StatusBadge key="s" status={data.status} />],
        ["Sent", data.sent_at ? readableTime(data.sent_at) : "Not sent"], ["Reply", data.has_reply ? <Badge key="r" tone="good">reply on file</Badge> : "No reply on file"],
      ]} />
      <h4>Message</h4>
      {data.body ? <pre className="mail-body">{data.body}</pre> : <p className="muted">No body stored.</p>}
    </> : null}</DrawerState>
  </DetailDrawer>;
}

function FollowupMailDetail({ id, nav }: { id: number; nav: PanelNav }) {
  const { data, error } = useDetail<FollowupFull>(`/api/followups/${id}`);
  const links = useDetail<MailLinksData>(`/api/followups/${id}/links`);
  return <DetailDrawer title={data?.subject || data?.label || "Follow-up"} subtitle={data ? `${data.label} · To ${orText(data.to, "an unknown address")}` : undefined} onClose={nav.onClose} crumbs={nav.crumbs} onBack={nav.onBack}>
    <DrawerState data={data} error={error}>{data ? <>
      <RelatedBlock links={links} />
      <KV rows={[
        ["Stage", data.label], ["To", data.to], ["Subject", data.subject], ["Status", <StatusBadge key="s" status={data.status} />],
        ["Drafted", when(data.created_at)], ["Decided", when(data.decided_at)], ["Sent", data.sent_at ? readableTime(data.sent_at) : "Not sent"],
        ["Reply", data.has_reply ? <Badge key="r" tone="good">reply on file for this job</Badge> : "No reply on file"],
      ]} />
      <h4>Message</h4>
      {data.body ? <pre className="mail-body">{data.body}</pre> : <p className="muted">No body stored.</p>}
    </> : null}</DrawerState>
  </DetailDrawer>;
}

export function MailView() {
  const { open } = usePanels();
  const [q, setQ] = useState("");
  const list = usePaged<MailRow>("/api/emails", { q: q || undefined });
  return <Panel title="Sent mail" toolbar={<Toolbar onReload={list.reload} loading={list.loading}>
    <DebouncedSearch value={q} onChange={setQ} placeholder="Search subject, address or company" label="Search mail" />
  </Toolbar>}>
    <ListFrame state={list} empty={{ title: "No sent mail", text: "Emails sent by the mail drip lane appear here." }}>
      {(items) => items.map((m) => <RecordRow key={m.id} onOpen={() => open({ kind: "mail", id: String(m.id) })} title={m.subject || "(no subject)"}
        meta={`To ${orText(m.to, "an unknown address")} · ${[m.title, m.company].filter(Boolean).join(" at ") || "job no longer in the database"} · ${m.sent_at ? readableTime(m.sent_at) : "not sent"}${m.followups_sent ? ` · ${m.followups_sent} ${m.followups_sent === 1 ? "follow-up" : "follow-ups"} sent` : ""}`}
        aside={<><StatusBadge status={m.status} />{m.has_reply ? <Badge tone="good">replied</Badge> : null}</>} />)}
    </ListFrame>
  </Panel>;
}

// ---------------------------------------------------------------- Run panel (what was created while a run was going)
type RunFull = {
  run: { id: string; trigger: string; status: string; started_at: string | null; ended_at: string | null; wall_sec: number | null; dry_run: boolean; stop_reason: string | null; tool_calls: number; operators: string[] };
  window: { from: string; to: string; open: boolean }; overlapping_runs: number;
  jobs: { total: number; by_source: { source: string; count: number }[]; items: { id: string; title: string; company: string; source: string; score: number | null; created_at: string }[] };
  touches: { total: number; items: { id: number; kind: string; status: string; at: string | null; platform: string | null; job_id: string | null; person_ref: string | null; person_name: string | null }[] };
  emails: { total: number; items: { queue_id: number; job_id: string; title: string | null; company: string | null; sent_at: string | null }[] };
  escalations: { total: number; items: { id: number; reason: string; platform: string | null; created_at: string | null; resolved: boolean }[] };
};
const MATCHED_BY_TIME = "Created during this run (matched by time)";

function RunDetail({ id, nav }: { id: string; nav: PanelNav }) {
  const { open } = usePanels();
  const { data, error } = useDetail<RunFull>(`/api/runs/${encodeURIComponent(id)}`);
  const more = (shown: number, total: number) => (total > shown ? <p className="muted">Showing {shown} of {total}.</p> : null);
  return <DetailDrawer title={data ? triggerName(data.run.trigger) : "Run"} subtitle={data ? readableTime(data.run.started_at) : undefined} onClose={nav.onClose} crumbs={nav.crumbs} onBack={nav.onBack}>
    <DrawerState data={data} error={error}>{data ? <>
      <KV rows={[
        ["Result", <StatusBadge key="s" status={data.run.status} />], ["Mode", data.run.dry_run ? "Dry run, nothing real was sent" : "Live"],
        ["Started", when(data.run.started_at)], ["Finished", data.run.ended_at ? readableTime(data.run.ended_at) : "Still running"],
        ["Took", formatDuration(data.run.wall_sec)], ["Tool calls", data.run.tool_calls], ["Stopped because", data.run.stop_reason ? statusLabel(data.run.stop_reason) : null],
        ["Work planned", data.run.operators.length ? data.run.operators.join(" | ") : null],
      ]} />
      <h4>{MATCHED_BY_TIME}</h4>
      <p className="muted">The database does not record which run created a job or a message. These lists are everything that appeared between the start and the end of this run, so work done by a run that overlapped it can show up here too{data.overlapping_runs ? ` (${data.overlapping_runs} other ${data.overlapping_runs === 1 ? "run overlapped" : "runs overlapped"} this one)` : ""}.</p>
      <h4>Jobs found ({data.jobs.total})</h4>
      {data.jobs.by_source.length ? <div className="chip-row">{data.jobs.by_source.map((s) => <span className="chip" key={s.source}>{s.source} <b>{s.count}</b></span>)}</div> : null}
      {data.jobs.items.length ? <div>{data.jobs.items.map((j) => <LinkRow key={j.id} onOpen={() => open({ kind: "job", id: j.id })} title={jobTitle(j)} meta={`${j.source} · ${readableTime(j.created_at)}`}
        aside={j.score !== null ? <Badge tone={j.score >= 60 ? "good" : ""}>{j.score}</Badge> : <Badge>unscored</Badge>} />)}</div> : <p className="muted">No new job was saved during this run.</p>}
      {more(data.jobs.items.length, data.jobs.total)}
      <h4>LinkedIn and Naukri messages sent ({data.touches.total})</h4>
      {data.touches.items.length ? <div>{data.touches.items.map((t) => <LinkRow key={t.id} onOpen={t.person_ref ? () => open({ kind: "person", id: t.person_ref as string }) : undefined}
        title={`${statusLabel(t.kind)}${t.person_name ? ` to ${t.person_name}` : ""}`} meta={[titleWord(t.platform), when(t.at)].filter(Boolean).join(" · ")} aside={<StatusBadge status={t.status} />} />)}</div> : <p className="muted">No LinkedIn or Naukri message was sent in this time window.</p>}
      {more(data.touches.items.length, data.touches.total)}
      <h4>Emails sent ({data.emails.total})</h4>
      {data.emails.items.length ? <div>{data.emails.items.map((e) => <LinkRow key={e.queue_id} onOpen={() => open({ kind: "mail", id: String(e.queue_id) })}
        title={[e.title, e.company].filter(Boolean).join(" at ") || "Job no longer in the database"} meta={`Cold email · ${when(e.sent_at) ?? "time unknown"}`} />)}</div> : <p className="muted">No cold email was sent in this time window.</p>}
      {more(data.emails.items.length, data.emails.total)}
      <h4>Inbox items from this run ({data.escalations.total})</h4>
      <p className="muted">This one is exact: the inbox item stores the id of the run that created it.</p>
      {data.escalations.items.length ? <ul className="plain-list">{data.escalations.items.map((e) => <li key={e.id}>
        <Link href={inboxHref(e.id)}>Inbox item #{e.id}</Link> <Badge tone={e.resolved ? "" : "warn"}>{e.resolved ? "handled" : "open"}</Badge>
        <p className="muted">{[statusLabel(e.reason), titleWord(e.platform), when(e.created_at)].filter(Boolean).join(" · ")}</p></li>)}</ul> : <p className="muted">This run did not create any inbox item.</p>}
      {more(data.escalations.items.length, data.escalations.total)}
    </> : null}</DrawerState>
  </DetailDrawer>;
}

/** The side panel for any record kind; mounted once by the shell so it works from every page. */
export function renderPanel(ref: PanelRef, nav: PanelNav): ReactNode {
  if (ref.kind === "run") return <RunDetail id={ref.id} nav={nav} />;
  if (ref.kind === "job") return <JobDetail id={ref.id} nav={nav} />;
  if (ref.kind === "reply") return <ReplyDetail id={ref.id} nav={nav} />;
  if (ref.kind === "mail") return ref.id.startsWith("f") ? <FollowupMailDetail id={Number(ref.id.slice(1))} nav={nav} /> : <ColdMailDetail id={Number(ref.id)} nav={nav} />;
  return ref.id.startsWith("c") ? <ContactDetail id={Number(ref.id.slice(1))} nav={nav} /> : <PersonDetail id={Number(ref.id)} nav={nav} />;
}
