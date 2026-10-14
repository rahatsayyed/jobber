// tests/setup-profile.test.ts
import { describe, expect, it } from 'vitest';
import type { DoctorContext } from '../src/platform/doctor.js';
import { profileProblems } from '../src/platform/checksSetup.js';
import { redactingIO, scriptedIO, type ScriptItem } from '../src/setup/io.js';
import { parseMoney, validateProfile } from '../src/setup/profile.js';
import type { SetupContext, SetupFs } from '../src/setup/runner.js';
import { emptyState } from '../src/setup/state.js';
import { profileStep } from '../src/setup/steps/profile.js';

const GOOD = {
  version: 1,
  roles: ['dev'],
  locations: ['India'],
  remote_ok: true,
  remote_anywhere: false,
  salary: { INR: { floor: 1000000, target: 1500000 } },
  notice_period_days: 30,
  work_authorization: { india: true, other: 'unknown' },
  languages: ['English'],
};

describe('parseMoney', () => {
  it.each([
    ['18,00,000', null, 1800000],
    ['1800000', null, 1800000],
    ['25k', null, 25000],
    ['1.5m', 'USD', 1500000],
    ['18 LPA', 'INR', 1800000],
    ['18 lpa', 'INR', 1800000],
  ])('%s (%s) -> %s', (raw, cur, want) => {
    expect(parseMoney(raw, cur ?? undefined)).toBe(want);
  });
  it.each([['18 LPA', 'USD'], ['18 LPA', undefined], ['', undefined], ['abc', undefined], ['-5', undefined], ['0', undefined], ['1,,2', undefined], ['12,', undefined]])(
    'rejects %s (%s)',
    (raw, cur) => {
      expect(parseMoney(raw, cur)).toBeNull();
    },
  );
});

describe('validateProfile', () => {
  it('accepts a good profile', () => {
    expect(validateProfile(GOOD)).toEqual([]);
  });
  it('rejects floor above target, negative and unknown authorization', () => {
    expect(validateProfile({ ...GOOD, salary: { INR: { floor: 5, target: 1 } } })).toEqual(['salary.INR']);
    expect(validateProfile({ ...GOOD, salary: { INR: { floor: -1, target: 1 } } })).toEqual(['salary.INR']);
    expect(validateProfile({ ...GOOD, work_authorization: { india: true, other: 'maybe' } })).toEqual([
      'work_authorization.other',
    ]);
    expect(validateProfile({ ...GOOD, notice_period_days: -1 })).toEqual(['notice_period_days']);
  });
  it('is the single source for the doctor check', () => {
    const bad = { ...GOOD, roles: 'x', salary: { inr: 1 } };
    expect(profileProblems(bad)).toEqual(validateProfile(bad));
  });
});

const ANSWERS = {
  years_experience: 3,
  authorized_to_work: true,
  requires_sponsorship: true,
  willing_to_relocate: true,
  notice_period_days: 60,
  expected_salary: 'Negotiable',
  phone: '+00 1112223334',
  linkedin_profile_url: 'linkedin.com/in/someone-synthetic',
  custom: { 'What is your CTC?': '10 LPA' },
};
const LANGS = { confirmed: false, declared: [{ language: 'English', level: 'fluent' }] };

function setup(script: ScriptItem[], files: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(files));
  const modes = new Map<string, number>();
  const writes: string[] = [];
  const fs: SetupFs = {
    exists: (p) => store.has(p),
    read: (p) => {
      const v = store.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    write: (p, d, m) => void (store.set(p, d), modes.set(p, m), writes.push(p)),
    rename: (a, b) => {
      store.set(b, store.get(a) ?? '');
      store.delete(a);
      modes.set(b, modes.get(a) ?? 0o600);
    },
    chmod: (p, m) => void modes.set(p, m),
    remove: (p) => void store.delete(p),
    mkdirp: () => undefined,
    copy: () => undefined,
    list: () => [],
  };
  const sio = scriptedIO(script);
  const doctor = {
    root: 'proj',
    env: {},
    run: (async () => ({ stdout: '', stderr: '', code: 0 })) as unknown as DoctorContext['run'],
    fs: { exists: fs.exists, read: fs.read, mode: () => 0o600 },
    now: () => new Date('2026-10-14T00:00:00Z'),
  } as DoctorContext;
  const ctx: SetupContext = {
    io: redactingIO(sio),
    root: 'proj',
    env: {},
    fs,
    run: doctor.run,
    spawnInteractive: async () => 0,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    now: () => new Date('2026-10-14T00:00:00Z'),
    doctor,
    state: emptyState(),
    statePath: 'proj/user-data/.setup-state.json',
    envPath: 'proj/.env',
  };
  return { ctx, sio, store, modes, writes };
}

