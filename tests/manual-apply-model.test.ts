import { describe, expect, it } from 'vitest';
import {
  actionBody, bulkLabel, easyApplyBanner, errorsFrom, filterByReason, MANUAL_PAGE, NOTE_LIMIT, noteProblem, pageRows, pruneSelection, reasonFacets, reasonTone,
  safeDownload, safeOpenUrl, savedMessage, showMoreLabel, sinceText, toggleAll, toggleId,
} from '../apps/dashboard/src/lib/manual-apply-model.js';

describe('manual apply model (dashboard Apply by hand)', () => {
  it('shows the Easy Apply banner only while the flag is off', () => {
    expect(easyApplyBanner({ easyApplyEnabled: false })).toMatch(/Easy Apply is off/);
    expect(easyApplyBanner({ easyApplyEnabled: true })).toBeNull();
  });

  it('only https addresses without credentials become links', () => {
    expect(safeOpenUrl('https://boards.greenhouse.io/acme/jobs/1')).toBe('https://boards.greenhouse.io/acme/jobs/1');
    for (const bad of ['http://acme.example.com', 'javascript:alert(1)', 'https://u:p@acme.example.com/', 'data:text/html,x', '', null, undefined, 'not a url']) expect(safeOpenUrl(bad as string)).toBeNull();
  });

  it('a download link is only the same-origin API path of that row', () => {
    expect(safeDownload({ id: 7, resume_download: '/api/manual-apply/7/resume' })).toBe('/api/manual-apply/7/resume');
    for (const bad of ['/api/manual-apply/8/resume', 'https://evil.example/x.pdf', '/etc/passwd', null]) expect(safeDownload({ id: 7, resume_download: bad })).toBeNull();
  });

  it('toggles single and all selections and prunes ids that left the list', () => {
    const items = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(toggleId([], 2)).toEqual([2]);
    expect(toggleId([2, 3], 2)).toEqual([3]);
    expect(toggleAll([], items)).toEqual([1, 2, 3]);
    expect(toggleAll([1], items)).toEqual([1, 2, 3]);
    expect(toggleAll([1, 2, 3], items)).toEqual([]);
    expect(toggleAll([], [])).toEqual([]);
    expect(pruneSelection([1, 2, 9], items)).toEqual([1, 2]);
  });

  it('builds request bodies with a trimmed optional note and checks its length', () => {
    expect(actionBody([1, 2], '  ')).toEqual({ ids: [1, 2] });
    expect(actionBody([1], ' applied on site ')).toEqual({ ids: [1], note: 'applied on site' });
    expect(noteProblem('x'.repeat(NOTE_LIMIT))).toBeNull();
    expect(noteProblem('x'.repeat(NOTE_LIMIT + 1))).toMatch(/too long/);
  });

  it('labels bulk buttons and saved messages in plain words', () => {
    expect(bulkLabel('done', 1)).toBe('I applied to this job');
    expect(bulkLabel('done', 3)).toBe('I applied to 3 jobs');
    expect(bulkLabel('skip', 2)).toBe('Skip 2 jobs');
    const results = [{ id: 1, ok: true }, { id: 2, ok: false, error: 'not on the list' }];
    expect(savedMessage('done', results)).toBe('Saved 1 job as applied by you. 1 could not be saved (already handled, or no longer waiting).');
    expect(savedMessage('skip', [{ id: 1, ok: true }, { id: 2, ok: true }])).toBe('Skipped 2 jobs. They will not come back.');
    expect(errorsFrom(results)).toEqual({ 2: 'not on the list' });
    expect(errorsFrom('x')).toEqual({});
  });

  it('tones the reason chip and words the age', () => {
    expect(reasonTone('easy_apply_off')).toBe('warn');
    expect(reasonTone('easy_apply_failed')).toBe('bad');
    expect(reasonTone('company_site_form')).toBe('');
    const now = new Date('2026-11-02T12:00:00.000Z');
    expect(sinceText('2026-11-02T11:59:30.000Z', now)).toBe('just now');
    expect(sinceText('2026-11-02T09:00:00.000Z', now)).toBe('3h ago');
    expect(sinceText('2026-10-30T12:00:00.000Z', now)).toBe('3d ago');
    expect(sinceText('garbage', now)).toBe('');
  });
});

describe('manual apply list paging and reason filter', () => {
  const rows = (n: number, reason = 'company_site_form', label = 'Company site form') => Array.from({ length: n }, (_, i) => ({ id: i + 1, reason, reason_label: label }));

  it('shows ten rows first with a count and a "Show 10 more" button', () => {
    const all = rows(78);
    const first = pageRows(all, MANUAL_PAGE);
    expect(first.visible).toHaveLength(10);
    expect(first.rest).toBe(68);
    expect(first.text).toBe('10 of 78 shown');
    expect(showMoreLabel(first.rest)).toBe('Show 10 more');
    expect(showMoreLabel(4)).toBe('Show 4 more');
    expect(pageRows(all, 80).rest).toBe(0);
  });

  it('builds one chip per reason, biggest first, and filters by it', () => {
    const all = [...rows(2, 'easy_apply_off', 'Easy Apply is off'), ...rows(5), ...rows(1, 'listing_page', 'Careers listing page')];
    expect(reasonFacets(all)).toEqual([
      { reason: 'company_site_form', label: 'Company site form', count: 5 },
      { reason: 'easy_apply_off', label: 'Easy Apply is off', count: 2 },
      { reason: 'listing_page', label: 'Careers listing page', count: 1 },
    ]);
    expect(filterByReason(all, 'easy_apply_off')).toHaveLength(2);
    expect(filterByReason(all, '')).toHaveLength(8);
  });
});
