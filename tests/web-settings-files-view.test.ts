import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Plain browser JS (no allowJs): loaded through a variable specifier, like the env view test.
const dir = resolve(process.cwd(), 'src', 'web', 'static', 'views');
const load = async (f: string) => import(/* @vite-ignore */ pathToFileURL(resolve(dir, f)).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const files: any = await load('settings-files.js');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const backups: any = await load('settings-backups.js');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const diff: any = await load('settings-diff.js');
const { FORM_VIEW_IDS, formSchema, toForm, formToText, parseText, parseErrorPosition, controlKindFor, fileBadges } = files;

const FIXTURES: Record<string, Record<string, unknown>> = {
  replies: { auto_record_enabled: false, extra_key: { keep: [1, 2] } },
  'target-regions': { home: ['India'], targets: ['UAE', 'Dubai'], remote: true, remote_anywhere: true, extra_key: 'x' },
  'deal-breakers': { keywords: ['unpaid', 'commission only'], extra_key: 7 },
  languages: { confirmed: false, declared: [{ language: 'English', level: 'fluent', note: 'kept' }], extra_key: true },
  portals: {
    tracked_companies: [
      { name: 'GitLab', ats: 'greenhouse', slug: 'gitlab', enabled: true },
      { name: 'CrowdStrike', ats: 'workday', slug: 'crowdstrike', wd: 'wd5', site: 's', max_detail: 40, enabled: false, note: 'n' },
    ],
    aggregators: { hackernews: { enabled: false, max_pages: 2, other: 'k' }, himalayas: { enabled: false } },
    location_filter: { remote_anywhere: true, allow: ['India'] },
    extra_key: [1],
  },
  profile: {
    version: 1, roles: ['dev'], locations: ['Pune'], remote_ok: true, remote_anywhere: false,
    salary: { USD: { floor: 1000, target: 2000, extra: 'k' } }, notice_period_days: 30, languages: ['English'],
  },
  'fact-gate': { allow_facts: ['a'], allow_metrics: [], forbidden_phrases: ['x'], warn_phrases: [], extra_key: {} },
  'easy-apply-answers': {
    years_experience: 4, authorized_to_work: true, requires_sponsorship: { india: false, other: true },
    willing_to_relocate: true, notice_period_days: 30, expected_salary: 'Negotiable', phone: '+1', linkedin_profile_url: 'l',
    custom: { 'What is your CTC?': '18 LPA', 'Years of React?': 4 }, extra_key: 'z',
  },
};

describe('form views: text round trip', () => {
  it('covers exactly the plan form views', () => {
    expect([...FORM_VIEW_IDS].sort()).toEqual(Object.keys(FIXTURES).sort());
  });

  for (const id of Object.keys(FIXTURES)) {
    it(`${id}: toForm then formToText is the identity, unknown keys kept, 2-space JSON`, () => {
      const obj = FIXTURES[id];
      const text = formToText(id, obj, toForm(id, obj));
      expect(JSON.parse(text)).toEqual(obj);
      expect(text).toBe(JSON.stringify(obj, null, 2) + '\n');
      expect(Object.keys(JSON.parse(text))).toEqual(Object.keys(obj));
    });

    it(`${id}: an edit changes only known keys`, () => {
      const obj = FIXTURES[id];
      const form = toForm(id, obj);
      const sch = formSchema(id);
      expect(Array.isArray(sch)).toBe(true);
      const bool = sch.find((f: { type: string }) => f.type === 'bool');
      const list = sch.find((f: { type: string }) => f.type === 'list');
      if (bool) form[bool.key] = !form[bool.key];
      if (list) form[list.key] = [...form[list.key], 'added item'];
      const out = JSON.parse(formToText(id, obj, form));
      for (const k of Object.keys(obj)) {
        if (!sch.some((f: { key: string }) => f.key === k)) expect(out[k], k).toEqual(obj[k]);
      }
      if (bool) expect(out[bool.key]).toBe(!obj[bool.key]);
      if (list) expect(out[list.key]).toEqual([...(obj[list.key] as string[]), 'added item']);
    });
  }

  it('portals: toggle and add company keep extra company and aggregator keys', () => {
    const obj = FIXTURES.portals;
    const form = toForm('portals', obj);
    form.tracked_companies[0].enabled = false;
    form.tracked_companies.push({ name: 'New', ats: 'lever', slug: 'new', enabled: false });
    form.aggregators[0].enabled = true;
    const out = JSON.parse(formToText('portals', obj, form));
    expect(out.tracked_companies[0]).toEqual({ name: 'GitLab', ats: 'greenhouse', slug: 'gitlab', enabled: false });
    expect(out.tracked_companies[1].note).toBe('n');
    expect(out.tracked_companies[2]).toEqual({ name: 'New', ats: 'lever', slug: 'new', enabled: false });
    expect(out.aggregators.hackernews).toEqual({ enabled: true, max_pages: 2, other: 'k' });
    expect(out.location_filter).toEqual(obj.location_filter);
  });

  it('easy-apply-answers: object requires_sponsorship is preserved and flagged read only; custom edits work', () => {
    const obj = FIXTURES['easy-apply-answers'];
    const form = toForm('easy-apply-answers', obj);
    form.custom.push({ q: 'New question?', a: 'yes' });
    form.custom.push({ q: '  ', a: 'dropped' });
    form.years_experience = 5;
    const out = JSON.parse(formToText('easy-apply-answers', obj, form));
    expect(out.requires_sponsorship).toEqual({ india: false, other: true });
    expect(out.custom).toEqual({ 'What is your CTC?': '18 LPA', 'Years of React?': 4, 'New question?': 'yes' });
    expect(out.years_experience).toBe(5);
    const field = formSchema('easy-apply-answers').find((f: { key: string }) => f.key === 'requires_sponsorship');
    expect(controlKindFor(field, obj.requires_sponsorship)).toBe('readonly');
    expect(controlKindFor(field, true)).toBe('switch');
  });

  it('absent keys stay absent unless the form fills them', () => {
    const out = JSON.parse(formToText('replies', {}, toForm('replies', {})));
    expect(out).toEqual({});
    const form = toForm('replies', {});
    form.auto_record_enabled = true;
    expect(JSON.parse(formToText('replies', {}, form))).toEqual({ auto_record_enabled: true });
  });

  it('int columns: blank removes the key, digits become numbers, junk stays text for the server to reject', () => {
    const obj = FIXTURES.profile;
    const form = toForm('profile', obj);
    form.salary[0].floor = '';
    form.salary[0].target = '2500';
    form.notice_period_days = '45';
    const out = JSON.parse(formToText('profile', obj, form));
    expect(out.salary.USD).toEqual({ target: 2500, extra: 'k' });
    expect(out.notice_period_days).toBe(45);
    form.notice_period_days = 'abc';
    expect(JSON.parse(formToText('profile', obj, form)).notice_period_days).toBe('abc');
  });
});

describe('parse errors', () => {
  it('parseText returns the value for good JSON', () => {
    expect(parseText('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
  });
  it('reports line and column of the first error', () => {
    const r = parseText('{\n  "a": 1,\n  "b": ,\n}');
    expect(r.ok).toBe(false);
    expect(r.line).toBe(3);
    expect(r.column).toBeGreaterThan(0);
    expect(typeof r.message).toBe('string');
  });
  it('position math: offset to line and column', () => {
    expect(parseErrorPosition('abc\ndef', { message: 'x at position 5' })).toEqual({ line: 2, column: 2 });
    expect(parseErrorPosition('abc', { message: 'line 4 column 9 of the JSON data' })).toEqual({ line: 4, column: 9 });
    expect(parseErrorPosition('abc', { message: 'no hint' })).toEqual({ line: 1, column: 1 });
  });
  it('empty text is an error', () => {
    expect(parseText('').ok).toBe(false);
  });
});

describe('controlKindFor (file fields)', () => {
  it('maps each field type to a control', () => {
    expect(controlKindFor({ type: 'bool' })).toBe('switch');
    expect(controlKindFor({ type: 'int' })).toBe('number');
    expect(controlKindFor({ type: 'enum', allowed: ['a'] })).toBe('select');
    expect(controlKindFor({ type: 'string' })).toBe('text');
    expect(controlKindFor({ type: 'list' })).toBe('list');
    for (const t of ['rows', 'keyed', 'qa']) expect(controlKindFor({ type: t })).toBe('rows');
    expect(controlKindFor({ type: 'nonsense' })).toBe('readonly');
  });
  it('every schema field of every form view maps to a real control', () => {
    for (const id of FORM_VIEW_IDS) for (const f of formSchema(id)) expect(controlKindFor(f, true)).not.toBe('readonly');
  });
});

describe('file list badges', () => {
  it('editable, view only with reason, missing', () => {
    const t = (b: { text: string }[]) => b.map((x) => x.text).join(' | ');
    expect(t(fileBadges({ edit: true, exists: true }))).toContain('editable');
    const v = t(fileBadges({ edit: false, exists: true, viewReason: 'Change it with `npm run permissions`.' }));
    expect(v).toContain('view only');
    expect(v).toContain('npm run permissions');
    expect(t(fileBadges({ edit: true, exists: false }))).toContain('missing');
  });
});

describe('diff and backups helpers', () => {
  it('contextLines keeps changes with context and marks gaps', () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ op: 'eq', text: `l${i}`, oldLine: i + 1, newLine: i + 1 }));
    lines[10] = { op: 'add', text: 'new', newLine: 11 } as never;
    const out = diff.contextLines(lines, 2);
    expect(out.filter((l: { op: string }) => l.op === 'add')).toHaveLength(1);
    expect(out.length).toBeLessThan(10);
    expect(out.some((l: { op: string }) => l.op === 'gap')).toBe(true);
  });
  it('rollback target and size helpers', () => {
    expect(backups.targetKey('env')).toBe('env');
    expect(backups.targetKey('portals')).toBe('file:portals');
    expect(backups.formatSize(512)).toBe('512 B');
    expect(backups.formatSize(2048)).toBe('2.0 KB');
  });
});
