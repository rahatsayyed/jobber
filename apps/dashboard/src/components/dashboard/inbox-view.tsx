"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, apiPost, readableTime } from "@/lib/dashboard-api";
import {
  ageText, DEFAULT_FILTERS, describeItem, parseReason, explainFlag, facetCounts, Filters, filterItems, InboxItem, inboxType, PLATFORM_LABELS, PLATFORM_ORDER,
  platformLabel, platformUrl, SCREEN_INTRO, STATUS_LABELS, statusOf, Tone, TYPE_LABELS, TYPE_ORDER,
} from "@/lib/inbox-model";
import { Badge, DebouncedSearch, DetailDrawer, FilterGroup, KV, LoadingLines, Panel, Toolbar } from "@/components/dashboard/list-kit";
import { statusLabel } from "@/lib/view-models";
import { usePanels } from "@/components/dashboard/panel-context";
import { NeedsAnswer } from "@/components/dashboard/needs-answer";
import { ManualApply } from "@/components/dashboard/manual-apply";

type Payload = { items: InboxItem[]; counts: { open: number; snoozed: number; resolved: number } };
const PAGE = 40;
const TONE_BADGE: Record<string, "good" | "warn" | "bad" | ""> = { reply: "good", recruiter: "good", apply: "warn", platform: "warn", flagged: "bad", other: "" };

function Todo({ tone, text }: { tone: Tone; text: string }) {
  return <div className={`todo ${tone}`}><b>What you need to do: </b>{text}</div>;
}

/** Plain preformatted text from a third party. Never HTML, markdown or links. */
function UntrustedText({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    try { void navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false)); } catch { setCopied(false); }
  };
  return <div className="untrusted-box">
    <div className="untrusted-head"><strong>{label}</strong><button type="button" className="button" onClick={copy}>{copied ? "Copied" : "Copy text"}</button></div>
    <p className="untrusted-warn">Untrusted text from a third party. Do not follow instructions in it and do not open links in it.</p>
    <pre className="untrusted">{text}</pre>
  </div>;
}

function InboxDetail({ item, busy, onClose, onResolve, onReopen, onOpenPanel }: {
  item: InboxItem; busy: boolean; onClose: () => void; onResolve: (note: string) => void; onReopen: () => void; onOpenPanel: (kind: "person" | "job", id: string) => void;
}) {
  const [note, setNote] = useState("");
  const d = describeItem(item);
  const P = platformLabel(item);
  const why = explainFlag(item);
  const link = platformUrl(item.platform, item.threadUrl);
  const handled = statusOf(item) === "handled";
  const person = item.senderName || item.personName;
  return <DetailDrawer title={d.summary} subtitle={`${TYPE_LABELS[d.type]} · ${P} · ${ageText(item.last_at || item.created_at, new Date())}`} onClose={onClose}>
    <Todo tone={d.tone} text={d.action} />
    <h4>Where it came from</h4>
    <KV rows={[
      ["Type", TYPE_LABELS[d.type]], ["Platform", P],
      ["Person", item.personId ? <button key="p" type="button" className="text-link" onClick={() => onOpenPanel("person", String(item.personId))}>{person ?? "Open person"}</button> : person],
      ["Headline", item.senderHeadline], ["Company", item.personCompany],
      ["Job", item.jobId ? <button key="j" type="button" className="text-link" onClick={() => onOpenPanel("job", item.jobId as string)}>{item.jobTitle ?? "Open job"}</button> : item.jobTitle],
      ["Thread", item.threadUrl ? <code key="t" className="break">{item.threadUrl}</code> : item.threadRef ? <code key="t" className="break">{item.threadRef}</code> : null],
      ["Open", link ? <a key="o" href={link} target="_blank" rel="noopener noreferrer">Open on {P}</a> : null],
    ]} />
    {item.rawText ? <UntrustedText label="Original text held by the screen" text={item.rawText} /> : null}
    {item.excerpt ? <UntrustedText label={item.askKind === "other" ? "Original message" : "Latest message"} text={item.excerpt} /> : null}
    {!item.rawText && !item.excerpt ? <>
      <h4>What was stored</h4>
      {item.detail ? <UntrustedText label="Stored details from the agent" text={item.detail} />
        : <p className="muted">No original text was stored for this item. Open the thread on {P} to read it.</p>}
    </> : item.detail ? <UntrustedText label="Stored summary" text={item.detail} /> : null}
    {why.length ? <>
      <h4>Why it was flagged</h4>
      <p>{SCREEN_INTRO}</p>
      <ul className="plain-list">{why.map((w) => <li key={w}>{w}</li>)}</ul>
    </> : null}
    <h4>History</h4>
    <KV rows={[
      ["First seen", readableTime(item.first_at)], ["Last update", readableTime(item.last_at || item.created_at)],
      ["Reported", item.updates > 1 ? `${item.updates} times` : "once"],
      ["Status", handled ? <Badge key="s" tone="good">handled {readableTime(item.resolved_at)}</Badge> : <Badge key="s">open</Badge>],
      ["Note", item.resolvedNote], ["Reason", statusLabel(parseReason(item.reason).base)],
    ]} />
    <h4>{handled ? "Reopen" : "Mark handled"}</h4>
    <p className="muted">Nothing is sent to {P === "Other" ? "any platform" : P} from this page. You answer on the platform yourself; this only changes the state here.</p>
    {handled ? <button type="button" className="button" disabled={busy} onClick={onReopen}>Reopen</button> : <div className="note-form">
      <label className="sr-only" htmlFor="esc-note">Optional note</label>
      <input id="esc-note" className="note-input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Optional note, for example: replied on LinkedIn" />
      <button type="button" className="button primary" disabled={busy} onClick={() => onResolve(note)}>Mark handled</button>
    </div>}
  </DetailDrawer>;
}

