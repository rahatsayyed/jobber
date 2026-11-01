"use client";

import { ArrowClockwiseIcon, MagnifyingGlassIcon, XIcon } from "@phosphor-icons/react";
import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/dashboard-api";
import { buildQuery, humanize, statusTone } from "@/lib/view-models";

export const PAGE_SIZE = 25;

type PageShape<T> = { items?: T[]; nextCursor?: number | null };

/** Cursor-paged list: resets when the path or params change, appends on loadMore, ignores answers of stale requests. */
export function usePaged<T>(path: string, params: Record<string, string | undefined>, cursorParam = "cursor") {
  const [items, setItems] = useState<T[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const key = `${path}|${JSON.stringify(params)}`;
  const fetchPage = useCallback(async (cursor: number | null, append: boolean) => {
    const id = ++seq.current;
    setLoading(true); setError(null);
    try {
      const data = await api<PageShape<T>>(`${path}${buildQuery({ ...JSON.parse(key.slice(path.length + 1)) as Record<string, string>, limit: PAGE_SIZE, [cursorParam]: cursor })}`);
      if (id !== seq.current) return;
      setItems((old) => (append && old ? [...old, ...(data.items ?? [])] : data.items ?? []));
      setNext(data.nextCursor ?? null);
    } catch (reason) {
      if (id === seq.current) setError(reason instanceof Error ? reason.message : "The data could not be loaded.");
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [path, key, cursorParam]);
  useEffect(() => {
    const t = window.setTimeout(() => { setItems(null); setNext(null); void fetchPage(null, false); }, 0);
    return () => window.clearTimeout(t);
  }, [fetchPage]);
  return {
    items, error, loading, hasMore: next !== null,
    loadMore: () => { if (next !== null) void fetchPage(next, true); },
    reload: () => { setItems(null); void fetchPage(null, false); },
  };
}

export function useDetail<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    const t = window.setTimeout(() => {
      setData(null); setError(null);
      api<T>(path).then((d) => { if (live) setData(d); }).catch((e) => { if (live) setError(e instanceof Error ? e.message : "Could not load the details."); });
    }, 0);
    return () => { live = false; window.clearTimeout(t); };
  }, [path]);
  return { data, error };
}

export function LoadingLines() { return <div className="loading" aria-label="Loading"><span /><span /><span /></div>; }

export function Badge({ children, tone }: { children: ReactNode; tone?: "good" | "warn" | "bad" | "" }) {
  return <span className={`badge ${tone ?? ""}`}>{children}</span>;
}
export function StatusBadge({ status }: { status: string | null | undefined }) {
  return status ? <Badge tone={statusTone(status)}>{humanize(status)}</Badge> : null;
}

/** Search box plus filter selects. `onChange` for text is debounced by the caller via DebouncedSearch. */
export function DebouncedSearch({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  const [text, setText] = useState(value);
  useEffect(() => { const t = window.setTimeout(() => { if (text !== value) onChange(text); }, 300); return () => window.clearTimeout(t); }, [text, value, onChange]);
  return <label className="search-box"><MagnifyingGlassIcon size={15} aria-hidden="true" /><span className="sr-only">{label}</span><input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder={placeholder} maxLength={64} /></label>;
}

export function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[] }) {
  return <label className="filter-select"><span className="sr-only">{label}</span><select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></label>;
}

export function Toolbar({ children, onReload, loading }: { children?: ReactNode; onReload: () => void; loading: boolean }) {
  return <div className="toolbar">{children}<button className="icon-button" onClick={onReload} type="button" aria-label="Refresh records" title="Refresh" disabled={loading}><ArrowClockwiseIcon size={16} aria-hidden="true" /></button></div>;
}

/** Loading, error and empty states plus the "Load more" footer around a list. */
export function ListFrame<T>({ state, empty, children }: { state: ReturnType<typeof usePaged<T>>; empty: { title: string; text: string }; children: (items: T[]) => ReactNode }) {
  const { items, error, loading, hasMore, loadMore } = state;
  return <div aria-live="polite">
    {items === null && !error ? <div className="object-list"><LoadingLines /></div> : null}
    {error ? <div className="notice danger"><strong>Could not load this view.</strong><br />{error}</div> : null}
    {items?.length ? <div className="object-list">{children(items)}</div> : null}
    {items && !items.length && !error ? <div className="empty-state"><h3>{empty.title}</h3>{empty.text}</div> : null}
    {items?.length ? <div className="list-foot"><span>{items.length} shown{hasMore ? "" : ", end of list"}</span>{hasMore ? <button className="button" type="button" onClick={loadMore} disabled={loading}>{loading ? "Loading..." : "Load more"}</button> : null}</div> : null}
  </div>;
}

export function RecordRow({ onOpen, title, meta, aside, selected }: { onOpen: () => void; title: ReactNode; meta?: ReactNode; aside?: ReactNode; selected?: boolean }) {
  return <button type="button" className="record-row" onClick={onOpen} aria-haspopup="dialog" aria-pressed={selected ? true : undefined}>
    <span className="record-main"><strong>{title}</strong>{meta ? <span className="record-meta">{meta}</span> : null}</span>
    {aside ? <span className="record-aside">{aside}</span> : null}
  </button>;
}

export function Panel({ title, children, toolbar }: { title: string; children: ReactNode; toolbar?: ReactNode }) {
  return <section className="workspace-panel"><div className="workspace-panel-header"><h3>{title}</h3></div>{toolbar}<div className="panel-body">{children}</div></section>;
}

/** Read-only side panel (a dialog on narrow screens). Esc and the backdrop close it. */
export function DetailDrawer({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div className="drawer-layer">
    <div className="drawer-backdrop" onClick={onClose} aria-hidden="true" />
    <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
      <header className="drawer-head"><div><h3>{title}</h3>{subtitle ? <p>{subtitle}</p> : null}</div><button ref={closeRef} className="icon-button" type="button" onClick={onClose} aria-label="Close details" title="Close"><XIcon size={16} aria-hidden="true" /></button></header>
      <div className="drawer-body">{children}</div>
    </aside>
  </div>;
}

export function KV({ rows }: { rows: [string, ReactNode][] }) {
  return <dl className="kv">{rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>;
}

export function DrawerState({ data, error, children }: { data: unknown; error: string | null; children: ReactNode }) {
  if (error) return <div className="notice danger"><strong>Could not load the details.</strong><br />{error}</div>;
  if (!data) return <LoadingLines />;
  return <>{children}</>;
}
