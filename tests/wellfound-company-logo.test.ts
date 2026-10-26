import { describe, it, expect } from 'vitest';
import { cleanCompanyName, pickCompany } from '../src/wellfound/company.js';

const POLLUTED: Array<[string, string]> = [
  ['Distill company logo', 'Distill'],
  ['MaxHome.ai company logo', 'MaxHome.ai'],
  ['KOKO Networks company logo', 'KOKO Networks'],
  ['Archetype Solutions Software company logo', 'Archetype Solutions Software'],
  ['Mira Labs Ai company logo', 'Mira Labs Ai'],
  ['Acme logo', 'Acme'],
  ['Logo of Acme', 'Acme'],
];

describe('logo alt text is stripped from the company', () => {
  it.each(POLLUTED)('%s -> %s', (dirty, clean) => {
    expect(cleanCompanyName(dirty)).toBe(clean);
    expect(pickCompany({ links: [{ href: 'https://wellfound.com/company/x-y', text: dirty }] }).name).toBe(clean);
    expect(pickCompany({ company: dirty }).name).toBe(clean);
  });
  it('a bare "company logo" falls back to the slug; real names are untouched', () => {
    expect(pickCompany({ links: [{ href: 'https://wellfound.com/company/northwind-labs', text: 'company logo' }] })).toMatchObject({ name: 'Northwind Labs' });
    expect(cleanCompanyName('Logoly Inc')).toBe('Logoly Inc');
    expect(cleanCompanyName('Iconic Labs')).toBe('Iconic Labs');
  });
});
