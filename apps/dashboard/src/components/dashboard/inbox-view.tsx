"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, readableTime } from "@/lib/dashboard-api";
import { EscLike, escalationLine, escalationTitle, groupEscalations, humanize, safeExternalUrl } from "@/lib/view-models";
import { Badge, DebouncedSearch, DetailDrawer, FilterSelect, KV, LoadingLines, Panel, RecordRow, Toolbar } from "@/components/dashboard/list-kit";

type Esc = EscLike & {
  count: number; first_at: string; threadUrl: string | null; senderHeadline: string | null; messageAt: string | null; updates: number; flag: string | null;
  resolved_at: string | null; snoozed_until: string | null;
};
type Payload = { items: Esc[]; counts: { open: number; snoozed: number; resolved: number } };
const GROUP_PAGE = 10;

function InboxDetail({ item, onClose }: { item: Esc; onClose: () => void }) {
  const who = item.senderName || item.personName;
  const link = safeExternalUrl(item.threadUrl);
  return <DetailDrawer title={escalationTitle(item)} subtitle={escalationLine(item)} onClose={onClose}>
    <KV rows={[
      ["Kind", item.label], ["Platform", item.platform], ["From", who ? `${who}${item.senderHeadline ? `, ${item.senderHeadline}` : ""}` : null], ["Company", item.personCompany],
      ["Related job", item.jobTitle], ["Status", item.resolved_at ? <Badge key="s" tone="good">handled</Badge> : item.snoozed_until ? <Badge key="s" tone="warn">snoozed</Badge> : <Badge key="s">open</Badge>],
      ["Reported", item.updates > 1 ? `${item.updates} times, first ${readableTime(item.first_at)}, last ${readableTime(item.last_at ?? item.created_at)}` : readableTime(item.created_at)],
      ["Thread", link ? <a key="t" href={link} target="_blank" rel="noopener noreferrer">Open the conversation</a> : null], ["Flag", item.flag],
    ]} />
    <h4>What to do</h4><p>{item.todo}</p>
    <h4>{item.excerpt ? "Latest message" : "Detail"}</h4>
    {item.excerpt ? <pre className="mail-body">{item.excerpt}</pre> : <p className={item.detail ? "" : "muted"}>{item.detail || "Details not captured. Open the thread to read it."}</p>}
    <p className="muted">Reason code: <code>{item.reason}</code>. This page is read only; mark items handled with the Telegram digest or the escalation commands.</p>
  </DetailDrawer>;
}

export function InboxView() {
  const [status, setStatus] = useState("open"); const [q, setQ] = useState(""); const [group, setGroup] = useState("");
  const [data, setData] = useState<Payload | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  const [shown, setShown] = useState<Record<string, number>>({}); const [open, setOpen] = useState<Esc | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await api<Payload>(`/api/escalations?status=${status}`)); setShown({}); } catch (e) { setError(e instanceof Error ? e.message : "The inbox could not be loaded."); } finally { setLoading(false); }
  }, [status]);
  useEffect(() => { const t = window.setTimeout(() => { setData(null); void load(); }, 0); return () => window.clearTimeout(t); }, [load]);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const items = (data?.items ?? []).filter((i) => (!group || i.group === group) && (!needle || `${escalationTitle(i)} ${escalationLine(i)} ${i.excerpt ?? ""} ${i.personCompany ?? ""}`.toLowerCase().includes(needle)));
    return groupEscalations(items);
  }, [data, q, group]);
  const close = useCallback(() => setOpen(null), []);
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return <Panel title="Inbox" toolbar={<Toolbar onReload={() => void load()} loading={loading}>
    <DebouncedSearch value={q} onChange={setQ} placeholder="Search people, company or text" label="Search the inbox" />
    <FilterSelect label="Status" value={status} onChange={setStatus} options={[{ value: "open", label: `Open${data ? ` (${data.counts.open})` : ""}` }, { value: "snoozed", label: `Snoozed${data ? ` (${data.counts.snoozed})` : ""}` }, { value: "resolved", label: `Handled${data ? ` (${data.counts.resolved})` : ""}` }]} />
    <FilterSelect label="Group" value={group} onChange={setGroup} options={[{ value: "", label: "All groups" }, { value: "human", label: "Replies and inquiries" }, { value: "platform", label: "Platform problems" }, { value: "noise", label: "Flagged" }]} />
  </Toolbar>}>
    <div aria-live="polite">
      {!data && !error ? <div className="object-list"><LoadingLines /></div> : null}
      {error ? <div className="notice danger"><strong>Could not load this view.</strong><br />{error}</div> : null}
      {data && !total && !error ? <div className="empty-state"><h3>{data.items.length ? "No item matches" : "Nothing needs you"}</h3>{data.items.length ? "Change the search or group." : "No escalations in this status."}</div> : null}
      {groups.map((g) => {
        const limit = shown[g.key] ?? GROUP_PAGE;
        return <section className="inbox-group" key={g.key} aria-label={g.title}>
          <div className="group-head"><h4>{g.title} <Badge>{g.items.length}</Badge></h4><p>{g.blurb}</p></div>
          <div className="object-list">{g.items.slice(0, limit).map((i) => <RecordRow key={i.id} onOpen={() => setOpen(i)} title={escalationTitle(i)} meta={`${escalationLine(i)} · ${readableTime(i.last_at ?? i.created_at)}`}
            aside={i.count > 1 ? <Badge>{i.count}x</Badge> : i.flag ? <Badge tone="warn">{humanize(i.flag)}</Badge> : null} />)}</div>
          {g.items.length > limit ? <div className="list-foot"><span>{limit} of {g.items.length} shown</span><button className="button" type="button" onClick={() => setShown((s) => ({ ...s, [g.key]: limit + GROUP_PAGE }))}>Show more</button></div> : null}
        </section>;
      })}
    </div>
    {open ? <InboxDetail item={open} onClose={close} /> : null}
  </Panel>;
}
