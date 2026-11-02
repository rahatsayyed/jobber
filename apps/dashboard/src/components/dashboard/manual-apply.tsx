"use client";

import { useCallback, useEffect, useState } from "react";
import "@/app/manual-apply.css";
import { api } from "@/lib/dashboard-api";
import { Badge, LoadingLines } from "@/components/dashboard/list-kit";
import {
  actionBody, bulkLabel, easyApplyBanner, errorsFrom, filterByReason, MANUAL_PAGE, ManualItem, ManualPayload, NOTE_LIMIT, noteProblem, pageRows, pruneSelection,
  reasonFacets, reasonTone, safeDownload, safeOpenUrl, savedMessage, showMoreLabel, sinceText, toggleAll, toggleId,
} from "@/lib/manual-apply-model";

type Reply = { ok?: boolean; error?: string; results?: unknown };

/** POST that keeps the server's reason (the shared apiPost hides it behind a generic message). */
async function post(path: string, body: unknown, csrf: string | null): Promise<Reply> {
  const response = await fetch(path, {
    method: "POST", cache: "no-store", credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
    body: JSON.stringify(body),
  });
  let data: Reply = {};
  try { data = (await response.json()) as Reply; } catch { /* not JSON */ }
  if (response.status === 401) throw new Error("Sign in is required.");
  if (response.status === 403) throw new Error("Not allowed. Reload the page and try again.");
  if (!response.ok && response.status !== 422) throw new Error(data.error ?? "The request failed.");
  return data;
}

function Row({ item, selected, busy, csrf, error, onToggle, onAct }: {
  item: ManualItem; selected: boolean; busy: boolean; csrf: string | null; error?: string; onToggle: () => void; onAct: (kind: "done" | "skip", id: number) => void;
}) {
  const open = safeOpenUrl(item.open_url);
  const download = safeDownload(item);
  const since = sinceText(item.since, new Date());
  return <li className="ma-row" data-selected={selected}>
    <label className="check"><input type="checkbox" checked={selected} disabled={busy} onChange={onToggle} /><span className="sr-only">Select {item.title || "this job"}</span></label>
    <div className="ma-main">
      <h3 className="ma-title">{item.title || "(no title)"}{item.company ? <span className="ma-company"> at {item.company}</span> : null}</h3>
      <div className="ma-meta">
        <Badge tone={reasonTone(item.reason)}>{item.reason_label}</Badge>
        <span>{item.platform}</span>{since ? <span>waiting {since}</span> : null}
      </div>
      {item.ats_note ? <p className="muted ma-note">ATS: {item.ats_note}</p> : null}
    </div>
    <div className="ma-actions">
      {open ? <a className="button" href={open} target="_blank" rel="noopener noreferrer">Open job</a> : <span className="muted">No safe link stored</span>}
      {download ? <a className="button" href={download} download>Download resume</a> : <span className="muted ma-note">No tailored resume file yet</span>}
      <button type="button" className="button primary" disabled={busy || !csrf} onClick={() => onAct("done", item.id)}>I applied</button>
      <button type="button" className="button" disabled={busy || !csrf} onClick={() => onAct("skip", item.id)}>Skip</button>
    </div>
    {error ? <p className="ma-error" role="alert">{error}</p> : null}
  </li>;
}

