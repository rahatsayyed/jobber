"use client";

import { useCallback, useEffect, useState } from "react";
import { api, readableTime } from "@/lib/dashboard-api";
import { Badge, FilterSelect, LoadingLines, Panel, Toolbar } from "@/components/dashboard/list-kit";

type Notice = { id: string; at: string; topic: string; urgency: "loud" | "silent"; title: string; text: string };
type NoticeList = { notices: Notice[]; topics: string[] };

/** "just now", "5 min ago", "3 h ago", "2 d ago". The exact time is in the tooltip. */
function relativeTime(iso: string, nowMs: number): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const sec = Math.max(0, Math.round((nowMs - t) / 1000));
  if (sec < 45) return "just now";
  if (sec < 3600) return `${Math.max(1, Math.round(sec / 60))} min ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86_400)} d ago`;
}

/** Everything the code sent to Telegram, as plain text, newest first. Text is rendered as text only. */
export function NoticesView() {
  const [topic, setTopic] = useState("");
  const [data, setData] = useState<NoticeList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = `/api/notices?limit=100${topic ? `&topic=${encodeURIComponent(topic)}` : ""}`;
      setData(await api<NoticeList>(q)); setError(null); setNowMs(Date.now());
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The notices could not be loaded."); }
    finally { setLoading(false); }
  }, [topic]);
  useEffect(() => {
    const initial = window.setTimeout(() => { void load(); }, 0);
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); };
  }, [load]);
  const topics = data?.topics ?? ["alerts", "wakes", "inbox", "assist", "chat", "mail", "linkedin"];
  return <Panel title="Notices" toolbar={<Toolbar onReload={() => void load()} loading={loading}>
    <FilterSelect label="Topic" value={topic} onChange={setTopic} options={[{ value: "", label: "All topics" }, ...topics.map((t) => ({ value: t, label: t }))]} />
  </Toolbar>}>
    <p className="muted">A copy of every notice the code sent to Telegram, newest first. Refreshes every 30 seconds.</p>
    <div aria-live="polite">
      {error ? <div className="notice danger"><strong>Could not load the notices.</strong><br />{error}</div> : null}
      {!data && !error ? <div className="object-list"><LoadingLines /></div> : null}
      {data && !data.notices.length && !error ? <div className="empty-state"><h3>No notices yet</h3>Notices show here as soon as the code sends one to Telegram.</div> : null}
      {data?.notices.length ? <div className="object-list">{data.notices.map((n) => {
        const body = n.text.startsWith(n.title) ? n.text.slice(n.title.length).trim() : n.text;
        return <div className="object-row" key={n.id}>
          <div style={{ minWidth: 0 }}>
            <strong>{n.urgency === "loud" ? "🔔 " : ""}{n.title || "(no text)"}</strong>
            {body ? <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{body}</p> : null}
            <p><time dateTime={n.at} title={readableTime(n.at)}>{relativeTime(n.at, nowMs)}</time></p>
          </div>
          <span><Badge tone={n.urgency === "loud" ? "warn" : ""}>{n.topic}</Badge></span>
        </div>;
      })}</div> : null}
    </div>
  </Panel>;
}
