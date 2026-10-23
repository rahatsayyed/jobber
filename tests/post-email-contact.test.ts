import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { postEmailContact, composePostContacts, companyUnresolved } from '../src/lib/postEmail.js';

const post = (o: Record<string, unknown> = {}) => ({ source: 'linkedin-posts', apply_email: 'Jobs@Acme.io', company: 'Acme', ...o });
const yes = vi.fn(async () => true);
const no = vi.fn(async () => false);

describe('postEmailContact', () => {
  it('returns the post address with source post, lower-cased, verified only when verification passes', async () => {
    const ok = await postEmailContact(post(), 'Acme', yes);
    expect(ok).toMatchObject({ email: 'jobs@acme.io', source: 'post', verified: true, company: 'Acme' });
    expect(yes).toHaveBeenCalledWith('jobs@acme.io', { trusted: false });
    const bad = await postEmailContact(post(), 'Acme', no);
    expect(bad).toMatchObject({ verified: false, confidence: 0.2 });
  });
  it('never verifies or probes a free-mail address', async () => {
    const v = vi.fn(async () => true);
    const c = await postEmailContact(post({ apply_email: 'someone@gmail.com' }), 'Acme', v);
    expect(c).toMatchObject({ source: 'post', verified: false });
    expect(v).not.toHaveBeenCalled();
  });
  it('ignores non-post jobs, missing and malformed addresses', async () => {
    expect(await postEmailContact(post({ source: 'adzuna' }), 'Acme', yes)).toBeNull();
    expect(await postEmailContact(post({ apply_email: null }), 'Acme', yes)).toBeNull();
    expect(await postEmailContact(post({ apply_email: 'not an email' }), 'Acme', yes)).toBeNull();
    expect(await postEmailContact(null, 'Acme', yes)).toBeNull();
  });
});

describe('composePostContacts (find_company_emails for a post)', () => {
  const found = [{ company: 'Acme', email: 'hr@acme.io', type: 'role', verified: true, source: 'scraped', confidence: 0.9 }];
  it('post email plus the company search when the company is known; verified first', async () => {
    const gather = vi.fn(async () => found);
    const r = await composePostContacts(post(), 'Acme', gather, yes);
    expect(r.company_check).toBe('ok');
    expect(gather).toHaveBeenCalledOnce();
    expect((r.contacts as any[]).map((c) => c.email)).toEqual(['jobs@acme.io', 'hr@acme.io']);
  });
  it('an unverified post address never outranks a verified found one and is never presented as verified', async () => {
    const r = await composePostContacts(post(), 'Acme', async () => found, no);
    expect((r.contacts as any[])[0]).toMatchObject({ email: 'hr@acme.io', verified: true });
    expect((r.contacts as any[]).find((c) => c.email === 'jobs@acme.io').verified).toBe(false);
  });
  it('does not repeat the post address when the search found it too', async () => {
    const dup = [{ ...found[0], email: 'jobs@acme.io' }];
    const r = await composePostContacts(post(), 'Acme', async () => dup, yes);
    expect(r.contacts).toHaveLength(1);
    expect((r.contacts[0] as any).source).toBe('post');
  });
  it('empty company: only the post email, no search, company_unresolved', async () => {
    const gather = vi.fn(async () => found);
    const r = await composePostContacts(post({ company: '' }), '', gather, yes);
    expect(gather).not.toHaveBeenCalled();
    expect(r.company_check).toBe('company_unresolved');
    expect((r.contacts as any[]).map((c) => c.email)).toEqual(['jobs@acme.io']);
  });
  it('low-confidence company: no search either', async () => {
    const gather = vi.fn(async () => found);
    const r = await composePostContacts(post({ company_confidence: 'low' }), 'Acme', gather, yes);
    expect(gather).not.toHaveBeenCalled();
    expect(r.company_check).toBe('company_unresolved');
  });
  it('unresolved with no post email returns no contacts', async () => {
    const r = await composePostContacts(post({ company: '', apply_email: null }), '', async () => found, yes);
    expect(r.contacts).toEqual([]);
  });
  it('a non-post job is untouched: just the search result', async () => {
    const r = await composePostContacts({ source: 'adzuna', company: 'Acme' }, 'Acme', async () => found, yes);
    expect(r).toEqual({ contacts: found, company_check: 'ok' });
    expect(companyUnresolved({ source: 'adzuna' }, '')).toBe(false);
  });
  it('the contacts server routes post jobs through composePostContacts', () => {
    const src = readFileSync('src/mcp/contacts.ts', 'utf8');
    expect(src).toContain('composePostContacts');
    expect(src).toContain('company_check');
  });
});
