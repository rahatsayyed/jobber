// src/setup/steps/profile.ts
// Step 7: job questions. Writes user-data/profile.json, updates only the answers-file fields it
// was told about, and extends languages.json. Existing files get a mode-600 backup before any
// change, writes are atomic (tmp + rename), and identical content is never rewritten.
// Nothing here is invented for the user: every value comes from an answer.
import path from 'node:path';
import { userDataDir } from '../../lib/userData.js';
import { parseMoney, validateProfile, type Profile, type SalaryBand } from '../profile.js';
import type { SetupContext, SetupStep } from '../runner.js';

const LEVELS = ['basic', 'professional', 'fluent', 'native'] as const;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function readJson(ctx: SetupContext, p: string): Json | null {
  if (!ctx.fs.exists(p)) return null;
  let v: unknown;
  try {
    v = JSON.parse(ctx.fs.read(p));
  } catch {
    throw new Error(`${path.basename(p)} is not valid JSON; fix or remove it, then rerun this step`);
  }
  if (!isObj(v)) throw new Error(`${path.basename(p)} is not a JSON object`);
  return v;
}

/** Existing user file, else the shipped template (synthetic), else null. */
function load(ctx: SetupContext, dir: string, name: string): Json | null {
  return readJson(ctx, path.join(dir, name)) ?? readJson(ctx, path.join(ctx.root, 'user-data.example', name));
}

