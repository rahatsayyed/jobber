"use client";

import { ReactNode, useEffect, useState } from "react";
import { api, readableTime } from "@/lib/dashboard-api";
import { humanize, PanelRef, safeExternalUrl } from "@/lib/view-models";
import {
  Badge, DebouncedSearch, DetailDrawer, DrawerState, FilterSelect, KV, LinkRow, ListFrame, LoadingLines, Panel, RecordRow, StatusBadge, Toolbar, useDetail, usePaged,
} from "@/components/dashboard/list-kit";
import { PanelNav, usePanels } from "@/components/dashboard/panel-context";

function ExternalLink({ href, children }: { href: unknown; children: ReactNode }) {
  const safe = safeExternalUrl(href);
  return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
}
const dash = (v: unknown) => (v === null || v === undefined || v === "" ? "Not recorded" : String(v));
const when = (v: string | null | undefined) => (v ? readableTime(v) : null);

// ---------------------------------------------------------------- shared link types (see src/dash/queries/links.ts)
type JobBrief = { id: string; title: string; company: string; status: string | null; score: number | null; excluded_reason: string | null };
type PersonLink = { ref: string | null; name: string | null; role: string | null; channel: string; email: string | null; status: string | null; verified: boolean | null; note: string | null };
type MailLink = { ref: string | null; kind: "cold" | "followup" | "feedback"; n: number | null; job_id: string; label: string; status: string | null; to: string | null; subject: string | null; sent_at: string | null; created_at: string | null; current?: boolean };
type OtherTouch = { kind: string; status: string; at: string | null; platform: string; person_ref: string | null; person_name: string | null };

const personTitle = (p: PersonLink) => p.name || p.email || "Unnamed contact";
const jobTitle = (j: JobBrief) => `${j.title || "Untitled job"}${j.company ? ` at ${j.company}` : ""}`;

function LinksState<T>({ links, children }: { links: { data: T | null; error: string | null }; children: (d: T) => ReactNode }) {
  if (links.error) return <p className="muted">Related records could not be loaded: {links.error}</p>;
  if (!links.data) return <LoadingLines />;
  return <>{children(links.data)}</>;
}

function JobLinkRow({ job }: { job: JobBrief }) {
  const { open } = usePanels();
  return <LinkRow onOpen={() => open({ kind: "job", id: job.id })} title={jobTitle(job)}
    meta={job.excluded_reason ?? undefined}
    aside={<>{job.score !== null ? <Badge tone={job.score >= 60 ? "good" : ""}>{job.score}</Badge> : null}{job.excluded_reason ? <Badge tone="bad">excluded</Badge> : <StatusBadge status={job.status} />}</>} />;
}

function PersonLinkRow({ p }: { p: PersonLink }) {
  const { open } = usePanels();
  const meta = [p.role, humanize(p.channel), p.email && p.name ? p.email : null, p.note].filter(Boolean).join(" · ");
  return <LinkRow onOpen={p.ref ? () => open({ kind: "person", id: p.ref as string }) : undefined} title={personTitle(p)} meta={meta}
    aside={<><StatusBadge status={p.status} />{p.verified === false ? <Badge tone="warn">unverified</Badge> : null}</>} />;
}

function MailLinkRow({ m, showJob }: { m: MailLink; showJob?: boolean }) {
  const { open } = usePanels();
  const time = m.sent_at ? `sent ${when(m.sent_at)}` : m.created_at ? `${m.kind === "cold" ? "queued" : "drafted"} ${when(m.created_at)}` : null;
  const meta = [m.to ? `To ${m.to}` : null, time, m.ref === null ? "not sent yet, nothing to open" : null, showJob ? `job ${m.job_id}` : null].filter(Boolean).join(" · ");
  return <LinkRow current={m.current} onOpen={m.ref ? () => open({ kind: "mail", id: m.ref as string }) : undefined}
    title={<>{m.label}{m.subject ? `: ${m.subject}` : ""}</>} meta={meta}
    aside={<>{m.current ? <Badge>viewing</Badge> : null}<StatusBadge status={m.status} /></>} />;
}

