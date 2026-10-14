import { readFileSync } from 'node:fs';
// @ts-ignore: import the lib file directly to avoid pdf-parse's debug side effect
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

const DASHES = '‐‑‒–—―−';
const YEAR = '(?<!\\d)(?:19|20)\\d{2}(?!\\d)';
const DATE_DASH = new RegExp(`${YEAR}[^\\S\\n]*[${DASHES}]|[${DASHES}][^\\S\\n]*${YEAR}`);

const fold = (s: string) => s.normalize('NFC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').toLowerCase();

export interface PdfCheckOpts {
  pages: number;
  mustContain: string[];
  /** Entries compared by digits only (e.g. phone numbers), tolerant of formatting. */
  digitsContain?: string[];
  minChars?: number;
}

export function checkText(text: string, numPages: number, opts: PdfCheckOpts): string[] {
  const fails: string[] = [];
  if (numPages !== opts.pages) fails.push(`expected ${opts.pages} pages, got ${numPages}`);
  if (text.trim().length < (opts.minChars ?? 200)) fails.push('text layer empty or too short (image-only PDF?)');
  const folded = fold(text);
  for (const raw of opts.mustContain) {
    if (raw == null || raw === '') continue;
    const s = String(raw);
    if (!folded.includes(fold(s))) fails.push(`missing literal text: ${s}`);
  }
  const textDigits = text.replace(/\D/g, '');
  for (const s of opts.digitsContain ?? []) {
    const d = String(s ?? '').replace(/\D/g, '');
    if (d && !textDigits.includes(d)) fails.push(`missing digits: ${s}`);
  }
  if (/\(cid:\d+\)/.test(text)) fails.push('garbled glyph markers (cid:NNN) in text layer');
  if (text.includes('�')) fails.push('replacement characters in text layer');
  return fails;
}

/** Non-blocking findings: logged by verifyPdf, never thrown. */
export function checkWarnings(text: string): string[] {
  const warnings: string[] = [];
  if (DATE_DASH.test(text)) warnings.push('date range uses a non-ASCII dash, which some ATS importers may drop');
  return warnings;
}

export interface PdfLayout { pages: number; fillRatio: number | null }

/** Page count plus the last page's text extent / page height (same proxy as the eval's fillRatio; base resume ~0.90). */
export async function pdfLayout(pdfPath: string): Promise<PdfLayout> {
  let top = -Infinity;
  let bottom = Infinity;
  let height = 0;
  // pdf-parse renders pages one after another, so the values left at the end belong to the last page.
  const pagerender = (pd: any) => pd.getTextContent().then((tc: any) => {
    top = -Infinity; bottom = Infinity; height = pd.getViewport(1.0).height;
    let s = '';
    for (const it of tc.items) {
      if (!String(it.str).trim()) continue;
      const y = it.transform[5];
      bottom = Math.min(bottom, y);
      top = Math.max(top, y + (it.height || 0));
      s += `${it.str} `;
    }
    return s;
  });
  const data = await pdfParse(Uint8Array.from(readFileSync(pdfPath)), { pagerender });
  const fillRatio = height && Number.isFinite(top) && Number.isFinite(bottom) ? (top - bottom) / height : null;
  return { pages: data.numpages as number, fillRatio };
}

export async function verifyPdf(pdfPath: string, opts: PdfCheckOpts): Promise<void> {
  // Copy into a standalone Uint8Array: small Buffers live in Node's shared 8KB pool and
  // pdf.js ignores byteOffset, so it would otherwise read unrelated bytes.
  const data = await pdfParse(Uint8Array.from(readFileSync(pdfPath)));
  const fails = checkText(data.text, data.numpages, opts);
  // stderr only: MCP servers use stdout for the protocol.
  for (const w of checkWarnings(data.text)) console.error(`[pdfVerify] warning: ${w}`);
  if (fails.length) throw new Error(`PDF verification failed: ${fails.join('; ')}`);
}
