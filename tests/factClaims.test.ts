import { describe, it, expect } from 'vitest';
import { exceedsScanCap, MAX_SCAN_CHARS, delegatedAuthorshipClaims, diagnoseCoverage, factClaims, joinStatements, metricClaims, normalizeFact } from '../src/factClaims.js';

const m = (s: string) => [...metricClaims(s)];

describe('metricClaims (career-ops pinned cases)', () => {
  it.each([
    ['Reached 94,772 active users', ['94772 users']],
    ['Reached 16,181 users', ['16181 users']],
    ['16 181 users', ['16181 users']],
    ['Managed a $900K budget', ['$900k']],
    ['Authored 80 articles', ['80 guides']],
    ['80+ guides', ['80 guides']],
    ['15+ years scaling teams and platforms', ['15 years']],
    ['8 years supporting 40 engineers', ['8 years', '40 engineers']],
    ['~9 live Cloud Run deployments', ['9 deployments']],
    ['Shipped 3 integrations', ['3 integrations']],
    ['3 features across 12 integrations', ['12 integrations']],
    ['Grew to 50k users', ['50k users']],
    ['50 million users', ['50 users']],
    ['Managed 45 staff', ['45 staff']],
    ['20 personnel', ['20 staff']],
    ["I'd approach the first 90 days", []],
    ['Revenue grew in the first 12 months', ['12 months']],
    ["I'd completed the migration in the first 12 months", ['12 months']],
    ['I have 12 years of experience but this role requires 7 years', ['12 years']],
    ['Managed 15 engineers in a role that requires 3 direct reports', ['15 engineers']],
    ['Built EIP-712 signed offers', []],
    ['Co-led 3 audits', ['3 audits']],
    ['Led a team of 5 developers', ['5 engineers']],
  ])('%s', (input, expected) => {
    expect(m(input).sort()).toEqual([...expected].sort());
  });
});

describe('diagnoseCoverage', () => {
  it('warns when counts exist but no noun is recognised', () => {
    expect(diagnoseCoverage('Shipped 3 widgets and 4 gizmos')).toMatch(/counts not checked/);
  });
  it('is quiet when at least one count is recognised', () => {
    expect(diagnoseCoverage('Shipped 3 widgets for 4 users')).toBeNull();
  });
});

describe('factClaims', () => {
  const src = normalizeFact('Worked with React, Docker and Lucid.js.');
  it('extracts employer and title from "worked at X as Y"', () => {
    expect(factClaims('Worked at Initech as a Principal Engineer', src)).toEqual([
      { kind: 'employer', value: 'initech' }, { kind: 'title', value: 'principal engineer' },
    ]);
  });
  it('ignores lowercase prose', () => { expect(factClaims('Worked at the office as a manager', src)).toEqual([]); });
  it('does not glue the next statement onto a title', () => {
    expect(factClaims(joinStatements(['Worked at Initech as a Principal Engineer', 'Built dashboards']), src).map((c) => c.value)).toEqual(['initech', 'principal engineer']);
  });
  it('reads "Title:" and rejects a one-letter title', () => {
    expect(factClaims('Title: VP of Sales', src)).toEqual([{ kind: 'title', value: 'vp of sales' }]);
    expect(factClaims('role: I do not have', src)).toEqual([]);
  });
  it('does not read a tool out of a negated sentence (honest gap lines, P4)', () => {
    expect(factClaims("I haven't worked with Kubernetes yet", src)).toEqual([]);
    expect(factClaims('I have not used Terraform, only React.', src)).toEqual([]);
    expect(factClaims("I can't say I built it using Ansible", src)).toEqual([]);
    expect(factClaims('Worked with Kubernetes and React', src).map((c) => c.value)).toEqual(['kubernetes', 'react']);
  });
  it('extracts tools after using / built with / Technologies:', () => {
    expect(factClaims('Built it using React and Terraform', src).map((c) => c.value)).toEqual(['react', 'terraform']);
    expect(factClaims('Shipped it using kubernetes', src).map((c) => c.value)).toEqual(['kubernetes']);
    expect(factClaims('Built this using efficiency.', src)).toEqual([]);
    expect(factClaims('Built with React and our playbook', src).map((c) => c.value)).toEqual(['react']);
    expect(factClaims('Technologies: our playbook and React', src).map((c) => c.value)).toEqual(['react']);
  });
});

describe('delegatedAuthorshipClaims', () => {
  const source = 'Directed vendor Acme Interactive through the WebGL build for the kiosk.';
  it('blocks a rewrite that claims the vendor work', () => {
    expect(delegatedAuthorshipClaims('Wrote the WebGL implementation for an in-store kiosk.', source)).toEqual([
      { kind: 'authorship', value: 'wrote webgl implementation for an in-store kiosk' },
    ]);
  });
  it('passes a rewrite that keeps the vendor', () => {
    expect(delegatedAuthorshipClaims('Directed vendor Acme Interactive through the WebGL kiosk build.', source)).toEqual([]);
  });
  it('fails open when the source also states direct work', () => {
    expect(delegatedAuthorshipClaims('Wrote the WebGL implementation for an in-store kiosk.', 'Directed vendor Acme Interactive on the WebGL build and wrote the kiosk integration layer.')).toEqual([]);
  });
});

describe('performance bounds on untrusted text', () => {
  const ms = (fn: () => unknown) => { const t = performance.now(); fn(); return performance.now() - t; };
  it('metricClaims on a long digit/dot run is fast', () => {
    expect(ms(() => metricClaims('1.'.repeat(25000)))).toBeLessThan(1000);
  });
  it('diagnoseCoverage on a long digit/dot run is fast', () => {
    expect(ms(() => diagnoseCoverage('1.'.repeat(25000)))).toBeLessThan(1000);
  });
  it('factClaims on many tool triggers is fast', () => {
    expect(ms(() => factClaims('worked with the and for react '.repeat(1700)))).toBeLessThan(1000);
  });
  it('dotted tool names both extract (Lucid.js and Mesh.js)', () => {
    const vals = factClaims('Built integrations using Lucid.js and Mesh.js.').filter((c) => c.kind === 'tool').map((c) => c.value);
    expect(vals).toEqual(expect.arrayContaining(['lucid.js', 'mesh.js']));
  });
  it('metricClaims on a 19000-digit run ending in % is fast (regex bound, not just the cap)', () => {
    expect(ms(() => metricClaims('1'.repeat(19000) + '%'))).toBeLessThan(1000);
  });
  it('metricClaims on "3 years of " x 50000 is fast', () => {
    expect(ms(() => metricClaims('3 years of '.repeat(50000)))).toBeLessThan(1000);
  });
  it('exceedsScanCap flags text the extractors would truncate (callers must block, not trust a partial scan)', () => {
    const padded = ' '.repeat(21000) + 'Worked at Google as Staff Engineer. Grew revenue by 300%.';
    expect(exceedsScanCap(padded)).toBe(true);
    expect(factClaims(padded)).toEqual([]);
    expect(exceedsScanCap('x'.repeat(MAX_SCAN_CHARS))).toBe(false);
  });
});
