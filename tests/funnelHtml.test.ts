import { describe, it, expect } from 'vitest';
import { BENCHMARKS, renderFunnelHtml, type Funnel } from '../src/funnel.js';

const f: Funnel = { threshold: 60, discovered: 120, matched: 30, contacted: 20, replied: 3, interview: 1, offer: 0,
  rates: { match: 0.25, reply: 0.15, interview: 0.05, rejection: null }, first_response_days_median: 6, benchmarks: BENCHMARKS };

describe('renderFunnelHtml', () => {
  it('renders a self-contained page with one bar per stage and benchmark context', () => {
    const html = renderFunnelHtml(f, '2026-10-08 <b>');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect((html.match(/<rect /g) ?? []).length).toBe(6);
    expect(html).toContain('Replied: 3 (15.0% of contacted; typical 3%, range 2-13%)');
    expect(html).toContain('2026-10-08 &lt;b&gt;');
    expect(html).not.toContain('<script');
  });
});
