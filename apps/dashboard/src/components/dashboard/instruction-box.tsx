"use client";

import { useEffect, useState } from "react";

const MAX = 1000;

type Reply = { ok?: boolean; error?: string };

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

/**
 * "Tell the agent what to do": a free-text instruction the next wake acts on. Without props it is the global box (top of the Inbox);
 * with `escalationId` it is the small per-card box, and a sent card shows "with agent" instead of the box.
 */
export function InstructionBox({ csrf, escalationId }: { csrf: string | null; escalationId?: number }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withAgent, setWithAgent] = useState(false);
  const [open, setOpen] = useState(escalationId === undefined);

  useEffect(() => {
    if (escalationId === undefined) return;
    let live = true;
    fetch("/api/instructions", { cache: "no-store", credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { with_agent_escalation_ids?: number[] } | null) => { if (live && d?.with_agent_escalation_ids?.includes(escalationId)) setWithAgent(true); })
      .catch(() => { /* the box still works without the status */ });
    return () => { live = false; };
  }, [escalationId]);

  const send = async () => {
    setBusy(true); setError(null); setNote(null);
    try {
      await post({ text, ...(escalationId !== undefined ? { escalation_id: escalationId } : {}) }, csrf);
      setText("");
      if (escalationId !== undefined) setWithAgent(true); else setNote("Saved. The next wake acts on it.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The request failed.");
    } finally {
      setBusy(false);
    }
  };

  if (withAgent) return <p className="muted" role="status"><span className="badge">with agent</span> The agent will act on your instruction in the next wake.</p>;
  if (!open) return <button type="button" className="text-link" onClick={() => setOpen(true)}>Tell the agent what to do</button>;
  const id = `ib-${escalationId ?? "global"}`;
  return <div className="instruction-box">
    <label htmlFor={id}>{escalationId === undefined ? "Add instruction for the agent" : "Tell the agent what to do"}</label>
    <textarea id={id} rows={escalationId === undefined ? 3 : 2} maxLength={MAX} value={text} disabled={busy} onChange={(e) => setText(e.target.value)}
      placeholder={escalationId === undefined ? "For example: skip all jobs from company X" : "What should the agent do about this?"} />
    <div className="inbox-actions">
      <button type="button" className="button primary" disabled={busy || !csrf || !text.trim()} onClick={() => void send()}>Send to agent</button>
      <span className="muted">{text.length}/{MAX}</span>
    </div>
    {note ? <p className="muted" role="status">{note}</p> : null}
    {error ? <p className="error" role="alert">{error}</p> : null}
  </div>;
}
