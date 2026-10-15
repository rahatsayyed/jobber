// tests/setup-guide.test.ts
// Plan 8E task 8: the setup guide's facts file, skill, profile and the doctor secrecy corpus.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadProfiles } from '../src/platform/runner.js';
import { ccgramChecks, restrictedChecks } from '../src/platform/checks.js';
import { setupChecks } from '../src/platform/checksSetup.js';
import { schedulerChecks } from '../src/platform/checksScheduler.js';
import { updateBackupChecks } from '../src/platform/updateBackupChecks.js';
import { layoutChecks } from '../src/platform/checksLayout.js';
import { bootstrapChecks } from '../src/platform/checksBootstrap.js';
import { setupGuideChecks, skillAllowedTools, expectedSkillTools } from '../src/platform/checksGuide.js';
import { apiKeysChecks } from '../src/platform/checksApiKeys.js';
import { linkedinBrowserChecks } from '../src/linkedin/chromeCheck.js';
import { formatJson, formatReport, runChecks, type Check, type DoctorContext } from '../src/platform/doctor.js';
import { ALL_STEPS } from '../src/setup/steps/index.js';

const ROOT = resolve(import.meta.dirname, '..');

const ALL_CHECKS: Check[] = [
  ...ccgramChecks,
  ...restrictedChecks(),
  ...setupChecks,
  ...linkedinBrowserChecks(),
  ...schedulerChecks(),
  ...layoutChecks(),
  ...updateBackupChecks(),
  ...bootstrapChecks(),
  ...setupGuideChecks(),
  ...apiKeysChecks,
];

interface Guide {
  version: number;
  steps: {
    id: string;
    title: string;
    owner_command: string;
    doctor_checks: string[];
    keys: { name: string; secret: boolean; purpose: string; where: string; entered_in: string }[];
    explain: string;
    fixes: Record<string, string>;
  }[];
  ignore_keys: string[];
}
const guide = JSON.parse(readFileSync(join(ROOT, 'config/setup-guide.json'), 'utf8')) as Guide;

const SECRET_NAME = /(^|_)(KEY|SECRET|TOKEN|PASS|PASSWORD|COOKIE)(_|$)/;
const SECRET_ALLOW = new Set<string>([]);
const ORDER = ['overview', 'prereqs', 'claude', 'telegram', 'gmail', 'apikeys', 'sessions', 'resume', 'profile', 'limits', 'access', 'classifier', 'dashboard', 'final'];

describe('config/setup-guide.json', () => {
  it('has version 1 and the required step order', () => {
    expect(guide.version).toBe(1);
    expect(guide.steps.map((s) => s.id)).toEqual(ORDER);
  });

  it('step order equals ALL_STEPS order and apikeys owns the key entries', () => {
    expect(guide.steps.slice(1).map((s) => s.id)).toEqual(ALL_STEPS.map((s) => s.id));
    const ak = guide.steps.find((s) => s.id === 'apikeys');
    expect(ak?.keys.map((k) => k.name)).toEqual(
      expect.arrayContaining(['ADZUNA_APP_ID', 'ADZUNA_APP_KEY', 'SERPER_API_KEY', 'HUNTER_API_KEY', 'HUNTER_ENABLED']),
    );
    expect(guide.steps.find((s) => s.id === 'profile')?.keys).toEqual([]);
    for (const id of ['telegram', 'dashboard', 'gmail', 'apikeys']) {
      const s = guide.steps.find((x) => x.id === id) as unknown as { skip?: string };
      expect(typeof s.skip, id).toBe('string');
    }
  });

  it('every step id is a wizard step or overview', () => {
    const wizard = new Set(ALL_STEPS.map((s) => s.id));
    for (const s of guide.steps) expect(s.id === 'overview' || wizard.has(s.id), s.id).toBe(true);
  });

  it('every doctor check id exists in a real check list and has a fix text', () => {
    const real = new Set(ALL_CHECKS.map((c) => c.id));
    for (const s of guide.steps) {
      for (const c of s.doctor_checks) {
        expect(real.has(c), `${s.id}: ${c}`).toBe(true);
        expect(typeof s.fixes[c], `${s.id}: fix for ${c}`).toBe('string');
      }
    }
  });

  it('every key of .env.example is under a step or in ignore_keys', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8')
      .split(/\r?\n/)
      .map((l) => /^([A-Z][A-Z0-9_]*)=/.exec(l)?.[1])
      .filter((x): x is string => !!x);
    const known = new Set([...guide.steps.flatMap((s) => s.keys.map((k) => k.name)), ...guide.ignore_keys]);
    for (const k of example) expect(known.has(k), k).toBe(true);
  });

  it('secret flags match the key names', () => {
    for (const s of guide.steps) {
      for (const k of s.keys) {
        if (k.secret) expect(SECRET_NAME.test(k.name) || SECRET_ALLOW.has(k.name), k.name).toBe(true);
        else expect(SECRET_NAME.test(k.name), `${k.name} looks secret but is not flagged`).toBe(false);
      }
    }
  });

  it('has no value, default or example field anywhere', () => {
    const walk = (o: unknown): void => {
      if (Array.isArray(o)) o.forEach(walk);
      else if (o && typeof o === 'object') {
        for (const [key, v] of Object.entries(o)) {
          expect(['value', 'default', 'example'].includes(key), key).toBe(false);
          walk(v);
        }
      }
    };
    walk(guide);
    const allowedKeyFields = ['name', 'secret', 'purpose', 'where', 'entered_in'];
    for (const s of guide.steps) for (const k of s.keys) expect(Object.keys(k).sort()).toEqual([...allowedKeyFields].sort());
  });
});

