// src/dash/clean.ts
// Cleaning for untrusted text (postings, mail, model output) before it reaches the dashboard. Pure, no I/O.
import { FORMAT_CHARS } from '../atsText.js';
import { redactSecrets } from '../safety/redact.js';

// C0 and C1 controls except \n (0x0A) and \t (0x09).
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const BIDI = /[‪-‮⁦-⁩]/g;

export function cleanText(s: unknown, maxLen: number): string {
  if (typeof s !== 'string') return '';
  let t = s.replace(/\r\n?/g, '\n').replace(CONTROLS, '').replace(BIDI, '').replace(FORMAT_CHARS, '');
  t = t.replace(/\n{3,}/g, '\n\n');
  t = redactSecrets(t);
  if (t.length > maxLen) t = maxLen > 3 ? t.slice(0, maxLen - 3) + '...' : t.slice(0, Math.max(0, maxLen));
  return t;
}

export function cleanRow<T extends Record<string, unknown>>(row: T, limits: Record<string, number>, defaultMax = 2000): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'string' ? cleanText(v, limits[k] ?? defaultMax) : v;
  return out as T;
}