function TextList({ title, items }: { title: string; items: string[] }) {
  return items.length ? <><h4>{title}</h4><ul className="plain-list">{items.map((f, i) => <li key={i}>{f}</li>)}</ul></> : null;
}

// ---------------------------------------------------------------- Job panel
type JobRow = { id: string; title: string; company: string; source: string; score: number | null; status: string | null; excluded_reason: string | null; created_at: string; bucket: string[] };
type JobFull = JobRow & {
  url: string | null; apply_url: string | null; posted_at: string | null; deadline: string | null; confidence: string | null; flags: string[]; strengths: string[]; gaps: string[];
  queue: { id: number; status: string; email_status: string | null; connect_status: string | null; apply_status: string | null; apply_platform: string | null; apply_tier: string | null; ats_coverage: number | null }[];
  applications: { platform: string | null; method: string | null; status: string | null; reason: string | null; applied_at: string | null }[];
  outcomes: { outcome: string; note: string | null; created_at: string }[];
};

function JobDetail({ id, nav }: { id: string; nav: PanelNav }) {
  const { open } = usePanels();
  const { data, error } = useDetail<JobFull>(`/api/jobs/${encodeURIComponent(id)}`);
  const links = useDetail<{ people: PersonLink[]; mails: MailLink[]; other: OtherTouch[] }>(`/api/jobs/${encodeURIComponent(id)}/links`);
  return <DetailDrawer title={data ? data.title : "Job"} subtitle={data?.company} onClose={nav.onClose} crumbs={nav.crumbs} onBack={nav.onBack}>
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
      <LinksState links={links}>{(l) => <>
        <h4>People ({l.people.length})</h4>
        {l.people.length ? <div>{l.people.map((p, i) => <PersonLinkRow key={`${p.ref ?? "x"}${i}`} p={p} />)}</div> : <p className="muted">No one is tied to this job yet. Contacts appear after the contact finder runs.</p>}
        <h4>Email and follow-ups ({l.mails.length})</h4>
        {l.mails.length ? <div>{l.mails.map((m, i) => <MailLinkRow key={`${m.ref ?? "x"}${i}`} m={m} />)}</div> : <p className="muted">No email has been queued or sent for this job.</p>}
        <h4>Other outreach ({l.other.length})</h4>
        {l.other.length ? <div>{l.other.map((o, i) => <LinkRow key={i} onOpen={o.person_ref ? () => open({ kind: "person", id: o.person_ref as string }) : undefined}
          title={`${humanize(o.kind)}${o.person_name ? ` to ${o.person_name}` : ""}`} meta={[humanize(o.platform), when(o.at)].filter(Boolean).join(" · ")} aside={<StatusBadge status={o.status} />} />)}</div>
          : <p className="muted">No LinkedIn or Naukri messages for this job.</p>}
      </>}</LinksState>
    </> : null}</DrawerState>
  </DetailDrawer>;
}