// The owner's recommended list (plan 8E owner decision O3). Adding a command means editing this list too.
const RECOMMENDED = [
  'npm run doctor -- --json',
  'npm run doctor',
  'npm run setup -- --list',
  'npm run setup -- --status',
  'npm run models -- list',
  'npm run models -- verify',
  'npm run permissions -- --status',
  'npm run dashboard -- status',
  'npm run jobber:control -- status',
  'npm run scheduler -- --status',
  'npm run bootstrap -- --check',
  'npm run dry-run',
];

describe('setup_guide profile and skill', () => {
  const profiles = loadProfiles(join(ROOT, 'config/run-profiles.json'), join(ROOT, 'config/permission-sets.json'));
  const p = profiles.setup_guide;
  const skill = readFileSync(join(ROOT, '.claude/skills/setup-guide/SKILL.md'), 'utf8');

  it('loadProfiles accepts setup_guide and bash_exact stays inside the recommended list', () => {
    expect(p).toBeDefined();
    expect(p.interactive).toBe(true);
    expect(p.allow).toEqual([]);
    const bash = (p as unknown as { bash_exact: string[] }).bash_exact;
    for (const b of bash) expect(RECOMMENDED, b).toContain(b);
  });

  it('skill allowed-tools equals Read plus one Bash per bash_exact entry', () => {
    const bash = (p as unknown as { bash_exact: string[] }).bash_exact;
    expect(skillAllowedTools(skill)).toEqual(expectedSkillTools(bash));
  });

  it('skill carries every hard rule and no secret-reading instruction', () => {
    for (const line of [
      'It never reads or asks to read `.env`, `secrets/`, `user-data/`, `.dashboard/`, `.jobber/`, `data.sqlite`.',
      'It never asks the owner to paste a key, token, URL fragment or cookie.',
      'It never types into another pane.',
      'It never flips a dry flag, clears a halt, resumes, or changes a permission set.',
      'It never fetches the web.',
    ]) {
      expect(skill.includes(line), line).toBe(true);
    }
    expect(/cat\s+\.env/i.test(skill)).toBe(false);
    expect(/open\s+\.env/i.test(skill)).toBe(false);
    // "paste" may only appear in a refusal or warning line
    for (const l of skill.split('\n')) {
      if (!l.startsWith('#') && /paste/i.test(l)) expect(/never|do not|not to/i.test(l), l).toBe(true);
    }
  });

  it('setup_guide_ready passes on the repo files', async () => {
    const ctx: DoctorContext = {
      root: ROOT,
      env: {},
      run: async () => ({ stdout: '', code: 1 }),
      fs: {
        exists: (x) => existsSync(x),
        read: (x) => readFileSync(x, 'utf8'),
        mode: () => 0o600,
      },
    };
    const out = await runChecks(setupGuideChecks(), ctx);
    expect(out[0].result.status).toBe('pass');
  });
});

