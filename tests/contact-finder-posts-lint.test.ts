import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const finder = readFileSync('.claude/agents/contact-finder.md', 'utf8');
const operator = readFileSync('.claude/agents/linkedin-operator.md', 'utf8');

describe('contact-finder: LinkedIn hiring posts', () => {
  const at = (s: string) => {
    const i = finder.indexOf(s);
    expect(i, s).toBeGreaterThan(-1);
    return i;
  };
  it('orders post email, then company resolution, then the company search and people search', () => {
    const email = at('**Post email.**');
    const resolve = at('**Resolve the company**');
    const known = at('**Company known**');
    expect(email).toBeLessThan(resolve);
    expect(resolve).toBeLessThan(known);
    expect(finder.indexOf('source: "post"')).toBeGreaterThan(-1);
  });
  it('resolves the company only through the typed read-only tools and update_job_company', () => {
    expect(finder).toMatch(/^tools:.*mcp__linkedin__linkedin_open.*mcp__linkedin__linkedin_snapshot.*mcp__db__update_job_company/m);
    expect(finder).not.toMatch(/^tools:.*(linkedin_click|linkedin_type|arm_send|gmail)/m);
    expect(finder).toContain('db.update_job_company');
    expect(finder).toContain('<job.poster_url>');
    expect(finder).toContain('Code decides the confidence');
  });
  it('people search only after a company is known, otherwise the poster alone with company_unresolved', () => {
    expect(finder).toContain('LinkedIn people\n   searches');
    expect(finder).toContain('`company_unresolved`');
    expect(finder).toContain('no email search for a guessed domain');
    expect(finder).toContain('the poster alone is contacted');
  });
  it('never treats an unverified post email as verified', () => {
    expect(finder).toContain('you never treat an unverified one as verified');
  });
  it('still names the Hacker News gate and closed reason codes', () => {
    for (const c of ['hn_check', 'skipped: hn_domain_unmatched', 'no_company', 'no_verified_contact']) expect(finder).toContain(c);
  });
});

describe('linkedin-operator: post authors', () => {
  it('reads poster rows from next_contacts and never invents a company', () => {
    expect(operator).toContain('posters: true');
    expect(operator).toContain('never invent or guess a company');
    expect(operator).toContain('at most 300 characters');
    expect(operator).toContain('claims only what `post_text` says');
    expect(operator).toContain('`post` input');
  });
  it('the draft skills accept the post input', () => {
    for (const s of ['draft-connect-note', 'draft-linkedin-message']) {
      const t = readFileSync(`.claude/skills/${s}/SKILL.md`, 'utf8');
      expect(t, s).toContain('`post` (optional');
      expect(t, s).toContain('do NOT name a company');
    }
  });
});
