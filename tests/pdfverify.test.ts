import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkText, checkWarnings, verifyPdf } from '../src/pdfVerify.js';

const ok = 'Test User test@example.com +91 90000 00000 Engineer Jan 2022 - Present '.repeat(5);
const opts = { pages: 1, mustContain: ['Test User', 'test@example.com', '+91 90000 00000'] };

describe('checkText', () => {
  it('passes a clean one-page layer', () => { expect(checkText(ok, 1, opts)).toEqual([]); });
  it('coerces non-string mustContain/digitsContain entries instead of throwing', () => {
    const bad = { pages: 1, mustContain: [12345 as any, { a: 1 } as any], digitsContain: [9876543210 as any] };
    let out: string[] = [];
    expect(() => { out = checkText(ok, 1, bad); }).not.toThrow();
    expect(out.join()).toMatch(/missing literal text: 12345/);
    expect(out.join()).toMatch(/missing digits: 9876543210/);
    expect(checkText(ok, 1, { pages: 1, mustContain: [null as any, undefined as any], digitsContain: [null as any] })).toEqual([]);
  });
  it('fails on wrong page count', () => { expect(checkText(ok, 2, opts)[0]).toMatch(/pages/); });
  it('fails closed on an empty text layer', () => { expect(checkText('', 1, opts).join()).toMatch(/text layer/); });
  it('fails when email is missing as literal text', () => {
    expect(checkText(ok.replaceAll('test@example.com', ''), 1, opts).join()).toMatch(/test@example.com/);
  });
  it('flags cid markers and replacement chars', () => {
    expect(checkText(ok + '(cid:123)', 1, opts).join()).toMatch(/cid/);
    expect(checkText(ok + '�', 1, opts).join()).toMatch(/replacement/);
  });
  it('does not block on a unicode dash joined to a year, but warns', () => {
    expect(checkText(ok + ' 2021–2023', 1, opts)).toEqual([]);
    expect(checkWarnings(ok + ' 2021–2023').join()).toMatch(/date/i);
  });
  it('does not block a real-looking en-dash date line', () => {
    expect(checkText(ok + ' Konma DaoFeb 2023 – Jun 2025', 1, opts)).toEqual([]);
  });
  it('has no warnings for ASCII hyphen dates', () => { expect(checkWarnings(ok)).toEqual([]); });
});

describe('checkText digitsContain', () => {
  const base = 'Test User test@example.com +91 (900) 000-0000 Engineer '.repeat(5);
  const o = { pages: 1, mustContain: ['Test User'], digitsContain: ['+919000000000'] };
  it('passes when phone has different spacing/punctuation', () => {
    expect(checkText(base, 1, o)).toEqual([]);
  });
  it('fails when the digits are absent', () => {
    expect(checkText(base.replace(/\+91 \(900\) 000-0000/g, ''), 1, o).join()).toMatch(/missing digits/);
  });
  it('is a no-op for empty or non-digit entries', () => {
    expect(checkText(base, 1, { ...o, digitsContain: ['', 'n/a'] })).toEqual([]);
  });
});

function makePdf(lines: string[], pageCount = 1): Buffer {
  const objs: string[] = [];
  const kids = Array.from({ length: pageCount }, (_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const content = 'BT /F1 10 Tf 12 TL 20 700 Td ' + lines.map((l) => `(${l}) Tj T*`).join(' ') + ' ET';
  for (let i = 0; i < pageCount; i++) {
    const p = 4 + i * 2;
    objs[p] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${p + 1} 0 R >>`;
    objs[p + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
  }
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = out.length;
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \r\n`;
  for (let i = 1; i < objs.length; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \r\n`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

describe('verifyPdf (real pdf-parse on a synthetic PDF)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pdfverify-'));
  const write = (name: string, buf: Buffer) => { const p = path.join(dir, name); writeFileSync(p, buf); return p; };
  const lines = Array.from({ length: 6 }, () => 'Test User test@example.com +91 (900) 000-0000 Engineer Jan 2022 - Present');
  const o = { pages: 1, mustContain: ['Test User', 'test@example.com'], digitsContain: ['+919000000000'] };

  it('passes a good one-page PDF', async () => {
    await expect(verifyPdf(write('good.pdf', makePdf(lines)), o)).resolves.toBeUndefined();
  });
  it('throws on wrong page count', async () => {
    await expect(verifyPdf(write('two.pdf', makePdf(lines, 2)), o)).rejects.toThrow(/PDF verification failed/);
  });
  it('throws on missing text', async () => {
    await expect(verifyPdf(write('miss.pdf', makePdf(lines)), { ...o, mustContain: ['Nobody Else'] })).rejects.toThrow(/PDF verification failed/);
  });
});
