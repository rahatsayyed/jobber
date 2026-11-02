"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { PaperPlaneTilt, Sparkle } from "@phosphor-icons/react";
import "./instruction-box.css";

const MAX = 1000;

type Reply = { ok?: boolean; error?: string };
export type OwnerInstruction = {
  id: number; text: string; escalation_id: number | null;
  status: "pending" | "in_progress" | "done" | "rejected"; result_note: string | null; created_at: string;
};
type Snapshot = { items: OwnerInstruction[]; loaded: boolean };

/* One shared GET for every box on the page (module-level cache), refreshed after each send. */
let snapshot: Snapshot = { items: [], loaded: false };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();
const publish = (next: Snapshot) => { snapshot = next; listeners.forEach((l) => l()); };

function refresh(force = false): Promise<void> {
  if (inflight) return inflight;
  if (snapshot.loaded && !force) return Promise.resolve();
  inflight = fetch("/api/instructions", { cache: "no-store", credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { instructions?: OwnerInstruction[] } | null) => { publish({ items: d?.instructions ?? snapshot.items, loaded: true }); })
    .catch(() => { publish({ ...snapshot, loaded: true }); })
    .finally(() => { inflight = null; });
  return inflight;
}

function useInstructions(): Snapshot {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    void refresh();
    return () => { listeners.delete(l); };
  }, []);
  return snapshot;
}

async function post(body: unknown, csrf: string | null): Promise<Reply> {
  const response = await fetch("/api/instructions", {
    method: "POST", cache: "no-store", credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
    body: JSON.stringify(body),
  });
  let data: Reply = {};
  try { data = (await response.json()) as Reply; } catch { /* not JSON */ }
  if (response.status === 401) throw new Error("Sign in is required.");
  if (response.status === 403) throw new Error("Not allowed. Reload the page and try again.");
  if (!response.ok) throw new Error(data.error ?? "The request failed.");
  return data;
}

const STATUS_LABEL: Record<OwnerInstruction["status"], string> = {
  pending: "Waiting for next wake", in_progress: "Agent is working", done: "Done", rejected: "Not done",
};

function Sent({ item }: { item: OwnerInstruction }) {
  return <div className={`ib-sent ib-${item.status}`}>
    <span className="ib-chip"><i aria-hidden="true" />With agent · {STATUS_LABEL[item.status]}</span>
    <blockquote className="ib-quote">{item.text}</blockquote>
    {item.result_note ? <p className="ib-note"><b>Agent:</b> {item.result_note}</p> : null}
  </div>;
}

/**
 * "Tell the agent what to do": a free-text instruction the next wake acts on. Without `escalationId` it is the global box
 * (top of the Inbox); with it, a compact per-card button that opens a composer in place. `showAll` (the details slider)
 * lists every past instruction for that item and starts with the composer open.
 */
export function InstructionBox({ csrf, escalationId, showAll = false }: { csrf: string | null; escalationId?: number; showAll?: boolean }) {
  const global = escalationId === undefined;
  const { items } = useInstructions();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSent, setJustSent] = useState(false);
  const [open, setOpen] = useState(global);
  const area = useRef<HTMLTextAreaElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();

  const mine = items.filter((i) => (global ? i.escalation_id === null : i.escalation_id === escalationId));
  const shown = showAll ? mine : mine.slice(0, 1);

  const grow = useCallback(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 220)}px`;
  }, []);
  useEffect(grow, [text, open, grow]);
  useEffect(() => { if (open && !global) area.current?.focus(); }, [open, global]);

  const cancel = () => { setOpen(global); setText(""); setError(null); if (!global) setTimeout(() => trigger.current?.focus(), 0); };

  const send = async () => {
    if (busy || !csrf || !text.trim()) return;
    setBusy(true); setError(null);
    try {
      await post({ text, ...(global ? {} : { escalation_id: escalationId }) }, csrf);
      setText(""); setJustSent(true);
      if (!global) setOpen(false);
      await refresh(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
    else if (e.key === "Escape" && !global) { e.preventDefault(); e.stopPropagation(); cancel(); }
  };

  const composer = <div className={`ib-composer${global ? " ib-global" : ""}`}>
    {global ? <div className="ib-head">
      <label htmlFor={id} className="ib-title"><Sparkle size={14} weight="fill" aria-hidden="true" /> Add instruction for the agent</label>
      <p className="ib-help">Write what you want done. The next wake reads it and acts. Safety rules and limits still apply.</p>
    </div> : <label htmlFor={id} className="ib-sr">Tell the agent what to do about this item</label>}
    <textarea id={id} ref={area} rows={global ? 3 : 2} maxLength={MAX} value={text} disabled={busy} onKeyDown={onKey}
      onChange={(e) => { setText(e.target.value); setJustSent(false); }} aria-describedby={`${id}-hint`}
      placeholder="e.g. apply if the role fits, and message a developer there" />
    <div className="ib-bar">
      <span id={`${id}-hint`} className="ib-hint"><kbd>Cmd/Ctrl</kbd>+<kbd>Enter</kbd> to send{global ? "" : <> · <kbd>Esc</kbd> to cancel</>}</span>
      <span className={`ib-count${text.length > MAX - 80 ? " warn" : ""}`} aria-label={`${text.length} of ${MAX} characters`}>{text.length}/{MAX}</span>
      {!global ? <button type="button" className="button ib-btn" disabled={busy} onClick={cancel}>Cancel</button> : null}
      <button type="button" className="button primary ib-btn" disabled={busy || !csrf || !text.trim()} onClick={() => void send()}>
        <PaperPlaneTilt size={14} aria-hidden="true" />{busy ? "Sending…" : "Send to agent"}
      </button>
    </div>
    <div aria-live="polite">
      {error ? <p className="ib-error" role="alert">{error}</p> : null}
      {justSent && !error ? <p className="ib-ok" role="status">Sent. The next wake acts on it.</p> : null}
    </div>
  </div>;

  if (global) return <section className="ib-card" aria-label="Instruction for the agent">{composer}{shown.map((s) => <Sent key={s.id} item={s} />)}</section>;

  return <div className={`ib-inline${showAll ? " ib-wide" : ""}`}>
    {shown.map((s) => <Sent key={s.id} item={s} />)}
    {open ? composer : <button type="button" ref={trigger} className="button ib-trigger" aria-expanded="false" onClick={() => setOpen(true)}>
      <Sparkle size={14} weight="fill" aria-hidden="true" />{mine.length ? "Send another instruction" : "Tell the agent"}
    </button>}
    <span className="ib-sr" aria-live="polite">{justSent ? "Instruction sent to the agent." : ""}</span>
  </div>;
}
