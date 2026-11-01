"use client";

import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { api, apiPost } from "@/lib/dashboard-api";
import { frameToTerminal, reconnectDelay, TerminalFrame } from "@/lib/view-models";
import { Badge, LoadingLines, Panel } from "@/components/dashboard/list-kit";

type Win = { name: string; index: number; active: boolean; command: string };
type Listing = { tmux: boolean; inputEnabled: boolean; killed: boolean; sessions: { session: string; up: boolean; windows: Win[] }[] };
type Target = { session: string; window: string };
type Conn = "connecting" | "live" | "reconnecting" | "ended" | "failed" | "killed";
const CONN_TEXT: Record<Conn, string> = { connecting: "Connecting", live: "Live", reconnecting: "Reconnecting", ended: "Window closed", failed: "Disconnected", killed: "Stopped by kill switch" };
const MAX_ATTEMPTS = 6;

function cssVar(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}
/** xterm colours from the dashboard tokens, so light and dark both read well. ANSI colours stay xterm's defaults. */
function xtermTheme() {
  return { background: cssVar("--surface-raised", "#17191e"), foreground: cssVar("--ink", "#f4f5f7"), cursor: cssVar("--accent", "#8994ff"), selectionBackground: cssVar("--nav-active", "#1a1d27") };
}

function TerminalPane({ target, inputEnabled, csrf, onState }: { target: Target; inputEnabled: boolean; csrf: string | null; onState: (c: Conn) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false; let term: Terminal | null = null; let es: EventSource | null = null; let timer: number | undefined; let attempt = 0;
    let pending = ""; let flush: number | undefined; let themeObs: MutationObserver | undefined; let sizeObs: ResizeObserver | undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => { if (term) term.options.theme = xtermTheme(); };
    const sendKeys = () => {
      flush = undefined; const keys = pending; pending = ""; if (!keys) return;
      apiPost("/api/terminal/input", { session: target.session, window: target.window, keys }, csrf).catch(() => undefined);
    };
    /** The tmux pane can be far wider than the page: shrink the font so all columns fit, never below 8px. */
    const fit = () => {
      if (!term || !host.current) return;
      const fs = Math.max(8, Math.min(13, Math.floor((host.current.clientWidth - 20) / (term.cols * 0.6))));
      if (term.options.fontSize !== fs) term.options.fontSize = fs;
    };
    const toBottom = () => { if (host.current) host.current.scrollTop = host.current.scrollHeight; };
    const connect = () => {
      if (disposed) return;
      onState(attempt === 0 ? "connecting" : "reconnecting");
      es = new EventSource(`/api/terminal/stream?session=${encodeURIComponent(target.session)}&window=${encodeURIComponent(target.window)}`);
      es.addEventListener("hello", () => { attempt = 0; onState("live"); });
      es.addEventListener("frame", (ev) => {
        if (!term) return;
        try {
          const f = JSON.parse((ev as MessageEvent<string>).data) as TerminalFrame;
          if (f.cols !== term.cols || f.rows !== term.rows) { term.resize(Math.max(20, f.cols), Math.max(5, f.rows)); fit(); }
          term.write(frameToTerminal(f), toBottom);
        } catch { /* a bad frame is skipped */ }
      });
      es.addEventListener("end", (ev) => {
        es?.close(); es = null;
        let reason = ""; try { reason = (JSON.parse((ev as MessageEvent<string>).data) as { reason?: string }).reason ?? ""; } catch { /* keep empty */ }
        if (reason === "gone") return onState("ended");
        if (reason === "killed") return onState("killed");
        timer = window.setTimeout(connect, 300); // the server ends a long stream on purpose ("refresh"); just reopen
      });
      es.onerror = () => {
        es?.close(); es = null;
        if (disposed) return;
        attempt += 1;
        if (attempt > MAX_ATTEMPTS) return onState("failed");
        onState("reconnecting");
        timer = window.setTimeout(connect, reconnectDelay(attempt - 1));
      };
    };
    (async () => {
      const { Terminal: XTerm } = await import("@xterm/xterm");
      if (disposed || !host.current) return;
      term = new XTerm({ cols: 100, rows: 30, scrollback: 0, cursorBlink: false, disableStdin: !inputEnabled, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: xtermTheme(), allowProposedApi: false });
      term.open(host.current);
      sizeObs = new ResizeObserver(fit); sizeObs.observe(host.current);
      if (inputEnabled) term.onData((d) => { pending += d; if (flush === undefined) flush = window.setTimeout(sendKeys, 60); });
      themeObs = new MutationObserver(retheme);
      themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
      media.addEventListener("change", retheme);
      connect();
    })();
    return () => {
      disposed = true; if (timer) window.clearTimeout(timer); if (flush) window.clearTimeout(flush);
      es?.close(); themeObs?.disconnect(); sizeObs?.disconnect(); media.removeEventListener("change", retheme); term?.dispose();
    };
  }, [target.session, target.window, inputEnabled, csrf, onState, retry]);
  return <div className="term-wrap"><div ref={host} className="term-host" role="log" aria-label={`Terminal ${target.session} ${target.window}`} />
    <button type="button" className="button term-retry" onClick={() => setRetry((n) => n + 1)}>Reconnect</button></div>;
}

