// Pure Wellfound snapshot parsers (inbox rows). No browser: the MCP layer hands over plain objects.
import { gateInput } from '../safety/inputGate.js';

export interface RawThread {
  threadRef: string; sender: string; company?: string; preview: string; unread: boolean; at?: string;
}

const PREVIEW_MAX = 220;

const clean = (s: unknown, max = 300): string | null => {
  if (typeof s !== 'string') return null;
  const g = gateInput(s.trim(), { maxChars: max });
  if (g.blocked) return null;
  const t = g.text.trim();
  return t.length ? t : null;
};

export function parseInbox(threads: RawThread[], max: number): RawThread[] {
  const out: RawThread[] = [];
  const limit = Number.isFinite(max) ? Math.max(0, Math.trunc(max)) : 0;
  for (const t of Array.isArray(threads) ? threads : []) {
    if (out.length >= limit) break;
    if (!t || typeof t.threadRef !== 'string' || !t.threadRef) continue;
    const g = gateInput(String(t.preview ?? ''), { maxChars: PREVIEW_MAX });
    const preview = g.blocked ? '[blocked]' : g.text.slice(0, PREVIEW_MAX);
    out.push({
      threadRef: t.threadRef,
      sender: clean(t.sender, 120) ?? '',
      ...(t.company !== undefined ? { company: clean(t.company, 120) ?? '' } : {}),
      preview,
      unread: Boolean(t.unread),
      ...(t.at !== undefined ? { at: String(t.at) } : {}),
    });
  }
  return out;
}