const D = 'proj/user-data';
const files = (): Record<string, string> => ({
  [`${D}/easy-apply-answers.json`]: `${JSON.stringify(ANSWERS, null, 2)}\n`,
  [`${D}/languages.json`]: `${JSON.stringify(LANGS, null, 2)}\n`,
});

// roles, locations, remote_ok, remote_anywhere, currencies, floor, target, notice, india,
// other, [sponsorship confirm], expected salary, add language?, confirm languages
const script = (opts: { confirmLangs?: boolean; sponsorship?: boolean } = {}): ScriptItem[] => [
  { ask: 'full stack developer, react' },
  { ask: 'India, UAE' },
  { confirm: true },
  { confirm: false },
  { ask: 'INR' },
  { ask: '10 LPA' },
  { ask: '15 LPA' },
  { ask: '30' },
  { confirm: true },
  { choose: 'needs_sponsorship' },
  { confirm: opts.sponsorship ?? true },
  { ask: '' },
  { confirm: false },
  { confirm: opts.confirmLangs ?? false },
];

describe('profileStep', () => {
  it('writes the three files, preserving custom, phone and url', async () => {
    const t = setup(script(), files());
    expect(await profileStep.run(t.ctx)).toBe('done');
    const p = JSON.parse(t.store.get(`${D}/profile.json`) ?? '');
    expect(validateProfile(p)).toEqual([]);
    expect(p.salary).toEqual({ INR: { floor: 1000000, target: 1500000 } });
    expect(p.roles).toEqual(['full stack developer', 'react']);
    expect(p.work_authorization).toEqual({ india: true, other: 'needs_sponsorship' });
    const a = JSON.parse(t.store.get(`${D}/easy-apply-answers.json`) ?? '');
    expect(a.custom).toEqual(ANSWERS.custom);
    expect(a.phone).toBe(ANSWERS.phone);
    expect(a.linkedin_profile_url).toBe(ANSWERS.linkedin_profile_url);
    expect(a.requires_sponsorship).toEqual({ india: false, other: true });
    expect(a.notice_period_days).toBe(30);
    expect(a.expected_salary).toBe('Negotiable');
    expect(a.authorized_to_work).toBe(true);
    expect(Object.keys(a)).toEqual(Object.keys(ANSWERS));
    for (const f of ['profile.json', 'easy-apply-answers.json', 'languages.json']) {
      expect(t.modes.get(`${D}/${f}`)).toBe(0o600);
    }
    expect([...t.store.keys()].some((k) => k.includes('.bak-'))).toBe(true);
    t.sio.assertDone();
  });

  it('keeps confirmed false unless confirmed', async () => {
    const t = setup(script(), files());
    await profileStep.run(t.ctx);
    expect(JSON.parse(t.store.get(`${D}/languages.json`) ?? '').confirmed).toBe(false);
    const u = setup(script({ confirmLangs: true }), files());
    await profileStep.run(u.ctx);
    expect(JSON.parse(u.store.get(`${D}/languages.json`) ?? '').confirmed).toBe(true);
  });

  it('leaves requires_sponsorship alone when declined', async () => {
    const t = setup(script({ sponsorship: false }), files());
    await profileStep.run(t.ctx);
    expect(JSON.parse(t.store.get(`${D}/easy-apply-answers.json`) ?? '').requires_sponsorship).toBe(true);
  });

  it('second run with the same answers is a no-op', async () => {
    const t = setup(script(), files());
    await profileStep.run(t.ctx);
    const keys = [...t.store.keys()].sort();
    const snapshot = JSON.stringify([...t.store.entries()].sort());
    t.writes.length = 0;
    // second run: sponsorship already matches, so that confirm is not asked
    const items = script();
    items.splice(10, 1);
    const t2 = setup(items, Object.fromEntries(t.store));
    await profileStep.run(t2.ctx);
    expect(t2.writes).toEqual([]);
    expect([...t2.store.keys()].sort()).toEqual(keys);
    expect(JSON.stringify([...t2.store.entries()].sort())).toBe(snapshot);
  });

  it('re-asks a floor above target', async () => {
    const s = script();
    s.splice(5, 2, { ask: '20 LPA' }, { ask: '10 LPA' }, { ask: '25 LPA' });
    const t = setup(s, files());
    await profileStep.run(t.ctx);
    const p = JSON.parse(t.store.get(`${D}/profile.json`) ?? '');
    expect(p.salary.INR).toEqual({ floor: 2000000, target: 2500000 });
  });
});