// Synthetic secrets: invented shapes, none is a real credential.
const SECRETS = {
  telegram: '918273645:AAqzxwvutsrqponmlkjihgfedcbaZYXWVUT',
  googleClient: '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',
  adzuna: 'adz7f3b9c1e5d2a64870bc9e1f3d5a7b',
  serper: 'srp_4Qm8Lx2Vn7Zt9Ks1Wb6Yc3Hd5Jf0Gp',
  dashboardToken: 'Zk3Tq9Wv5Xn1Lb7Rc4Hy8Md2Pf6Jg0Sa-Ue_Ox4Ni',
  oidcSecret: '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a1U',
};

function corpusCtx(): DoctorContext {
  const envText = [
    `TELEGRAM_BOT_TOKEN=${SECRETS.telegram}`,
    'ALLOWED_USERS=111,222',
    `ADZUNA_APP_KEY=${SECRETS.adzuna}`,
    `SERPER_API_KEY=${SECRETS.serper}`,
    `WEB_TOKEN=${SECRETS.dashboardToken}`,
    `WEB_OIDC_CLIENT_SECRET=${SECRETS.oidcSecret}`,
    'WEB_OIDC_CLIENT_ID=111-abc.apps.example.invalid',
    'SEND_LIMIT_PER_RUN=1 # comment',
  ].join('\n');
  const root = ROOT;
  const virt: Record<string, string> = {
    [join(root, '.env')]: envText,
    [join(root, 'secrets/gcp-oauth.keys.json')]: JSON.stringify({ installed: { client_secret: SECRETS.googleClient } }),
    [join(root, 'secrets/gmail-credentials.json')]: JSON.stringify({ refresh_token: SECRETS.dashboardToken }),
    [join(root, 'user-data/profile.json')]: JSON.stringify({ note: SECRETS.serper }),
    [join(root, 'user-data/resume.json')]: JSON.stringify({ basics: { name: 'Synthetic Person' } }),
    [join(root, 'user-data/languages.json')]: JSON.stringify({ confirmed: false, declared: [] }),
  };
  const guarded = (p: string): boolean => /\/(\.env[^/]*|secrets|user-data|\.dashboard|\.jobber)(\/|$)/.test(p) || /data\.sqlite/.test(p);
  return {
    root,
    env: {
      TELEGRAM_BOT_TOKEN: SECRETS.telegram,
      ADZUNA_APP_KEY: SECRETS.adzuna,
      SERPER_API_KEY: SECRETS.serper,
      WEB_TOKEN: SECRETS.dashboardToken,
      WEB_OIDC_CLIENT_SECRET: SECRETS.oidcSecret,
    },
    run: async () => ({ stdout: '', code: 1 }),
    fs: {
      exists: (p) => p in virt || (!guarded(p) && existsSync(p)),
      read: (p) => {
        if (p in virt) return virt[p];
        if (guarded(p)) throw new Error('ENOENT');
        return readFileSync(p, 'utf8');
      },
      mode: (p) => (p in virt ? 0o600 : null),
      list: (p) =>
        Object.keys(virt)
          .filter((k) => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/'))
          .map((k) => k.slice(p.length + 1)),
    },
  };
}

describe('doctor secrecy corpus', () => {
  it('no check output carries a synthetic secret or a 12+ character piece of one', async () => {
    const results = await runChecks(ALL_CHECKS, corpusCtx());
    expect(results.length).toBe(ALL_CHECKS.length);
    const outputs = [formatJson(results), formatReport(results)];
    for (const [name, value] of Object.entries(SECRETS)) {
      for (const out of outputs) {
        expect(out.includes(value), `${name} appears whole`).toBe(false);
        for (let i = 0; i + 12 <= value.length; i++) {
          const piece = value.slice(i, i + 12);
          expect(out.includes(piece), `${name} piece at ${i}`).toBe(false);
        }
      }
    }
  }, 120_000);
});
