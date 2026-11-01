export interface Snapshot {
  generatedAt: string;
  ceilings: Record<string, { used: number; limit: number; ok: boolean }>;
  halts: { platform: string; reason: string; setAt: string }[];
  queue: { status: string; count: number }[];
  funnel: Record<string, number>;
  lastSend: { kind: string; at: string } | null;
  degraded: string[];
}

export interface WorkspaceItem {
  id?: string | number;
  title?: string;
  company?: string;
  senderName?: string;
  platform?: string;
  status?: string;
  outcome?: string;
  kind?: string;
  created_at?: string;
  createdAt?: string;
  [key: string]: unknown;
}

export async function api<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(response.status === 401 ? "Sign in is required." : "The dashboard data could not be loaded.");
  }
  return response.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown, csrf: string | null): Promise<T> {
  const response = await fetch(path, {
    method: "POST", cache: "no-store", credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "Sign in is required." : response.status === 403 ? "Not allowed." : "The request failed.");
  return response.json() as Promise<T>;
}

export function readableTime(value?: string | null): string {
  if (!value) return "Not recorded";
  // SQLite stores `YYYY-MM-DD HH:MM:SS` in UTC with no zone; JavaScript would read it as local time and show the wrong hour.
  const date = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value);
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function labelFor(item: WorkspaceItem): string {
  if (item.title && item.company) return `${item.title} at ${item.company}`;
  return String(item.title ?? item.senderName ?? item.platform ?? item.outcome ?? item.kind ?? item.status ?? item.id ?? "Untitled item");
}

export function detailFor(item: WorkspaceItem): string {
  const values = [item.platform, item.status, item.created_at ?? item.createdAt].filter(Boolean).map(String);
  return values.length ? values.join(" · ") : "No additional detail";
}