describe('profileStep fix round 1', () => {
  const TEMPLATE = {
    ...ANSWERS,
    requires_sponsorship: { india: false, other: true },
    phone: '+00 0000000000',
    linkedin_profile_url: 'linkedin.com/in/example-person',
    custom: {},
  };
  const TPL = 'proj/user-data.example/easy-apply-answers.json';
  const langFile = { [`${D}/languages.json`]: `${JSON.stringify(LANGS, null, 2)}\n` };

  it('prompts for phone and url when creating the answers file, no placeholders written', async () => {
    const s = script();
    s.splice(10, 1); // template sponsorship already matches
    s.splice(11, 0, { ask: '+91 90000 00000' }, { ask: 'https://www.linkedin.com/in/someone-else' });
    const t = setup(s, { [TPL]: JSON.stringify(TEMPLATE), ...langFile });
    await profileStep.run(t.ctx);
    const out = t.store.get(`${D}/easy-apply-answers.json`) ?? '';
    const a = JSON.parse(out);
    expect(a.phone).toBe('+91 90000 00000');
    expect(a.linkedin_profile_url).toBe('https://www.linkedin.com/in/someone-else');
    expect(out).not.toContain('0000000000');
    expect(out).not.toContain('example-person');
    t.sio.assertDone();
  });

  it('writes empty strings when left blank and re-asks a bad url', async () => {
    const s = script();
    s.splice(10, 1);
    s.splice(11, 0, { ask: '' }, { ask: 'linkedin.com/in/x' }, { ask: '' });
    const t = setup(s, { [TPL]: JSON.stringify(TEMPLATE), ...langFile });
    await profileStep.run(t.ctx);
    const a = JSON.parse(t.store.get(`${D}/easy-apply-answers.json`) ?? '');
    expect(a.phone).toBe('');
    expect(a.linkedin_profile_url).toBe('');
  });

  it('never prompts for phone or url when the answers file exists', async () => {
    const t = setup(script(), files());
    await profileStep.run(t.ctx);
    expect(t.sio.transcript.join('\n')).not.toContain('Phone number');
    t.sio.assertDone();
  });

  it('adding a language to a confirmed list needs a fresh confirm', async () => {
    const confirmed = { ...LANGS, confirmed: true };
    const mk = (keep: boolean) => {
      const s = script();
      s.splice(12, 2, { confirm: true }, { ask: 'Arabic' }, { choose: 'basic' }, { confirm: false }, { confirm: keep });
      return setup(s, { ...files(), [`${D}/languages.json`]: `${JSON.stringify(confirmed, null, 2)}\n` });
    };
    const dropped = mk(false);
    await profileStep.run(dropped.ctx);
    expect(JSON.parse(dropped.store.get(`${D}/languages.json`) ?? '').confirmed).toBe(false);
    const kept = mk(true);
    await profileStep.run(kept.ctx);
    expect(JSON.parse(kept.store.get(`${D}/languages.json`) ?? '').confirmed).toBe(true);
  });
});
