"use client";

import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { api, apiPost } from "@/lib/dashboard-api";
import { clockTime, frameToTerminal, paneLooksCleared, reconnectDelay, TERMINAL_HELPER_KEYS, TerminalFrame, windowLabel } from "@/lib/view-models";
import { Badge, LoadingLines, Panel } from "@/components/dashboard/list-kit";

type Win = { name: string; index: number; active: boolean; command: string; cols?: number; rows?: number };
type Listing = { tmux: boolean; inputEnabled: boolean; killed: boolean; sessions: { session: string; up: boolean; windows: Win[] }[] };
type Target = { session: string; window: string; index: number };
/** What the live pane reports to the page: history lines, whether it looks cleared, size and when the stream last spoke. */
type PaneInfo = { history: number; cleared: boolean; cols: number; rows: number; at: Date | null };
const query = (t: Target) => `session=${encodeURIComponent(t.session)}&window=${encodeURIComponent(t.window)}&index=${t.index}`;
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

/** The font that fits `term.cols` columns into the box; never below 8px (11px on a phone, where the box scrolls inside itself). */
function fitFont(term: Terminal, el: HTMLElement) {
  const floor = window.innerWidth <= 760 ? 11 : 8;
  const fs = Math.max(floor, Math.min(13, Math.floor((el.clientWidth - 20) / (term.cols * 0.6))));
  if (term.options.fontSize !== fs) term.options.fontSize = fs;
}

/** Read-only scrollback of one window (last 500 lines), loaded once and drawn as plain text in its own xterm. */
function HistoryView({ target, cols, onBack }: { target: Target; cols: number; onBack: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; lines: number }>({ kind: "loading" });
  useEffect(() => {
    let disposed = false; let term: Terminal | null = null; let sizeObs: ResizeObserver | undefined;
    (async () => {
      try {
        const res = await api<{ text: string; lines: number }>(`/api/terminal/history?${query(target)}`);
        const { Terminal: XTerm } = await import("@xterm/xterm");
        if (disposed || !host.current) return;
        const lines = res.text ? res.text.split("\n") : [];
        term = new XTerm({ cols: Math.max(20, cols), rows: Math.max(5, Math.min(lines.length, 60)), scrollback: lines.length + 50, cursorBlink: false, cursorInactiveStyle: "none", disableStdin: true, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: xtermTheme(), allowProposedApi: false });
        term.open(host.current);
        sizeObs = new ResizeObserver(() => { if (term && host.current) fitFont(term, host.current); }); sizeObs.observe(host.current);
        term.write(lines.map((l) => `${l}\x1b[0m`).join("\r\n"), () => { if (host.current) host.current.scrollTop = host.current.scrollHeight; });
        setState({ kind: "ready", lines: lines.length });
      } catch (e) {
        if (!disposed) setState({ kind: "error", message: e instanceof Error ? e.message : "History could not be loaded." });
      }
    })();
    return () => { disposed = true; sizeObs?.disconnect(); term?.dispose(); };
  }, [target, cols]);
  return <div className="term-history">
    <div className="term-tools">
      <button type="button" className="button primary" onClick={onBack}>Back to live</button>
      <span className="muted">{state.kind === "loading" ? "Loading history" : state.kind === "ready" ? `History: last ${state.lines} lines, read only` : "History unavailable"}</span>
    </div>
    {state.kind === "error" ? <div className="notice danger" role="alert"><strong>Could not load history.</strong><br />{state.message}</div> : null}
    <div className="term-wrap"><div ref={host} className="term-host" role="log" aria-label={`History ${windowLabel(target.session, target.index, target.window)}`} /></div>
  </div>;
}