export function JobsView() {
  const { open } = usePanels();
  const [q, setQ] = useState(""); const [source, setSource] = useState(""); const [state, setState] = useState(""); const [bucket, setBucket] = useState("");
  const [sources, setSources] = useState<{ source: string; count: number }[]>([]);
  useEffect(() => { api<{ sources: { source: string; count: number }[] }>("/api/jobs/facets").then((f) => setSources(f.sources)).catch(() => undefined); }, []);
  const list = usePaged<JobRow>("/api/jobs", { q: q || undefined, source: source || undefined, state: state || undefined, bucket: bucket || undefined });
  return <Panel title="Jobs" toolbar={<Toolbar onReload={list.reload} loading={list.loading}>
    <DebouncedSearch value={q} onChange={setQ} placeholder="Search title or company" label="Search jobs" />
    <FilterSelect label="Source" value={source} onChange={setSource} options={[{ value: "", label: "All sources" }, ...sources.map((s) => ({ value: s.source, label: `${s.source} (${s.count})` }))]} />
    <FilterSelect label="State" value={state} onChange={setState} options={[{ value: "", label: "Any state" }, { value: "active", label: "Not excluded" }, { value: "excluded", label: "Excluded" }]} />
    <FilterSelect label="Stage" value={bucket} onChange={setBucket} options={[{ value: "", label: "Any stage" }, { value: "matched", label: "Matched" }, { value: "applied", label: "Applied" }, { value: "pending", label: "Awaiting apply" }, { value: "failed", label: "Failed" }]} />
  </Toolbar>}>
    <ListFrame state={list} empty={{ title: "No jobs match", text: "Change the search or filters, or wait for the next discovery run." }}>
      {(items) => items.map((j) => <RecordRow key={j.id} onOpen={() => open({ kind: "job", id: j.id })} title={`${j.title} at ${j.company || "unknown company"}`}
        meta={`${j.source} · found ${readableTime(j.created_at)}${j.excluded_reason ? ` · ${j.excluded_reason}` : ""}`}
        aside={<>{j.score !== null ? <Badge tone={j.score >= 60 ? "good" : ""}>{j.score}</Badge> : <Badge>unscored</Badge>}{j.excluded_reason ? <Badge tone="bad">excluded</Badge> : <StatusBadge status={j.status} />}</>} />)}
    </ListFrame>
  </Panel>;
}

// ---------------------------------------------------------------- Person and contact panel
type PersonRow = { id: number; platform: string; name: string | null; headline: string | null; company: string | null; category: string; stage: string | null; connection_status: string | null; touch_count: number; profile_url: string | null; last_touch_at: string | null; next_due_at: string | null; followups_sent: number | null; paused_reason: string | null };
type Thread = { person: PersonRow; touches: { items: { id: number; job_id: string | null; kind: string; status: string; body: string | null; created_at: string; sent_at: string | null }[] } };
type ContactFull = { id: number; company: string | null; email: string | null; type: string | null; verified: boolean | null; source: string | null; created_at: string | null };
type PersonLinksData = { jobs: (JobBrief & { via: string[] })[]; mails: MailLink[] };

function RelatedRecords({ links, mailsLabel }: { links: { data: PersonLinksData | null; error: string | null }; mailsLabel: string }) {
  return <LinksState links={links}>{(l) => <>
    <h4>Jobs ({l.jobs.length})</h4>
    {l.jobs.length ? <div>{l.jobs.map((j) => <LinkRowJob key={j.id} j={j} />)}</div> : <p className="muted">No job is linked to this record yet.</p>}
    <h4>{mailsLabel} ({l.mails.length})</h4>
    {l.mails.length ? <div>{l.mails.map((m, i) => <MailLinkRow key={`${m.ref ?? "x"}${i}`} m={m} showJob />)}</div> : <p className="muted">No emails for the linked jobs.</p>}
  </>}</LinksState>;
}
function LinkRowJob({ j }: { j: JobBrief & { via: string[] } }) {
  const { open } = usePanels();
  return <LinkRow onOpen={() => open({ kind: "job", id: j.id })} title={jobTitle(j)} meta={j.via.join(", ")}
    aside={<>{j.score !== null ? <Badge tone={j.score >= 60 ? "good" : ""}>{j.score}</Badge> : null}{j.excluded_reason ? <Badge tone="bad">excluded</Badge> : <StatusBadge status={j.status} />}</>} />;
}

