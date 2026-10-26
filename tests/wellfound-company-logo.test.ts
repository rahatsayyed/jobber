import { describe, it, expect } from 'vitest';
import { cleanCompanyName, pickCompany } from '../src/wellfound/company.js';
import { openDb, saveJob } from '../src/db.js';
import { fixWellfoundCompanies } from '../scripts/fix-wellfound-companies.js';

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

describe('scripts/fix-wellfound-companies', () => {
  it('repairs company and company_key once, honours --dry, leaves other sources', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'wellfound:1', source: 'wellfound', title: 'a', company: 'MaxHome.ai company logo', url: 'u', apply_url: 'u', description: 'd' });
    saveJob(db, { id: 'wellfound:2', source: 'wellfound', title: 'b', company: 'Acme', url: 'u', apply_url: 'u', description: 'd' });
    saveJob(db, { id: 'g1', source: 'greenhouse', title: 'c', company: 'X company logo', url: 'u', apply_url: 'u', description: 'd' });
    expect(fixWellfoundCompanies(db, { dry: true })).toMatchObject({ fixed: 0, ids: ['wellfound:1'] });
    expect(db.prepare("SELECT company FROM jobs WHERE id = 'wellfound:1'").get()).toEqual({ company: 'MaxHome.ai company logo' });
    expect(fixWellfoundCompanies(db)).toMatchObject({ fixed: 1 });
    expect(db.prepare("SELECT company, company_key FROM jobs WHERE id = 'wellfound:1'").get()).toEqual({ company: 'MaxHome.ai', company_key: 'maxhome ai' });
    expect(fixWellfoundCompanies(db)).toMatchObject({ fixed: 0, ids: [] });
    expect(db.prepare("SELECT company FROM jobs WHERE id = 'g1'").get()).toEqual({ company: 'X company logo' });
  });
});