function TerminalPane({ target, inputOn, csrf, hidden, onState, onInfo }: { target: Target; inputOn: boolean; csrf: string | null; hidden: boolean; onState: (c: Conn) => void; onInfo: (patch: Partial<PaneInfo>) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const inputRef = useRef(inputOn);
  const [retry, setRetry] = useState(0);
  const [sendError, setSendError] = useState(false);
  const post = useCallback((keys: string) => {
    if (!keys) return;
    apiPost("/api/terminal/input", { session: target.session, window: target.window, index: target.index, keys }, csrf).then(() => setSendError(false)).catch(() => setSendError(true));
  }, [target.session, target.window, target.index, csrf]);
  const postRef = useRef(post);
  useEffect(() => { postRef.current = post; }, [post]);
  // The Input switch only flips xterm's stdin gate and the focus; the terminal itself is not rebuilt.
  useEffect(() => {
    inputRef.current = inputOn;
    const t = termRef.current;
    if (t) { t.options.disableStdin = !inputOn; if (inputOn) t.focus(); }
  }, [inputOn]);
  useEffect(() => {
    let disposed = false; let term: Terminal | null = null; let es: EventSource | null = null; let timer: number | undefined; let attempt = 0;
    let pending = ""; let flush: number | undefined; let themeObs: MutationObserver | undefined; let sizeObs: ResizeObserver | undefined;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const retheme = () => { if (term) term.options.theme = xtermTheme(); };
    const sendKeys = () => {
      flush = undefined; const keys = pending; pending = ""; if (!keys) return;
      postRef.current(keys);
    };
    /** The tmux pane can be far wider than the page: shrink the font so all columns fit, never below 8px. */
    const fit = () => { if (term && host.current) fitFont(term, host.current); };
    const toBottom = () => { if (host.current) host.current.scrollTop = host.current.scrollHeight; };
    const connect = () => {
      if (disposed) return;
      onState(attempt === 0 ? "connecting" : "reconnecting");
      es = new EventSource(`/api/terminal/stream?${query(target)}`);
      es.addEventListener("hello", () => { attempt = 0; onState("live"); onInfo({ at: new Date() }); });
      es.addEventListener("ping", () => onInfo({ at: new Date() }));
      es.addEventListener("frame", (ev) => {
        if (!term) return;
        try {
          const f = JSON.parse((ev as MessageEvent<string>).data) as TerminalFrame;
          onInfo({ history: f.history ?? 0, cleared: paneLooksCleared(f.text), cols: f.cols, rows: f.rows, at: new Date() });
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
      term = new XTerm({ cols: 100, rows: 30, scrollback: 0, cursorBlink: false, disableStdin: !inputRef.current, fontSize: 12, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', theme: xtermTheme(), allowProposedApi: false });
      termRef.current = term;
      term.open(host.current);
      if (inputRef.current) term.focus();
      sizeObs = new ResizeObserver(fit); sizeObs.observe(host.current);
      term.onData((d) => { if (!inputRef.current) return; pending += d; if (flush === undefined) flush = window.setTimeout(sendKeys, 60); });
      themeObs = new MutationObserver(retheme);
      themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
      media.addEventListener("change", retheme);
      connect();
    })();
    return () => {
      disposed = true; if (timer) window.clearTimeout(timer); if (flush) window.clearTimeout(flush);
      es?.close(); themeObs?.disconnect(); sizeObs?.disconnect(); media.removeEventListener("change", retheme); term?.dispose(); termRef.current = null;
    };
  }, [target, onState, onInfo, retry]);
  return <div hidden={hidden}>
    <div className="term-wrap"><div ref={host} className="term-host" role="log" aria-label={`Terminal ${target.session} ${target.window}`} />
      <button type="button" className="button term-retry" onClick={() => setRetry((n) => n + 1)}>Reconnect</button></div>
    {inputOn ? <div className="term-keys" role="group" aria-label="Send keys">
      <span className="muted">Send keys</span>
      {TERMINAL_HELPER_KEYS.map((k) => <button key={k.label} type="button" className="button" onClick={() => { post(k.keys); termRef.current?.focus(); }}>{k.label}</button>)}
      {sendError ? <span className="muted" role="alert">Could not send. Check the connection or the kill switch.</span> : null}
    </div> : null}
  </div>;
}

export function SessionsView() {
  const [listing, setListing] = useState<Listing | null>(null); const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null); const [conn, setConn] = useState<Conn>("connecting"); const [csrf, setCsrf] = useState<string | null>(null);
  const [inputOn, setInputOn] = useState(false); // Off on every page load, by design
  const [showHistory, setShowHistory] = useState(false);
  const [info, setInfo] = useState<PaneInfo>({ history: 0, cleared: false, cols: 100, rows: 30, at: null });
  const onInfo = useCallback((patch: Partial<PaneInfo>) => setInfo((p) => ({ ...p, ...patch })), []);
  const pick = useCallback((t: Target) => { setTarget(t); setConn("connecting"); setShowHistory(false); setInfo({ history: 0, cleared: false, cols: 100, rows: 30, at: null }); }, []);
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
    const all = listing.sessions.flatMap((s) => s.windows.map((w) => ({ session: s.session, window: w.name, index: w.index, active: w.active })));
    if (!all.length) return;
    let saved: Partial<Target> | null = null;
    try { saved = JSON.parse(window.localStorage.getItem("jobber.terminal") ?? "null") as Partial<Target> | null; } catch { /* storage unavailable */ }
    const first = all.find((w) => saved && w.session === saved.session && w.window === saved.window && w.index === saved.index) ?? all.find((w) => saved && w.session === saved.session && w.window === saved.window) ?? all.find((w) => w.window === "hunt") ?? all.find((w) => w.active) ?? all[0];
    setTarget({ session: first.session, window: first.window, index: first.index }); // eslint-disable-line react-hooks/set-state-in-effect
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
          {s.windows.map((w) => { const on = target?.session === s.session && target.window === w.name && target.index === w.index; return <button key={w.index} type="button" className={`term-tab${on ? " active" : ""}`} aria-pressed={on} onClick={() => pick({ session: s.session, window: w.name, index: w.index })}>{windowLabel(s.session, w.index, w.name)}<small>{w.command}{w.cols && w.rows ? ` ${w.cols}x${w.rows}` : ""}</small></button>; })}</div>)}
      </nav>
      <div className="term-main">
        {target ? <>
          <div className="term-head"><strong>{windowLabel(target.session, target.index, target.window)}<small className="term-meta">{listing.sessions.find((s) => s.session === target.session)?.windows.find((w) => w.index === target.index)?.command ?? ""} {info.at ? `${info.cols}x${info.rows}` : ""}</small></strong><span className="term-badges"><Badge tone={conn === "live" ? "good" : conn === "failed" || conn === "killed" ? "bad" : "warn"}>{CONN_TEXT[conn]}</Badge>
            {listing.inputEnabled && inputOn ? <Badge tone="bad">Input enabled</Badge> : <Badge>View only</Badge>}
            {listing.inputEnabled
              ? <label className="check input-switch"><input type="checkbox" role="switch" checked={inputOn} onChange={(e) => setInputOn(e.target.checked)} disabled={listing.killed} /> Input {inputOn ? "On" : "Off"}</label>
              : <span className="muted" title="WEB_TERMINAL_INPUT=false on the server">Input is turned off on the server</span>}</span></div>
          <p className="muted term-updated" aria-live="off">Last update {info.at ? clockTime(info.at) : "none yet"}</p>
          {!showHistory && info.at && info.cleared ? <div className="term-hint" role="status">
            <span>Pane looks cleared or idle. {info.history} {info.history === 1 ? "line" : "lines"} of history above.</span>
            {info.history > 0 ? <button type="button" className="button" onClick={() => setShowHistory(true)}>History</button> : null}
          </div> : null}
          {!showHistory && !(info.at && info.cleared) && info.history > 0 ? <div className="term-tools"><button type="button" className="button" onClick={() => setShowHistory(true)}>Show history</button></div> : null}
          {showHistory ? <HistoryView key={`h${target.session}:${target.index}`} target={target} cols={info.cols} onBack={() => setShowHistory(false)} /> : null}
          <TerminalPane key={`${target.session}:${target.index}:${target.window}`} target={target} inputOn={listing.inputEnabled && inputOn && !listing.killed} csrf={csrf} hidden={showHistory} onState={onState} onInfo={onInfo} />
          {conn === "ended" ? <p className="muted">This window no longer exists. Pick another one.</p> : null}
        </> : <div className="empty-state"><h3>Pick a window</h3>Choose a session window in the list above to watch it live.{listing.inputEnabled ? " Turn the Input switch On to type; it is Off every time you open this page." : " The terminal is view only."}</div>}
      </div>
    </div> : null}
  </Panel>;
}
