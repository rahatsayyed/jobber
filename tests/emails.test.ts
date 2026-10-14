import { describe, it, expect } from 'vitest';
import { extractEmails, classify, rankEmails, genPatterns } from '../src/lib/emails.js';

describe('extractEmails', () => {
  it('extracts valid emails, drops images/example/tracking noise', () => {
    const text = '<a href="mailto:careers@acme.com">x</a> logo@2x.png foo@example.com hi@acme.com';
    const result = extractEmails(text);
    expect(result).toContain('careers@acme.com');
    expect(result).toContain('hi@acme.com');
    expect(result).not.toContain('logo@2x.png');
    expect(result).not.toContain('foo@example.com');
  });
});

describe('classify', () => {
  it('classifies role, generic, and personal emails', () => {
    expect(classify('careers@x.com')).toBe('role');
    expect(classify('info@x.com')).toBe('generic');
    expect(classify('jane.doe@x.com')).toBe('personal');
  });
});

describe('rankEmails', () => {
  it('orders role, generic, then personal', () => {
    const ranked = rankEmails(['jane@x.com', 'info@x.com', 'careers@x.com']);
    expect(ranked.map((r) => r.email)).toEqual(['careers@x.com', 'info@x.com', 'jane@x.com']);
  });
});

describe('genPatterns', () => {
  it('generates common name-based email patterns', () => {
    const patterns = genPatterns('Jane Doe', 'acme.com');
    expect(patterns).toContain('jane.doe@acme.com');
    expect(patterns).toContain('jdoe@acme.com');
  });
});
