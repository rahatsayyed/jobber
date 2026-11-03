// src/telegram/windows/view.ts
// Pure rendering of a live tmux window view for Telegram: text (HTML) and the inline keyboard. No I/O.
import { htmlEscape } from '../format.js';

export const VIEW_LINES = 35;
export const LINE_CLIP = 100;
export const MESSAGE_CAP = 3800;

export interface InlineButton { text: string; callback_data: string }
export type Keyboard = InlineButton[][];

// CSI, OSC and single-char escape sequences, then any remaining control characters except newline.
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-Z\\-_]|\x1b/g;
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\x00-\x09\x0b-\x1f\x7f-\x9f]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '').replace(/\r/g, '').replace(CTRL_RE, '');
}

const clip = (line: string): string => (Array.from(line).length > LINE_CLIP ? `${Array.from(line).slice(0, LINE_CLIP - 1).join('')}…` : line);

/** Visible lines of a captured (already redacted) pane: ANSI stripped, trailing blanks trimmed, last VIEW_LINES, clipped. */
export function paneLines(text: string): string[] {
  const lines = stripAnsi(text).split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-VIEW_LINES).map(clip);
}

/** HH:MM:SS in IST. */
export function istTime(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
}

export type ViewMode = 'live' | 'paused';

export interface HeaderInfo {
  window: string;
  session: string;
  running: boolean;
  at: Date;
  mode: ViewMode;
  inputEnabled: boolean;
  protectedWindow: boolean;
}

export function header(h: HeaderInfo): string {
  const dot = h.running ? '🟢' : '🔴';
  const state = h.mode === 'live' ? 'live' : 'paused, tap Refresh';
  const input = h.inputEnabled && !h.protectedWindow ? '' : ' · view only';
  return `${dot} <b>${htmlEscape(h.window)}</b> · ${htmlEscape(h.session)} · ${istTime(h.at)} IST · ${state}${input}`;
}

/** Whole view message, at most MESSAGE_CAP characters: the oldest lines are dropped until it fits. */
export function renderView(h: HeaderInfo, paneText: string): string {
  const head = header(h);
  let lines = paneLines(paneText);
  const build = (ls: string[]): string => `${head}\n<pre>${ls.length ? ls.map(htmlEscape).join('\n') : '(empty screen)'}</pre>`;
  let out = build(lines);
  while (out.length > MESSAGE_CAP && lines.length > 1) {
    lines = lines.slice(1);
    out = build(lines);
  }
  if (out.length > MESSAGE_CAP) out = build([lines[0]?.slice(0, 200) ?? '']);
  return out;
}

/** Key codes of the input buttons: code -> label and the tmux send-keys arguments (after -t target). */
export const INPUT_KEYS: Record<string, { label: string; args: string[] }> = {
  en: { label: 'Enter', args: ['Enter'] },
  es: { label: 'Esc', args: ['Escape'] },
  ta: { label: 'Tab', args: ['Tab'] },
  cc: { label: 'Ctrl+C', args: ['C-c'] },
  up: { label: 'Up', args: ['Up'] },
  dn: { label: 'Down', args: ['Down'] },
  lf: { label: 'Left', args: ['Left'] },
  rt: { label: 'Right', args: ['Right'] },
  ky: { label: 'y', args: ['-l', '--', 'y'] },
  kn: { label: 'n', args: ['-l', '--', 'n'] },
  k1: { label: '1', args: ['-l', '--', '1'] },
  k2: { label: '2', args: ['-l', '--', '2'] },
  k3: { label: '3', args: ['-l', '--', '3'] },
};

export const cb = (act: string, id: string): string => `w|${act}|${id}`;

export function viewKeyboard(viewId: string, mode: ViewMode, showInput: boolean): Keyboard {
  const kb: Keyboard = [[
    { text: 'Refresh', callback_data: cb('r', viewId) },
    { text: mode === 'live' ? 'Pause' : 'Resume', callback_data: cb('p', viewId) },
    { text: 'Close view', callback_data: cb('c', viewId) },
  ]];
  if (showInput) {
    const row = (codes: string[]): InlineButton[] => codes.map((c) => ({ text: INPUT_KEYS[c]!.label, callback_data: cb(`k${c}`, viewId) }));
    kb.push(row(['en', 'es', 'ta', 'cc']), row(['up', 'dn', 'lf', 'rt']), row(['ky', 'kn', 'k1', 'k2', 'k3']));
  }
  return kb;
}

const BAD_RANGES: [number, number][] = [[0, 0x1f], [0x7f, 0x9f], [0x2028, 0x2029], [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];

/** Strip control and invisible-format characters from typed text; newlines and tabs become spaces. */
export function cleanTyped(s: string): string {
  let out = '';
  for (const ch of s.replace(/[\r\n\t]+/g, ' ')) {
    const c = ch.codePointAt(0) as number;
    if (!BAD_RANGES.some(([a, b]) => c >= a && c <= b)) out += ch;
  }
  return out;
}