export function SessionsView() {
  const [listing, setListing] = useState<Listing | null>(null); const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null); const [conn, setConn] = useState<Conn>("connecting"); const [csrf, setCsrf] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setListing(await api<Listing>("/api/terminal/sessions")); setError(null); } catch (e) { setError(e instanceof Error ? e.message : "The sessions could not be loaded."); }
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => { void load(); }, 0); const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    api<{ csrf?: string }>("/api/session").then((s) => setCsrf(s.csrf ?? null)).catch(() => undefined);
    return () => { window.clearTimeout(t); window.clearInterval(timer); };
  }, [load]);
  // Open a window on arrival so the page is never empty: the one used last, else the active window of the first session.
  useEffect(() => {
    if (target || !listing) return;
    const all = listing.sessions.flatMap((s) => s.windows.map((w) => ({ session: s.session, window: w.name, active: w.active })));
    if (!all.length) return;
    let saved: Target | null = null;
    try { saved = JSON.parse(window.localStorage.getItem("jobber.terminal") ?? "null") as Target | null; } catch { /* storage unavailable */ }
    const pick = all.find((w) => saved && w.session === saved.session && w.window === saved.window) ?? all.find((w) => w.active) ?? all[0];
    setTarget({ session: pick.session, window: pick.window }); // eslint-disable-line react-hooks/set-state-in-effect
  }, [listing, target]);
  useEffect(() => {
    if (!target) return;
    try { window.localStorage.setItem("jobber.terminal", JSON.stringify(target)); } catch { /* storage unavailable */ }
  }, [target]);
  const onState = useCallback((c: Conn) => setConn(c), []);
  const any = listing?.sessions.some((s) => s.windows.length > 0) ?? false;
  return <Panel title="Live terminal">
    {error ? <div className="notice danger"><strong>Could not load sessions.</strong><br />{error}</div> : null}
    {!listing && !error ? <LoadingLines /> : null}
    {listing && !listing.tmux ? <div className="empty-state"><h3>tmux is not available</h3>The dashboard host cannot run tmux, so there is nothing to show. Install tmux and start the stack with <code>npm start</code>.</div> : null}
    {listing && listing.tmux && !any ? <div className="empty-state"><h3>No Jobber sessions are running</h3>Start them with <code>npm start</code>. Only Jobber tmux sessions are ever listed here.</div> : null}
    {listing && listing.killed ? <div className="notice warning"><strong>Kill switch is on.</strong><br />Live output is stopped until the owner resumes.</div> : null}
    {listing && any ? <div className="term-layout">
      <nav className="term-tabs" aria-label="Jobber tmux windows">
        {listing.sessions.filter((s) => s.windows.length).map((s) => <div key={s.session} className="term-group"><span className="term-session">{s.session}</span>
          {s.windows.map((w) => { const on = target?.session === s.session && target.window === w.name; return <button key={w.name} type="button" className={`term-tab${on ? " active" : ""}`} aria-pressed={on} onClick={() => { setTarget({ session: s.session, window: w.name }); setConn("connecting"); }}>{w.name}<small>{w.command}</small></button>; })}</div>)}
      </nav>
      <div className="term-main">
        {target ? <>
          <div className="term-head"><strong>{target.session} / {target.window}</strong><span className="term-badges"><Badge tone={conn === "live" ? "good" : conn === "failed" || conn === "killed" ? "bad" : "warn"}>{CONN_TEXT[conn]}</Badge>
            {listing.inputEnabled ? <Badge tone="bad">Input enabled</Badge> : <Badge>View only</Badge>}</span></div>
          <TerminalPane key={`${target.session}:${target.window}`} target={target} inputEnabled={listing.inputEnabled} csrf={csrf} onState={onState} />
          {conn === "ended" ? <p className="muted">This window no longer exists. Pick another one.</p> : null}
        </> : <div className="empty-state"><h3>Pick a window</h3>Choose a session window on the left to watch it live.{listing.inputEnabled ? " Typing is enabled for this dashboard." : " The terminal is view only."}</div>}
      </div>
    </div> : null}
  </Panel>;
}