function PersonDetail({ id, nav }: { id: number; nav: PanelNav }) {
  const { data, error } = useDetail<Thread>(`/api/people/${id}/thread?limit=50`);
  const links = useDetail<PersonLinksData>(`/api/people/${id}/links`);
  const { open } = usePanels();
  const p = data?.person;
  return <DetailDrawer title={p?.name || "Person"} subtitle={p ? [p.headline, p.company].filter(Boolean).join(" · ") : undefined} onClose={nav.onClose} crumbs={nav.crumbs} onBack={nav.onBack}>
    <DrawerState data={data} error={error}>{p && data ? <>
      <KV rows={[
        ["Company", p.company], ["Role / headline", p.headline], ["Source", p.platform], ["Category", humanize(p.category)],
        ["Profile", p.profile_url ? <ExternalLink key="p" href={p.profile_url}>Open the profile</ExternalLink> : "No profile link"],
        ["Connection", p.connection_status ? <StatusBadge key="c" status={p.connection_status} /> : "No connection request"], ["Stage", p.stage ? humanize(p.stage) : null],
        ["Follow-ups sent", p.followups_sent], ["Last touch", p.last_touch_at ? readableTime(p.last_touch_at) : null], ["Next due", p.next_due_at ? readableTime(p.next_due_at) : null], ["Paused", p.paused_reason],
      ]} />
      <RelatedRecords links={links} mailsLabel="Emails for these jobs" />
      <h4>Touches ({data.touches.items.length})</h4>
      {data.touches.items.length ? <ul className="plain-list">{data.touches.items.map((t) => <li key={t.id}><strong>{humanize(t.kind)}</strong> <StatusBadge status={t.status} /> · {readableTime(t.sent_at ?? t.created_at)}
        {t.job_id ? <> · <button type="button" className="text-link" onClick={() => open({ kind: "job", id: t.job_id as string })}>open job</button></> : null}{t.body ? <p className="quote">{t.body}</p> : null}</li>)}</ul> : <p className="muted">No messages sent to this person yet.</p>}
    </> : null}</DrawerState>
  </DetailDrawer>;
}

function ContactDetail({ id, nav }: { id: number; nav: PanelNav }) {
  const { data, error } = useDetail<ContactFull>(`/api/contacts/${id}`);
  const links = useDetail<PersonLinksData>(`/api/people/c${id}/links`);
  return <DetailDrawer title={data?.email || "Email contact"} subtitle={data?.company ?? undefined} onClose={nav.onClose} crumbs={nav.crumbs} onBack={nav.onBack}>
    <DrawerState data={data} error={error}>{data ? <>
      <KV rows={[
        ["Email", data.email], ["Company", data.company], ["Type", data.type ? humanize(data.type) : null],
        ["Verified", data.verified === null ? "Not checked" : data.verified ? <Badge key="v" tone="good">verified</Badge> : <Badge key="v" tone="warn">unverified</Badge>],
        ["Found by", data.source], ["Added", when(data.created_at)],
      ]} />
      <RelatedRecords links={links} mailsLabel="Emails to this address and these jobs" />
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
    <FilterSelect label="Stage" value={stage} onChange={setStage} options={[{ value: "", label: "Any stage" }, ...stages.map((s) => ({ value: s, label: humanize(s) }))]} />
  </Toolbar>}>
    <ListFrame state={list} empty={{ title: "No people match", text: "Contacts appear after the contact finder runs for matched jobs." }}>
      {(items) => items.map((p) => <RecordRow key={p.id} onOpen={() => open({ kind: "person", id: String(p.id) })} title={p.name || "Unnamed contact"}
        meta={[p.headline, p.company, p.platform].filter(Boolean).join(" · ")}
        aside={<>{p.category ? <Badge>{humanize(p.category)}</Badge> : null}{p.connection_status ? <StatusBadge status={p.connection_status} /> : p.stage ? <StatusBadge status={p.stage} /> : null}</>} />)}
    </ListFrame>
  </Panel>;
}

// ---------------------------------------------------------------- Mail panel (cold email 12, follow-up f3)
type MailRow = { id: number; job_id: string; title: string | null; company: string | null; to: string | null; subject: string | null; sent_at: string | null; status: string | null; has_reply: boolean };
type MailFull = MailRow & { body: string | null; replies: { message_id: string; classification: string | null; from_addr: string | null; subject: string | null; reply_date: string | null }[] };
type FollowupFull = { id: number; job_id: string; n: number; label: string; status: string; subject: string | null; body: string | null; to: string | null; created_at: string | null; sent_at: string | null; decided_at: string | null; title: string | null; company: string | null; has_reply: boolean };
type MailLinksData = { job: JobBrief | null; job_id: string | null; contact: PersonLink | null; timeline: MailLink[] };