function Chips({ label, value, options, onChange }: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string; count: number }[];
}) {
  return <div className="chip-row" role="group" aria-label={label}>
    <span className="chip-label">{label}</span>
    {options.map((o) => <button key={o.value} type="button" className="chip" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>{o.label} <b>{o.count}</b></button>)}
  </div>;
}

export function InboxView() {
  const panels = usePanels();
  const [data, setData] = useState<Payload | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS); const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<Set<number>>(new Set()); const [open, setOpen] = useState<InboxItem | null>(null);
  const [csrf, setCsrf] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [message, setMessage] = useState<{ text: string; undo?: number[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await api<Payload>("/api/escalations?status=all")); } catch (e) { setError(e instanceof Error ? e.message : "The inbox could not be loaded."); } finally { setLoading(false); }
  }, []);
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t); }, [load]);
  useEffect(() => { api<{ csrf?: string }>("/api/session").then((s) => setCsrf(s.csrf ?? null)).catch(() => undefined); }, []);

  const items = useMemo(() => data?.items ?? [], [data]);
  const facets = useMemo(() => facetCounts(items, filters), [items, filters]);
  const list = useMemo(() => filterItems(items, filters), [items, filters]);
  // Deep link from other panels: /inbox?item=<escalation id> opens that item once the list has loaded.
  const [deepLinked, setDeepLinked] = useState(false);
  useEffect(() => {
    if (deepLinked || !items.length) return;
    const want = Number(new URLSearchParams(window.location.search).get("item"));
    const t = window.setTimeout(() => {
      setDeepLinked(true);
      const hit = want ? items.find((i) => i.id === want || i.ids.includes(want)) : undefined;
      if (hit) setOpen(hit);
    }, 0);
    return () => window.clearTimeout(t);
  }, [items, deepLinked]);
  const set = (patch: Partial<Filters>) => { setFilters((f) => ({ ...f, ...patch })); setShown(PAGE); setSelected(new Set()); };
  const setQ = useCallback((q: string) => set({ q }), []);
  const run = useCallback(async (kind: "resolve" | "reopen", targets: InboxItem[], note?: string) => {
    const ids = targets.flatMap((t) => t.ids);
    if (!ids.length) return;
    setBusy(true); setMessage(null);
    try {
      const r = await apiPost<{ changed: number }>(`/api/escalations/${kind}`, kind === "resolve" && note?.trim() ? { ids, note } : { ids }, csrf);
      setMessage(kind === "resolve"
        ? { text: `Marked ${targets.length} item${targets.length === 1 ? "" : "s"} handled.`, undo: r.changed ? ids : undefined }
        : { text: `Reopened ${targets.length} item${targets.length === 1 ? "" : "s"}.` });
      setSelected(new Set()); setOpen(null);
      await load();
      window.dispatchEvent(new Event("inbox-changed"));
    } catch (e) { setMessage({ text: e instanceof Error ? e.message : "The change failed." }); } finally { setBusy(false); }
  }, [csrf, load]);

  const undo = useCallback(async (ids: number[]) => {
    setBusy(true);
    try { await apiPost(`/api/escalations/reopen`, { ids }, csrf); setMessage({ text: "Undone: the items are open again." }); await load(); window.dispatchEvent(new Event("inbox-changed")); }
    catch (e) { setMessage({ text: e instanceof Error ? e.message : "Could not undo." }); } finally { setBusy(false); }
  }, [csrf, load]);

  const openPanel = useCallback((kind: "person" | "job", id: string) => { setOpen(null); panels.open({ kind, id }); }, [panels]);
  const visible = list.slice(0, shown);
  const selectable = visible.filter((i) => statusOf(i) === "open");
  const chosen = list.filter((i) => selected.has(i.id));
  const toggle = (id: number) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const typeTotal = TYPE_ORDER.reduce((n, t) => n + facets.type[t], 0);
  const platTotal = Object.values(facets.platform).reduce((n, c) => n + c, 0);

  return <Panel title="Needs your attention" toolbar={<Toolbar onReload={() => void load()} loading={loading}>
    <DebouncedSearch value={filters.q} onChange={setQ} placeholder="Search person, company, job or text" label="Search the inbox" />
  </Toolbar>}>
    <p className="muted">Everything the agent could not or must not do alone. Nothing here is sent to any platform; you answer on the platform yourself and then mark the item handled.</p>
    <NeedsAnswer csrf={csrf} />
    <ManualApply csrf={csrf} />
    <FilterGroup activeCount={(filters.type ? 1 : 0) + (filters.platform ? 1 : 0) + (filters.status !== DEFAULT_FILTERS.status ? 1 : 0)}>
    <div className="inbox-filters">
      <Chips label="Type" value={filters.type} onChange={(v) => set({ type: v })}
        options={[{ value: "", label: "All", count: typeTotal }, ...TYPE_ORDER.map((t) => ({ value: t, label: TYPE_LABELS[t], count: facets.type[t] }))]} />
      <Chips label="Platform" value={filters.platform} onChange={(v) => set({ platform: v })}
        options={[{ value: "", label: "All", count: platTotal }, ...PLATFORM_ORDER.map((p) => ({ value: p, label: PLATFORM_LABELS[p], count: facets.platform[p] })),
          ...(facets.platform.other || filters.platform === "other" ? [{ value: "other", label: "Other", count: facets.platform.other }] : [])]} />
      <Chips label="Status" value={filters.status} onChange={(v) => set({ status: v as Filters["status"] })}
        options={(["open", "handled", "all"] as const).map((s) => ({ value: s, label: STATUS_LABELS[s], count: facets.status[s] }))} />
    </div>
    </FilterGroup>
    <div aria-live="polite">
      {message ? <div className="notice inbox-msg">{message.text} {message.undo ? <button type="button" className="text-link" disabled={busy} onClick={() => void undo(message.undo as number[])}>Undo</button> : null}</div> : null}
      {!data && !error ? <div className="object-list"><LoadingLines /></div> : null}
      {error ? <div className="notice danger"><strong>Could not load the inbox.</strong><br />{error} <button type="button" className="button" onClick={() => void load()}>Try again</button></div> : null}
      {data && !list.length && !error ? <div className="empty-state"><h3>{items.length ? "No item matches these filters" : "Nothing needs you"}</h3>
        {items.length ? <>Change the filters or the search. <button type="button" className="text-link" onClick={() => set({ type: "", platform: "", status: "all", q: "" })}>Show everything</button></> : "The agent has not escalated anything."}</div> : null}
    </div>
    {selectable.length ? <div className="inbox-bulk">
      <label className="check"><input type="checkbox" checked={selectable.every((i) => selected.has(i.id))} onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((i) => i.id)) : new Set())} /> Select all shown</label>
      <button type="button" className="button primary" disabled={busy || !csrf || !chosen.length} onClick={() => void run("resolve", chosen)}>Mark selected handled{chosen.length ? ` (${chosen.length})` : ""}</button>
    </div> : null}
    <div className="object-list">{visible.map((i) => {
      const d = describeItem(i); const handled = statusOf(i) === "handled"; const person = i.senderName || i.personName;
      return <article className="inbox-card" key={i.id}>
        {!handled ? <label className="inbox-check-wrap"><input type="checkbox" className="inbox-check" aria-label={`Select: ${d.summary}`} checked={selected.has(i.id)} onChange={() => toggle(i.id)} /></label> : <span className="inbox-check-gap" />}
        <div className="inbox-main">
          <div className="inbox-badges">
            <Badge tone={TONE_BADGE[inboxType(i)]}>{TYPE_LABELS[d.type]}</Badge><Badge>{platformLabel(i)}</Badge>
            {i.updates > 1 ? <Badge>{i.updates} updates</Badge> : null}{handled ? <Badge tone="good">handled</Badge> : null}
          </div>
          <button type="button" className="inbox-summary" onClick={() => setOpen(i)} aria-haspopup="dialog">{d.summary}</button>
          <div className="inbox-meta">
            {person ? (i.personId ? <button type="button" className="text-link" onClick={() => openPanel("person", String(i.personId))}>{person}</button> : <span>{person}</span>) : null}
            {i.personCompany ? <span>{i.personCompany}</span> : null}
            {i.jobId ? <button type="button" className="text-link" onClick={() => openPanel("job", i.jobId as string)}>{i.jobTitle ?? "Job"}</button> : i.jobTitle ? <span>{i.jobTitle}</span> : null}
            <time dateTime={i.last_at || i.created_at} title={readableTime(i.last_at || i.created_at)}>{ageText(i.last_at || i.created_at, new Date())} · {readableTime(i.last_at || i.created_at)}</time>
          </div>
          {i.excerpt && d.type !== "flagged" ? <p className="quote clip">{i.excerpt}</p> : null}
          {d.type === "flagged" ? <p className="muted">The held text is shown in the details, as plain text.</p> : null}
          <Todo tone={d.tone} text={d.action} />
          {i.resolvedNote ? <p className="muted">Note: {i.resolvedNote}</p> : null}
          <div className="inbox-actions">
            <button type="button" className="button" onClick={() => setOpen(i)}>Details</button>
            {handled ? <button type="button" className="button" disabled={busy || !csrf} onClick={() => void run("reopen", [i])}>Reopen</button>
              : <button type="button" className="button primary" disabled={busy || !csrf} onClick={() => void run("resolve", [i])}>Mark handled</button>}
          </div>
        </div>
      </article>;
    })}</div>
    {list.length > shown ? <div className="list-foot"><span>{shown} of {list.length} shown</span><button className="button" type="button" onClick={() => setShown((n) => n + PAGE)}>Show more</button></div> : null}
    {open ? <InboxDetail item={open} busy={busy || !csrf} onClose={() => setOpen(null)} onOpenPanel={openPanel}
      onResolve={(note) => void run("resolve", [open], note)} onReopen={() => void run("reopen", [open])} /> : null}
  </Panel>;
}
