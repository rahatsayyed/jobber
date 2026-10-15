// Shared two-pass gate for one untrusted free-text field (LinkedIn and Naukri state text).
import { gateInput } from './inputGate.js';

/** Neutralize anything in page text that could close or fake our delimiter block. */
export function sanitize(s: string): string {
  return s.replace(/[<>]{3,}/g, ' ').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Two-pass gate for one untrusted free-text field: gate strips invisibles (NEL, LS, PS and C1
 * controls become spaces first), whitespace is collapsed, then the result is gated again, so
 * neither order can hide a phrase. Returns capped text, or blocked with empty text.
 */
export function gateField(s: string, max: number): { text: string; blocked: boolean; flags: string[] } {
  // NEL, LS and PS are line breaks (so a leading `system:` role prefix still matches); other C1 controls become spaces.
  const pre = s.replace(new RegExp("[\\u0085\\u2028\\u2029]", "g"), "\n").replace(new RegExp("[\\u0080-\\u009f]", "g"), " ");
  const g1 = gateInput(pre, { maxChars: max });
  const norm = sanitize(g1.text);
  const g2 = gateInput(norm, { maxChars: max });
  const flags = [...g1.flags, ...g2.flags];
  if (g1.blocked || g2.blocked) return { text: '', blocked: true, flags };
  const t = sanitize(g2.text);
  return { text: t.length > max ? t.slice(0, max - 1) + '…' : t, blocked: false, flags };
}
