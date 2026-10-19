import { describe, it, expect } from 'vitest';
import { htmlToPdf } from '../src/pdfRender.js';
import type { LiLauncher } from '../src/linkedin/types.js';

function fake(opts: { pdfThrows?: boolean } = {}) {
  const seen = { launch: undefined as Record<string, unknown> | undefined, ctx: undefined as Record<string, unknown> | undefined,
    goto: [] as Array<{ url: string; opts: unknown }>, pdf: [] as unknown[], closed: false };
  const launcher = {
    launch: async (o: Record<string, unknown>) => {
      seen.launch = o;
      return {
        newContext: async (c: Record<string, unknown>) => {
          seen.ctx = c;
          return {
            newPage: async () => ({
              goto: async (url: string, o2: unknown) => { seen.goto.push({ url, opts: o2 }); },
              pdf: async (p: unknown) => { if (opts.pdfThrows) throw new Error('boom'); seen.pdf.push(p); },
            }),
          };
        },
        close: async () => { seen.closed = true; },
      };
    },
  } as unknown as LiLauncher;
  return { seen, launcher };
}

describe('htmlToPdf', () => {
  it('prints the html file to an A4 PDF with backgrounds through the shared real-Chrome launcher', async () => {
    const f = fake();
    await htmlToPdf('/tmp/x/resume.html', '/tmp/x/resume.pdf', { launcher: f.launcher });
    expect(f.seen.launch).toMatchObject({ channel: 'chrome', headless: true });
    expect(f.seen.goto).toEqual([{ url: 'file:///tmp/x/resume.html', opts: { waitUntil: 'load' } }]);
    expect(f.seen.pdf).toEqual([{ path: '/tmp/x/resume.pdf', format: 'A4', printBackground: true }]);
    expect(f.seen.closed).toBe(true);
    // the page is local, static HTML built from resume text: no script runs while it is printed
    expect(f.seen.ctx).toEqual({ javaScriptEnabled: false });
  });

  it('closes the browser and rethrows when printing fails', async () => {
    const f = fake({ pdfThrows: true });
    await expect(htmlToPdf('/tmp/x/resume.html', '/tmp/x/resume.pdf', { launcher: f.launcher })).rejects.toThrow('boom');
    expect(f.seen.closed).toBe(true);
  });
});