/** Backup, atomic write, mode 600. A no-op when the parsed content is unchanged. */
function writeJson(ctx: SetupContext, file: string, next: unknown): boolean {
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (ctx.fs.exists(file)) {
    let same = false;
    try {
      same = JSON.stringify(JSON.parse(ctx.fs.read(file))) === JSON.stringify(next);
    } catch {
      same = false;
    }
    if (same) {
      ctx.fs.chmod(file, 0o600);
      return false;
    }
    const ts = ctx.now().toISOString().replace(/[:.]/g, '-');
    ctx.fs.write(`${file}.bak-${ts}`, ctx.fs.read(file), 0o600);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  ctx.fs.write(tmp, text, 0o600);
  ctx.fs.rename(tmp, file);
  ctx.fs.chmod(file, 0o600);
  return true;
}

function csv(v: string): string[] {
  return v.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

const GULF: [RegExp, string][] = [
  [/\b(uae|united arab emirates|dubai|abu dhabi|sharjah)\b/i, 'AED'],
  [/\b(saudi|ksa|riyadh|jeddah)\b/i, 'SAR'],
  [/\bqatar|doha\b/i, 'QAR'],
  [/\bkuwait\b/i, 'KWD'],
  [/\bbahrain\b/i, 'BHD'],
  [/\boman|muscat\b/i, 'OMR'],
];

function suggestCurrencies(locations: string[], remote: boolean): string[] {
  const out: string[] = [];
  const add = (c: string): void => {
    if (!out.includes(c)) out.push(c);
  };
  for (const l of locations) {
    if (/\bindia\b/i.test(l)) add('INR');
    for (const [re, c] of GULF) if (re.test(l)) add(c);
  }
  if (remote) add('USD');
  return out;
}

function existingBand(prev: Partial<Profile>, cur: string): SalaryBand | null {
  const b = prev.salary?.[cur];
  return b && typeof b.floor === 'number' && typeof b.target === 'number' ? b : null;
}

// What an existing profile.json already says, field by field. A hand-written or older file
// that fails full validation still supplies every field that is individually usable, so
// re-running the step offers those values as defaults and Enter keeps them.
function looseProfile(raw: Json | null): Partial<Profile> {
  if (!raw) return {};
  const out: Partial<Profile> = {};
  const strs = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined;
    const list = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
    return list.length > 0 ? list : undefined;
  };
  const roles = strs(raw.roles);
  if (roles) out.roles = roles;
  const locations = strs(raw.locations);
  if (locations) out.locations = locations;
  if (typeof raw.remote_ok === 'boolean') out.remote_ok = raw.remote_ok;
  if (typeof raw.remote_anywhere === 'boolean') out.remote_anywhere = raw.remote_anywhere;
  if (isObj(raw.salary)) {
    const salary: Record<string, SalaryBand> = {};
    for (const [cur, v] of Object.entries(raw.salary)) {
      if (!/^[A-Z]{3}$/.test(cur) || !isObj(v)) continue;
      if (typeof v.floor === 'number' && v.floor > 0 && typeof v.target === 'number' && v.target > 0) {
        salary[cur] = { floor: v.floor, target: v.target };
      }
    }
    out.salary = salary;
  }
  const n = raw.notice_period_days;
  if (typeof n === 'number' && Number.isInteger(n) && n >= 0) out.notice_period_days = n;
  const wa = raw.work_authorization;
  if (isObj(wa)) {
    const india = typeof wa.india === 'boolean' ? wa.india : undefined;
    const other = wa.other;
    if (india !== undefined || typeof other === 'string') {
      out.work_authorization = {
        india: india ?? true,
        other: other === 'needs_sponsorship' || other === 'authorized' ? other : 'unknown',
      };
    }
  }
  return out;
}

export const profileStep: SetupStep = {
  id: 'profile',
  title: 'Job questions and profile',
  checkIds: ['profile-valid', 'languages-confirmed'],
  async run(ctx) {
    const { io } = ctx;
    const dir = userDataDir(ctx.env, ctx.root);
    const profilePath = path.join(dir, 'profile.json');
    const answersPath = path.join(dir, 'easy-apply-answers.json');
    const langPath = path.join(dir, 'languages.json');

    const prevRaw = readJson(ctx, profilePath);
    const prev = looseProfile(prevRaw);
    const answers = load(ctx, dir, 'easy-apply-answers.json');
    const langs = load(ctx, dir, 'languages.json');

    // 1. What to hunt
    const roles = csv(
      await io.ask('Roles you want, comma separated', {
        default: prev.roles ? prev.roles.join(', ') : undefined,
        validate: (v) => (csv(v).length > 0 ? null : 'Enter at least one role'),
      }),
    );
    const locations = csv(
      await io.ask('Locations you want, comma separated (for example India, UAE)', {
        default: prev.locations ? prev.locations.join(', ') : undefined,
        validate: (v) => (csv(v).length > 0 ? null : 'Enter at least one location'),
      }),
    );
    const remote_ok = await io.confirm('Are remote roles acceptable?', prev.remote_ok ?? true);
    io.say('Remote anywhere allows remote roles based in other countries, unless the posting restricts who may apply.');
    const remote_anywhere = await io.confirm('Allow remote roles based anywhere?', prev.remote_anywhere ?? false);

    // 2. Salary floors and targets, per currency
    io.say('A floor is a never-go-below yearly amount and a target is what you hope for. Nothing is filled in for you.');
    const suggested = suggestCurrencies(locations, remote_ok);
    const curDefault = prev.salary ? Object.keys(prev.salary).join(', ') : suggested.join(', ');
    const curRaw = await io.ask(
      'Currencies to set salary for (ISO codes such as INR, AED, USD; blank for none)',
      {
        default: curDefault !== '' ? curDefault : undefined,
        validate: (v) => (csv(v).every((c) => /^[A-Z]{3}$/.test(c)) ? null : 'Use three-letter upper-case codes'),
      },
    );
    const salary: Record<string, SalaryBand> = {};
    for (const cur of csv(curRaw)) {
      const old = existingBand(prev, cur);
      const hint = cur === 'INR' ? ' (for example 18,00,000 or 18 LPA)' : ' (for example 90000 or 90k)';
      const floor = parseMoney(
        await io.ask(`${cur} yearly floor${hint}`, {
          default: old ? String(old.floor) : undefined,
          validate: (v) => (parseMoney(v, cur) === null ? 'Enter a positive amount' : null),
        }),
        cur,
      ) as number;
      const target = parseMoney(
        await io.ask(`${cur} yearly target`, {
          default: old && old.target >= floor ? String(old.target) : undefined,
          validate: (v) => {
            const n = parseMoney(v, cur);
            if (n === null) return 'Enter a positive amount';
            return n < floor ? 'The target must be at least the floor' : null;
          },
        }),
        cur,
      ) as number;
      salary[cur] = { floor, target };
    }

    // 3. Notice period and work authorization
    const notice_period_days = Number(
      await io.ask('Notice period in days', {
        default: prev.notice_period_days !== undefined ? String(prev.notice_period_days) : undefined,
        validate: (v) => (/^\d{1,4}$/.test(v.trim()) ? null : 'Enter whole days, 0 or more'),
      }),
    );
    const india = await io.confirm('Are you authorized to work in India without sponsorship?', prev.work_authorization?.india ?? true);
    const other = await io.choose(
      'Elsewhere (outside India)',
      [
        { value: 'needs_sponsorship', label: 'I would need visa sponsorship' },
        { value: 'authorized', label: 'I am already authorized' },
        { value: 'unknown', label: 'Not sure or it depends' },
      ],
      prev.work_authorization?.other ?? 'unknown',
    );

    const next: Json = answers ? { ...answers } : {};
    const hasAnswers = answers !== null;
    if (hasAnswers) {
      next.notice_period_days = notice_period_days;
      if (other !== 'unknown') {
        const want = { india: !india, other: other === 'needs_sponsorship' };
        if (JSON.stringify(next.requires_sponsorship) !== JSON.stringify(want)) {
          io.say(
            'Known conflict: a plain "requires_sponsorship: true" in your answers file is wrong for India roles when you are an Indian citizen.',
          );
          if (await io.confirm(`Set requires_sponsorship to india=${want.india}, other=${want.other}?`, true)) {
            next.requires_sponsorship = want;
          }
        }
      }
      const exp = (
        await io.ask('Expected salary text for application forms (blank keeps the current value)', { default: '' })
      ).trim();
      if (exp !== '') next.expected_salary = exp;
      if (!ctx.fs.exists(answersPath)) {
        // Creating from the template: never write its placeholder phone or profile URL.
        io.say('Creating your answers file. Phone and LinkedIn URL are optional; leave blank to skip.');
        next.phone = (await io.ask('Phone number for application forms (optional)', { default: '' })).trim();
        next.linkedin_profile_url = (
          await io.ask('LinkedIn profile URL (optional, https://www.linkedin.com/in/...)', {
            default: '',
            validate: (v) =>
              v.trim() === '' || /^https:\/\/www\.linkedin\.com\/in\/[A-Za-z0-9_%.-]+\/?$/.test(v.trim())
                ? null
                : 'Use https://www.linkedin.com/in/<name> or leave blank',
          })
        ).trim();
        // The template's years, relocation, work-authorization and salary values are
        // placeholders that real applications would submit: ask for the real ones, and leave
        // the salary unset (an unset key makes apply.linkedin return needs_answer).
        const yesNo = (v: string): string | null =>
          /^(y|yes|n|no)$/i.test(v.trim()) ? null : 'Answer yes or no';
        next.years_experience = Number(
          await io.ask('Years of relevant work experience (whole number, used on application forms)', {
            validate: (v) =>
              /^\d{1,2}$/.test(v.trim()) ? null : 'Enter a whole number of years, 0 or more',
          }),
        );
        next.willing_to_relocate = /^y/i.test(
          (await io.ask('Willing to relocate for a role? (yes/no)', { validate: yesNo })).trim(),
        );
        next.authorized_to_work = /^y/i.test(
          (
            await io.ask('Authorized to work in the job country without sponsorship, as forms ask? (yes/no)', {
              validate: yesNo,
            })
          ).trim(),
        );
        if (exp === '') delete next.expected_salary;
        io.say(
          exp === ''
            ? 'Expected salary left unset: an application that asks for it will stop and ask you.'
            : 'Expected salary saved as you typed it.',
        );
      }
    } else {
      io.say('No easy-apply-answers.json or template found: skipping the application answers file.');
    }

    // 4. Languages
    const declared = Array.isArray(langs?.declared)
      ? (langs.declared as unknown[]).filter(isObj).map((d) => ({ ...d }))
      : [];
    if (langs) {
      io.say(
        `Declared languages: ${declared.map((d) => `${String(d.language)} (${String(d.level)})`).join(', ') || 'none'}`,
      );
      while (await io.confirm('Add a language you speak?', false)) {
        const name = (
          await io.ask('Language name', { validate: (v) => (v.trim() ? null : 'Enter a name') })
        ).trim();
        const level = await io.choose(
          `Level for ${name}`,
          LEVELS.map((l) => ({ value: l, label: l })),
          'professional',
        );
        const at = declared.findIndex((d) => String(d.language).toLowerCase() === name.toLowerCase());
        if (at >= 0) declared[at] = { ...declared[at], language: name, level };
        else declared.push({ language: name, level });
      }
    }
    const langNext: Json | null = langs ? { ...langs, declared } : null;
    if (langNext && langNext.confirmed === true && JSON.stringify(declared) !== JSON.stringify(langs?.declared ?? [])) {
      if (!(await io.confirm('The language list changed. Keep it marked as confirmed?', false))) {
        langNext.confirmed = false;
        io.say('The language list is no longer confirmed; the gate only flags until you confirm it.');
      }
    } else if (langNext && langNext.confirmed !== true) {
      io.say(
        'Confirming makes the language gate exclude postings that require a language you have not declared; until then it only flags them.',
      );
      if (await io.confirm('Mark this language list as confirmed?', false)) langNext.confirmed = true;
    }

    const profile: Profile = {
      version: 1,
      roles,
      locations,
      remote_ok,
      remote_anywhere,
      salary,
      notice_period_days,
      work_authorization: { india, other },
      languages: declared.map((d) => String(d.language)),
    };
    const problems = validateProfile(profile);
    if (problems.length > 0) throw new Error(`profile is invalid: ${problems.join(', ')}`);

    ctx.fs.mkdirp(dir, 0o700);
    ctx.fs.chmod(dir, 0o700);
    const changed: string[] = [];
    if (writeJson(ctx, profilePath, profile)) changed.push('profile.json');
    if (hasAnswers && writeJson(ctx, answersPath, next)) changed.push('easy-apply-answers.json');
    if (langNext && writeJson(ctx, langPath, langNext)) changed.push('languages.json');
    io.say(changed.length > 0 ? `Wrote: ${changed.join(', ')}` : 'Nothing changed.');
    return 'done';
  },
};