/** The "Apply by hand" group in the Inbox: one row per job the machine cannot finish, with the open link, the resume and Done/Skip. */
export function ManualApply({ csrf }: { csrf: string | null }) {
  const [data, setData] = useState<ManualPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [banner, setBanner] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  // The group starts collapsed (78 rows make the page very tall); the summary row's link opens it.
  const [expanded, setExpanded] = useState(false);
  const [reason, setReason] = useState("");
  const [shown, setShown] = useState(MANUAL_PAGE);
  useEffect(() => {
    const open = (e: Event) => { if ((e as CustomEvent<string>).detail === "manual") setExpanded(true); };
    window.addEventListener("inbox-open-section", open);
    return () => window.removeEventListener("inbox-open-section", open);
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await api<ManualPayload>("/api/manual-apply");
      setData(next); setError(null);
      setSelected((s) => pruneSelection(s, next.items));
    } catch (e) { setError(e instanceof Error ? e.message : "The list could not be loaded."); }
  }, []);
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t); }, [load]);
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("inbox-reload", refresh);
    return () => window.removeEventListener("inbox-reload", refresh);
  }, [load]);

  const act = async (kind: "done" | "skip", ids: number[]) => {
    const problem = noteProblem(note);
    if (problem) { setBanner({ tone: "bad", text: problem }); return; }
    if (!ids.length) return;
    setBusy(true); setBanner(null); setErrors({});
    let fatal: string | null = null;
    let results: unknown = [];
    try {
      const r = await post(`/api/manual-apply/${kind}`, actionBody(ids, note), csrf);
      results = r.results;
      if (r.ok === false && !Array.isArray(r.results) && r.error) fatal = r.error;
    } catch (e) { fatal = e instanceof Error ? e.message : "The request failed."; }
    setBusy(false);
    const failed = errorsFrom(results);
    setErrors(failed);
    if (fatal) { setBanner({ tone: "bad", text: fatal }); return; }
    if (Object.keys(failed).length === ids.length) setBanner({ tone: "bad", text: "Nothing was saved. See the message under the job." });
    else { setBanner({ tone: "ok", text: savedMessage(kind, results) }); setNote(""); }
    setSelected([]);
    window.dispatchEvent(new Event("inbox-changed"));
    await load();
  };

  const all = data?.items ?? [];
  const facets = reasonFacets(all);
  const items = filterByReason(all, reason);
  const page = pageRows(items, shown);
  const banners = data ? easyApplyBanner(data) : null;
  const allOn = page.visible.length > 0 && page.visible.every((i) => selected.includes(i.id));
  const pickReason = (r: string) => { setReason(r); setShown(MANUAL_PAGE); };

  return <section className="ma" id="inbox-manual" aria-labelledby="ma-heading">
    <h2 id="ma-heading" className="ma-heading"><button type="button" className="ma-toggle" aria-expanded={expanded} aria-controls="ma-body" onClick={() => setExpanded((v) => !v)}>
      <span aria-hidden="true">{expanded ? "▾" : "▸"}</span> Apply by hand{data ? <span className="ma-count-badge"> {data.count}</span> : null}</button></h2>
    {data && !data.count && !error ? <p className="muted ma-empty-line">Nothing waits for you to apply by hand.</p> : null}
    <div id="ma-body" className="ma-body" hidden={!expanded}>
    <p className="muted">The agent cannot finish these. Open the job, apply yourself, then press I applied so it counts and no follow-up goes out for a job you already did.</p>
    {banners ? <p className="ma-banner">{banners}</p> : null}
    {!data && !error ? <div className="object-list"><LoadingLines /></div> : null}
    {error ? <div className="notice danger"><strong>Could not load the list.</strong><br />{error} <button type="button" className="button" onClick={() => void load()}>Try again</button></div> : null}
    {facets.length > 1 ? <div className="chip-row" role="group" aria-label="Filter by reason">
      <button type="button" className="chip" aria-pressed={reason === ""} onClick={() => pickReason("")}>All <b>{all.length}</b></button>
      {facets.map((f) => <button key={f.reason} type="button" className="chip" aria-pressed={reason === f.reason} onClick={() => pickReason(f.reason)}>{f.label} <b>{f.count}</b></button>)}
    </div> : null}
    {items.length ? <div className="ma-bar">
      <label className="check"><input type="checkbox" checked={allOn} disabled={busy} onChange={() => setSelected(toggleAll(selected, page.visible))} /> Select all shown ({page.visible.length})</label>
      <label className="ma-label" htmlFor="ma-note">Note (optional, kept with the jobs you mark)</label>
      <textarea id="ma-note" className="ma-input" rows={2} maxLength={NOTE_LIMIT} value={note} disabled={busy}
        onChange={(e) => { setNote(e.target.value); setBanner(null); }} placeholder="For example: applied on their site, used the downloaded resume" />
      {selected.length ? <div className="inbox-actions">
        <button type="button" className="button primary" disabled={busy || !csrf} onClick={() => void act("done", selected)}>{busy ? "Saving" : bulkLabel("done", selected.length)}</button>
        <button type="button" className="button" disabled={busy || !csrf} onClick={() => void act("skip", selected)}>{bulkLabel("skip", selected.length)}</button>
      </div> : null}
    </div> : null}
    <div aria-live="polite">{banner ? <p className={banner.tone === "ok" ? "ma-ok" : "ma-error"}>{banner.text}</p> : null}</div>
    {items.length ? <ul className="ma-list">
      {page.visible.map((item) => <Row key={item.id} item={item} selected={selected.includes(item.id)} busy={busy} csrf={csrf} error={errors[item.id]}
        onToggle={() => setSelected((s) => toggleId(s, item.id))} onAct={(kind, id) => void act(kind, [id])} />)}
    </ul> : null}
    {page.rest > 0 ? <div className="list-foot"><span>{page.text}</span><button className="button" type="button" onClick={() => setShown((n) => n + MANUAL_PAGE)}>{showMoreLabel(page.rest)}</button></div> : null}
    </div>
  </section>;
}
