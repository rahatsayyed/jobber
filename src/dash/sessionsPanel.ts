// src/dash/sessionsPanel.ts
// Read-only view of the tmux sessions: windows plus the last non-empty pane line. Never starts a tmux server.
import { assertName, capture, listWindows, type Run } from '../platform/tmux.js';
import { cleanText } from './clean.js';

export interface SessionLine {
  window: string;
  index: number;
  command: string;
  active: boolean;
  lastLine: string;
}

function validName(n: string): boolean {
  try {
    assertName(n);
    return true;
  } catch {
    return false;
  }
}

export async function sessionsPanel(
  run: Run,
  sessions: string[],
  capLines = 20,
): Promise<{ session: string; up: boolean; windows: SessionLine[] }[]> {
  const out: { session: string; up: boolean; windows: SessionLine[] }[] = [];
  for (const session of sessions) {
    if (!validName(session)) {
      out.push({ session: cleanText(session, 64), up: false, windows: [] });
      continue;
    }
    let wins: Awaited<ReturnType<typeof listWindows>> = [];
    try {
      wins = await listWindows(run, session);
    } catch {
      wins = [];
    }
    const windows: SessionLine[] = [];
    for (const w of wins) {
      if (!validName(w.name)) continue;
      let lastLine = '';
      try {
        const pane = await capture(run, session, w.name, capLines);
        const lines = pane.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
        lastLine = cleanText(lines[lines.length - 1] ?? '', 200);
      } catch {
        lastLine = '';
      }
      windows.push({
        window: cleanText(w.name, 64),
        index: w.index,
        command: cleanText(w.command, 64),
        active: w.active,
        lastLine,
      });
    }
    out.push({ session, up: wins.length > 0, windows });
  }
  return out;
}