function RelatedBlock({ links }: { links: { data: MailLinksData | null; error: string | null } }) {
  return <section className="related" aria-label="Related">
    <h4>Related</h4>
    <LinksState links={links}>{(l) => <>
      <p className="related-label">Job</p>
      {l.job ? <JobLinkRow job={l.job} /> : <p className="muted">{l.job_id ? `The job for this email (${l.job_id}) is no longer in the database.` : "This email has no job on record."}</p>}
      <p className="related-label">Contact</p>
      {l.contact ? <PersonLinkRow p={l.contact} /> : <p className="muted">No recipient address on record.</p>}
      {l.timeline.length > 1 ? <>
        <p className="related-label">Follow-ups of this job</p>
        <ol className="timeline">{l.timeline.map((m, i) => <li key={`${m.ref ?? "x"}${i}`}><MailLinkRow m={m} /></li>)}</ol>
      </> : null}
    </>}</LinksState>
  </section>;
}

function ColdMailDetail({ id, nav }: { id: number; nav: PanelNav }) {
  const { data, error } = useDetail<MailFull>(`/api/emails/${id}`);
  const links = useDetail<MailLinksData>(`/api/emails/${id}/links`);
  return <DetailDrawer title={data?.subject || "Email"} subtitle={data ? `To ${dash(data.to)}` : undefined} onClose={nav.onClose} crumbs={nav.crumbs} onBack={nav.onBack}>
    <DrawerState data={data} error={error}>{data ? <>
      <RelatedBlock links={links} />
      <KV rows={[
        ["To", data.to], ["Subject", data.subject], ["Status", <StatusBadge key="s" status={data.status} />],
        ["Sent", data.sent_at ? readableTime(data.sent_at) : "Not sent"], ["Reply", data.has_reply ? <Badge key="r" tone="good">reply on file</Badge> : "No reply on file"],
      ]} />
      <h4>Message</h4>
      {data.body ? <pre className="mail-body">{data.body}</pre> : <p className="muted">No body stored.</p>}
      {data.replies.length ? <><h4>Replies and bounces</h4><ul className="plain-list">{data.replies.map((r) => <li key={r.message_id}><StatusBadge status={r.classification} /> {r.from_addr ?? ""} · {r.subject ?? ""}{r.reply_date ? ` · ${readableTime(r.reply_date)}` : ""}</li>)}</ul></> : null}
    </> : null}</DrawerState>
  </DetailDrawer>;
}

function FollowupMailDetail({ id, nav }: { id: number; nav: PanelNav }) {
  const { data, error } = useDetail<FollowupFull>(`/api/followups/${id}`);
  const links = useDetail<MailLinksData>(`/api/followups/${id}/links`);
  return <DetailDrawer title={data?.subject || data?.label || "Follow-up"} subtitle={data ? `${data.label} · To ${dash(data.to)}` : undefined} onClose={nav.onClose} crumbs={nav.crumbs} onBack={nav.onBack}>
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
        meta={`To ${dash(m.to)} · ${[m.title, m.company].filter(Boolean).join(" at ") || m.job_id} · ${m.sent_at ? readableTime(m.sent_at) : "not sent"}`}
        aside={<><StatusBadge status={m.status} />{m.has_reply ? <Badge tone="good">replied</Badge> : null}</>} />)}
    </ListFrame>
  </Panel>;
}

/** The side panel for any record kind; mounted once by the shell so it works from every page. */
export function renderPanel(ref: PanelRef, nav: PanelNav): ReactNode {
  if (ref.kind === "job") return <JobDetail id={ref.id} nav={nav} />;
  if (ref.kind === "mail") return ref.id.startsWith("f") ? <FollowupMailDetail id={Number(ref.id.slice(1))} nav={nav} /> : <ColdMailDetail id={Number(ref.id)} nav={nav} />;
  return ref.id.startsWith("c") ? <ContactDetail id={Number(ref.id.slice(1))} nav={nav} /> : <PersonDetail id={Number(ref.id)} nav={nav} />;
}
