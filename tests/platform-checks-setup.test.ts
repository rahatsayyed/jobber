// tests/platform-checks-setup.test.ts
import { describe, it, expect } from 'vitest';
import { setupToolingChecks, setupAccountChecks, setupChecks } from '../src/platform/checksSetup.js';
import type { CheckResult, DoctorContext } from '../src/platform/doctor.js';

interface F {
  [path: string]: { text?: string; mode?: number };
}
interface Opts {
  files?: F;
  env?: NodeJS.ProcessEnv;
  run?: DoctorContext['run'];
  sqliteTables?: DoctorContext['sqliteTables'];
}

// Fake root is the string below; no real filesystem is touched.
const R = '/proj';

function makeCtx(o: Opts = {}): DoctorContext {
  const files = o.files ?? {};
  return {
    root: R,
    env: o.env ?? {},
    run: o.run ?? (async () => ({ stdout: '', code: 1 })),
    fs: {
      exists: (p) => p in files || Object.keys(files).some((k) => k.startsWith(p + '/')),
      read: (p) => {
        if (!(p in files) || files[p].text === undefined) throw new Error('ENOENT');
        return files[p].text as string;
      },
      mode: (p) => (p in files ? (files[p].mode ?? 0o600) : null),
      list: (p) =>
        Object.keys(files)
          .filter((k) => k.startsWith(p + '/') && !k.slice(p.length + 1).includes('/'))
          .map((k) => k.slice(p.length + 1)),
    },
    sqliteTables: o.sqliteTables,
  };
}

async function one(id: string, ctx: DoctorContext): Promise<CheckResult> {
  const c = setupToolingChecks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c.run(ctx);
}

const RESUME = {
  name: 'Real Person', jobTitle: 'Dev', email: 'real@mail.test', phone: '1', summary: 's',
  experience: [], education: [], skills: [],
};
const TEMPLATE = { ...RESUME, name: 'Jane Doe', email: 'jane@example.com' };

describe('exports', () => {
  it('setupChecks combines both halves', () => {
    expect(setupAccountChecks.length).toBeGreaterThan(0);
    expect(setupChecks.length).toBe(setupToolingChecks.length + setupAccountChecks.length);
  });
  it('does not define a classifier-model placeholder', () => {
    expect(setupChecks.some((c) => c.id === 'classifier-model')).toBe(false);
  });
});

describe('node-version', () => {
  const run = (v: string): DoctorContext['run'] => async () => ({ stdout: v + '\n', code: 0 });
  it('fails on v18', async () => {
    expect((await one('node-version', makeCtx({ run: run('v18.0.0') }))).status).toBe('fail');
  });
  it('passes on v22', async () => {
    expect((await one('node-version', makeCtx({ run: run('v22.1.0') }))).status).toBe('pass');
  });
});

describe('claude-cli and claude-login', () => {
  it('cli fails when claude is not runnable', async () => {
    expect((await one('claude-cli', makeCtx())).status).toBe('fail');
  });
  it('cli passes with a version', async () => {
    const r = await one('claude-cli', makeCtx({ run: async () => ({ stdout: '2.1.0 (Claude Code)', code: 0 }) }));
    expect(r.status).toBe('pass');
  });
  it('login uses claude auth status exit code and never echoes output', async () => {
    const calls: string[][] = [];
    const ok = await one('claude-login', makeCtx({
      run: async (c, a) => {
        calls.push([c, ...a]);
        return { stdout: 'secret-ish output', code: 0 };
      },
    }));
    expect(ok.status).toBe('pass');
    expect(calls[0]).toEqual(['claude', 'auth', 'status']);
    expect(JSON.stringify(ok)).not.toContain('secret-ish');
    const bad = await one('claude-login', makeCtx({ run: async () => ({ stdout: '', code: 1 }) }));
    expect(bad.status).toBe('fail');
    expect(bad.fix).toContain('claude auth login');
  });
});

describe('sqlite-file', () => {
  it('warns when missing', async () => {
    expect((await one('sqlite-file', makeCtx())).status).toBe('warn');
  });
  it('fails on mode 644 with chmod fix', async () => {
    const r = await one('sqlite-file', makeCtx({ files: { [`${R}/data.sqlite`]: { mode: 0o644 } } }));
    expect(r.status).toBe('fail');
    expect(r.fix).toContain('chmod 600');
  });
  it('passes on 600', async () => {
    const r = await one('sqlite-file', makeCtx({ files: { [`${R}/data.sqlite`]: { mode: 0o600 } } }));
    expect(r.status).toBe('pass');
  });
  it('fails inside a served directory', async () => {
    const r = await one('sqlite-file', makeCtx({
      env: { JOBAPPLIER_DB: 'user-data/x.sqlite' },
      files: { [`${R}/user-data/x.sqlite`]: { mode: 0o600 } },
    }));
    expect(r.status).toBe('fail');
  });
  it('honours JOBAPPLIER_DB from .env', async () => {
    const r = await one('sqlite-file', makeCtx({
      files: { [`${R}/.env`]: { text: 'JOBAPPLIER_DB=/elsewhere/d.sqlite\n' }, '/elsewhere/d.sqlite': { mode: 0o600 } },
    }));
    expect(r.status).toBe('pass');
  });
});

describe('sqlite-migrations', () => {
  const files = { [`${R}/data.sqlite`]: { mode: 0o600 } };
  it('skips without sqliteTables', async () => {
    expect((await one('sqlite-migrations', makeCtx({ files }))).status).toBe('skip');
  });
  it('fails on missing tables', async () => {
    const r = await one('sqlite-migrations', makeCtx({ files, sqliteTables: () => ['jobs'] }));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('outreach_queue');
    expect(r.fix).toContain('npm run status -- json');
  });
  it('passes with all tables', async () => {
    const r = await one('sqlite-migrations', makeCtx({
      files, sqliteTables: () => ['jobs', 'outreach_queue', 'daily_counters', 'rate_events'],
    }));
    expect(r.status).toBe('pass');
  });
});

describe('env-limits', () => {
  const env = (t: string) => makeCtx({ files: { [`${R}/.env`]: { text: t } } });
  it('passes with unset keys', async () => {
    expect((await one('env-limits', env('FOO=1\n'))).status).toBe('pass');
  });
  it('fails naming key and range, never the text', async () => {
    const r = await one('env-limits', env('MATCH_THRESHOLD=500\n'));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('MATCH_THRESHOLD');
    expect(r.detail).toContain('0..100');
    expect(r.detail).not.toContain('500');
  });
  it('empty direct-reader key fails', async () => {
    const r = await one('env-limits', env('SEND_LIMIT_PER_RUN=\n'));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('SEND_LIMIT_PER_RUN');
  });
  it('inline comment on a direct-reader key fails without echoing the comment', async () => {
    const r = await one('env-limits', env('MAX_APPLIES_PER_DAY=5   # my secret note\n'));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('MAX_APPLIES_PER_DAY');
    expect(r.detail).not.toContain('secret note');
  });
  it('process env wins over .env', async () => {
    const bad = makeCtx({ files: { [`${R}/.env`]: { text: 'MATCH_THRESHOLD=500\n' } }, env: { MATCH_THRESHOLD: '60' } });
    expect((await one('env-limits', bad)).status).toBe('pass');
    const bad2 = makeCtx({ files: { [`${R}/.env`]: { text: 'MATCH_THRESHOLD=60\n' } }, env: { MATCH_THRESHOLD: '500' } });
    expect((await one('env-limits', bad2)).status).toBe('fail');
  });
  it('quoted value is read like the loaders do', async () => {
    expect((await one('env-limits', env('MATCH_THRESHOLD="60"\n'))).status).toBe('pass');
  });
  it('pair violation fails', async () => {
    const r = await one('env-limits', env('EMAIL_DRIP_MIN_BATCH=9\nEMAIL_DRIP_MAX_BATCH=2\n'));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('EMAIL_DRIP_MIN_BATCH');
  });
});

describe('env-inline-comments', () => {
  it('passes when none', async () => {
    const r = await one('env-inline-comments', makeCtx({ files: { [`${R}/.env`]: { text: 'A=1\n# c\n' } } }));
    expect(r.status).toBe('pass');
  });
  it('warns listing key names only', async () => {
    const r = await one('env-inline-comments', makeCtx({
      files: { [`${R}/.env`]: { text: 'MATCH_THRESHOLD=60   # note-text\nQ="a # b"\n' } },
    }));
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('MATCH_THRESHOLD');
    expect(r.detail).not.toContain('note-text');
    expect(r.detail).not.toMatch(/\bQ\b/);
    expect(r.fix).toBe('npm run setup -- --step limits');
  });
});

describe('config-files', () => {
  const sets = JSON.stringify({
    read_only: { allow: ['mcp__db__get_funnel'] },
    outreach_send: { extends: 'read_only', allow: ['mcp__gmail__send_email'] },
    full: { extends: 'outreach_send', allow: ['mcp__gmail'] },
  });
  const good: F = {
    [`${R}/config/target-regions.json`]: { text: JSON.stringify({ home: ['India'], targets: [] }) },
    [`${R}/config/portals.json`]: { text: JSON.stringify({ tracked_companies: [] }) },
    [`${R}/config/permission-sets.json`]: { text: sets },
  };
  it('passes', async () => {
    expect((await one('config-files', makeCtx({ files: good }))).status).toBe('pass');
  });
  it('invalid JSON fails naming the file only', async () => {
    const r = await one('config-files', makeCtx({
      files: { ...good, [`${R}/config/portals.json`]: { text: '{ secret-garbage' } },
    }));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('portals.json');
    expect(r.detail).not.toContain('secret-garbage');
  });
  it('wrong shape fails', async () => {
    const r = await one('config-files', makeCtx({
      files: { ...good, [`${R}/config/target-regions.json`]: { text: '{"home":"x"}' } },
    }));
    expect(r.status).toBe('fail');
  });
});

describe('user-data-private', () => {
  const good: F = {
    [`${R}/user-data`]: { mode: 0o700 },
    [`${R}/user-data/resume.json`]: { text: '{}', mode: 0o600 },
    [`${R}/.gitignore`]: { text: 'user-data/\nsecrets/\n' },
  };
  it('passes', async () => {
    expect((await one('user-data-private', makeCtx({ files: good }))).status).toBe('pass');
  });
  it('fails on loose dir mode', async () => {
    const r = await one('user-data-private', makeCtx({ files: { ...good, [`${R}/user-data`]: { mode: 0o755 } } }));
    expect(r.status).toBe('fail');
    expect(r.fix).toContain('chmod 700');
  });
  it('fails on loose file mode', async () => {
    const r = await one('user-data-private', makeCtx({
      files: { ...good, [`${R}/user-data/resume.json`]: { text: '{}', mode: 0o644 } },
    }));
    expect(r.status).toBe('fail');
  });
  it('fails when gitignore lacks secrets/', async () => {
    const r = await one('user-data-private', makeCtx({ files: { ...good, [`${R}/.gitignore`]: { text: 'user-data/\n' } } }));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('secrets/');
  });
});

describe('resume-valid', () => {
  const tpl = { [`${R}/user-data.example/resume.json`]: { text: JSON.stringify(TEMPLATE) } };
  const mine = (v: unknown) => ({ ...tpl, [`${R}/user-data/resume.json`]: { text: typeof v === 'string' ? v : JSON.stringify(v) } });
  it('passes a real resume', async () => {
    expect((await one('resume-valid', makeCtx({ files: mine(RESUME) }))).status).toBe('pass');
  });
  it('warns on the template', async () => {
    const r = await one('resume-valid', makeCtx({ files: mine(TEMPLATE) }));
    expect(r.status).toBe('warn');
    expect(r.detail).toContain('still the template');
  });
  it('warns on an example.com email', async () => {
    const r = await one('resume-valid', makeCtx({ files: mine({ ...RESUME, email: 'a@example.com' }) }));
    expect(r.status).toBe('warn');
  });
  it('fails on missing keys', async () => {
    expect((await one('resume-valid', makeCtx({ files: mine('{"name":"x"}') }))).status).toBe('fail');
  });
  it('fails when absent', async () => {
    expect((await one('resume-valid', makeCtx({ files: tpl }))).status).toBe('fail');
  });
});

describe('languages-confirmed and profile-valid', () => {
  const lang = (c: boolean) =>
    makeCtx({ files: { [`${R}/user-data/languages.json`]: { text: JSON.stringify({ confirmed: c, declared: [] }) } } });
  const prof = (v: unknown) =>
    makeCtx({ files: { [`${R}/user-data/profile.json`]: { text: JSON.stringify(v) } } });
  it('languages warn when unconfirmed', async () => {
    expect((await one('languages-confirmed', lang(false))).status).toBe('warn');
  });
  it('languages pass when confirmed', async () => {
    expect((await one('languages-confirmed', lang(true))).status).toBe('pass');
  });
  it('profile missing warns', async () => {
    expect((await one('profile-valid', makeCtx())).status).toBe('warn');
  });
  const GOOD = {
    version: 1, roles: ['dev'], locations: ['India'], remote_ok: true, remote_anywhere: false,
    salary: { INR: { floor: 1000000, target: 1500000 } }, notice_period_days: 30,
    work_authorization: { india: true, other: 'unknown' }, languages: ['English'],
  };
  it('profile in the Task 11 shape passes', async () => {
    expect((await one('profile-valid', prof(GOOD))).status).toBe('pass');
  });
  it('profile reports field paths only, never values', async () => {
    const r = await one('profile-valid', prof({
      ...GOOD, version: 2, salary: { INR: { floor: 5, target: 1 }, rupee: { floor: 1, target: 2 } },
      notice_period_days: 'sk-planted-secret', work_authorization: { india: 'yes', other: 'maybe' },
    }));
    expect(r.status).toBe('fail');
    for (const f of ['version', 'salary.INR', 'notice_period_days', 'work_authorization.india', 'work_authorization.other']) {
      expect(r.detail).toContain(f);
    }
    expect(r.detail).not.toContain('sk-planted-secret');
    expect(r.detail).not.toContain('rupee');
  });
  it('old salary_floors shape fails', async () => {
    expect((await one('profile-valid', prof({ salary_floors: { INR: 1500000 } }))).status).toBe('fail');
  });
  it('bad languages and non-array roles fail', async () => {
    const r = await one('profile-valid', prof({ ...GOOD, roles: 'dev', languages: [1] }));
    expect(r.detail).toContain('roles');
    expect(r.detail).toContain('languages');
  });
});

describe('mcp-config and blocking-hooks', () => {
  it('mcp-config fails when a server file is missing', async () => {
    const mcp = {
      mcpServers: {
        db: { command: 'npx', args: ['tsx', 'src/mcp/db.ts'] },
        gmail: { command: 'npx', args: ['-y', 'pkg'] },
      },
    };
    const f: F = { [`${R}/.mcp.json`]: { text: JSON.stringify(mcp) } };
    expect((await one('mcp-config', makeCtx({ files: f }))).status).toBe('fail');
    f[`${R}/src/mcp/db.ts`] = { text: '' };
    expect((await one('mcp-config', makeCtx({ files: f }))).status).toBe('pass');
  });
  it('blocking-hooks needs PreToolUse and script files', async () => {
    const st = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/block.cjs"' }] },
        ],
      },
    };
    const f: F = { [`${R}/.claude/settings.json`]: { text: JSON.stringify(st) } };
    expect((await one('blocking-hooks', makeCtx({ files: f }))).status).toBe('fail');
    f[`${R}/.claude/hooks/block.cjs`] = { text: '' };
    expect((await one('blocking-hooks', makeCtx({ files: f }))).status).toBe('pass');
    const none: F = { [`${R}/.claude/settings.json`]: { text: '{}' } };
    expect((await one('blocking-hooks', makeCtx({ files: none }))).status).toBe('fail');
  });
});

describe('chrome and browser-binaries', () => {
  it('chrome warns when absent', async () => {
    expect((await one('chrome', makeCtx())).status).toBe('warn');
  });
  it('chrome passes on macOS path', async () => {
    const r = await one('chrome', makeCtx({ files: { '/Applications/Google Chrome.app': {} } }));
    expect(r.status).toBe('pass');
  });
  it('browser-binaries fails without packages', async () => {
    const r = await one('browser-binaries', makeCtx());
    expect(r.status).toBe('fail');
    expect(r.fix).toContain('npm ci');
  });
  it('browser-binaries passes with patchright installed and asks for no browser download', async () => {
    const r = await one('browser-binaries', makeCtx({ files: { [`${R}/node_modules/patchright`]: {} } }));
    expect(r.status).toBe('pass');
    expect(`${r.detail} ${r.fix ?? ''}`).not.toMatch(/playwright|install chromium/i);
  });
});

describe('no secret leaks', () => {
  it('no detail or fix contains planted secrets', async () => {
    const SECRETS = ['sk-planted-secret', '123456:AAAAAAAAAAAAAAAA'];
    const ctx = makeCtx({
      files: {
        [`${R}/.env`]: {
          text:
            'ANTHROPIC_AUTH_TOKEN=sk-planted-secret\nTELEGRAM_BOT_TOKEN=123456:AAAAAAAAAAAAAAAA\n' +
            'MATCH_THRESHOLD=sk-planted-secret\nSEND_LIMIT_PER_RUN=1 # 123456:AAAAAAAAAAAAAAAA\n' +
            'JOBAPPLIER_DB=sk-planted-secret\n',
          mode: 0o644,
        },
        [`${R}/data.sqlite`]: { mode: 0o644 },
        [`${R}/user-data/resume.json`]: { text: 'sk-planted-secret' },
        [`${R}/user-data/profile.json`]: { text: 'sk-planted-secret' },
        [`${R}/user-data/languages.json`]: { text: 'sk-planted-secret' },
        [`${R}/config/portals.json`]: { text: 'sk-planted-secret' },
        [`${R}/.mcp.json`]: { text: 'sk-planted-secret' },
        [`${R}/.claude/settings.json`]: { text: 'sk-planted-secret' },
      },
      run: async () => ({ stdout: 'sk-planted-secret 123456:AAAAAAAAAAAAAAAA', code: 1 }),
      sqliteTables: () => [],
    });
    for (const c of setupChecks) {
      const r = await c.run(ctx);
      const blob = `${r.detail}\n${r.fix ?? ''}`;
      for (const s of SECRETS) expect(blob, c.id).not.toContain(s);
    }
  });
});

// ---- accounts, sessions, placeholders ----
async function acct(id: string, ctx: DoctorContext): Promise<CheckResult> {
  const c = setupAccountChecks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c.run(ctx);
}
type FetchFn = NonNullable<DoctorContext['fetch']>;

describe('telegram-api', () => {
  const env = { TELEGRAM_BOT_TOKEN: '123456:SECRET' };
  it('skips offline', async () => {
    expect((await acct('telegram-api', makeCtx({ env }))).status).toBe('skip');
  });
  it('passes with the username and never shows the token', async () => {
    const urls: string[] = [];
    const fetch: FetchFn = async (u) => {
      urls.push(u);
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'jobber_bot' } }) };
    };
    const r = await acct('telegram-api', { ...makeCtx({ env }), fetch });
    expect(r.status).toBe('pass');
    expect(r.detail).toBe('bot @jobber_bot');
    expect(urls[0]).toBe('https://api.telegram.org/bot123456:SECRET/getMe');
    expect(JSON.stringify(r)).not.toContain('SECRET');
  });
  it('fails on ok:false, non-ok and a throw without leaking the token', async () => {
    const mk = (f: FetchFn) => acct('telegram-api', { ...makeCtx({ env }), fetch: f });
    const a = await mk(async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) }));
    const b = await mk(async () => ({ ok: false, status: 401, json: async () => ({}) }));
    const c = await mk(async () => {
      throw new Error('failed https://api.telegram.org/bot123456:SECRET/getMe');
    });
    for (const r of [a, b, c]) {
      expect(r.status).toBe('fail');
      expect(r.fix).toBe('check TELEGRAM_BOT_TOKEN in .env');
      expect(JSON.stringify(r)).not.toContain('SECRET');
    }
  });
  it('fails without a token', async () => {
    const fetch: FetchFn = async () => ({ ok: true, status: 200, json: async () => ({}) });
    expect((await acct('telegram-api', { ...makeCtx(), fetch })).status).toBe('fail');
  });
});

describe('gmail-oauth', () => {
  it('fails when the keys file is missing', async () => {
    const r = await acct('gmail-oauth', makeCtx());
    expect(r.status).toBe('fail');
    expect(r.fix).toContain('put your Google OAuth client JSON there');
  });
  it('warns when credentials lack refresh_token, never echoing values', async () => {
    const r = await acct('gmail-oauth', makeCtx({
      files: {
        '/proj/secrets/gcp-oauth.keys.json': { text: '{"installed":{"client_secret":"TOPSECRET"}}' },
        '/proj/secrets/gmail-credentials.json': { text: '{"access_token":"TOPSECRET"}' },
      },
    }));
    expect(r.status).toBe('warn');
    expect(r.fix).toContain('auth');
    expect(JSON.stringify(r)).not.toContain('TOPSECRET');
  });
  it('passes with a refresh_token key and honours env paths', async () => {
    const r = await acct('gmail-oauth', makeCtx({
      env: { GMAIL_OAUTH_PATH: 'k.json', GMAIL_CREDENTIALS_PATH: '/abs/c.json' },
      files: { '/proj/k.json': { text: '{}' }, '/abs/c.json': { text: '{"refresh_token":"x"}' } },
    }));
    expect(r.status).toBe('pass');
  });
});

describe('sessions', () => {
  const now = () => new Date('2026-10-14T00:00:00Z');
  const past = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
  const future = Math.floor(new Date('2027-01-01T00:00:00Z').getTime() / 1000);
  const st = (cookies: unknown) => JSON.stringify({ cookies });
  const M = '/proj/secrets/linkedin-main-state.json';
  const N = '/proj/secrets/naukri-state.json';
  const good: F = {
    [M]: { text: st([{ name: 'li_at', value: 'V', expires: future }]) },
    [N]: { text: st([{ name: 'nauk_at', value: 'V', expires: future }]) },
  };
  const go = (files: F) => acct('sessions', { ...makeCtx({ files }), now });
  it('passes when both are healthy', async () => {
    expect((await go(good)).status).toBe('pass');
  });
  it('warns on missing files with commands', async () => {
    const r = await go({});
    expect(r.status).toBe('warn');
    expect(r.fix).toContain('npm run linkedin:login');
    expect(r.fix).toContain('npm run naukri:login');
    expect(r.fix).not.toContain('--account');
    expect(r.fix).not.toContain('save-');
  });
  it('fails on loose mode, empty cookies and expiry without showing values', async () => {
    expect((await go({ ...good, [N]: { text: good[N].text, mode: 0o644 } })).status).toBe('fail');
    expect((await go({ ...good, [M]: { text: st([]) } })).status).toBe('fail');
    const e = await go({ ...good, [M]: { text: st([{ name: 'li_at', value: 'V', expires: past }]) } });
    expect(e.status).toBe('fail');
    expect(e.detail).toContain('expired');
    const n = await go({ ...good, [N]: { text: st([{ name: 'nauk_at', value: 'V', expires: past }]) } });
    expect(n.status).toBe('fail');
    expect(JSON.stringify(n)).not.toContain('"V"');
  });
});

describe('placeholders', () => {
  const want: Record<string, string> = {
    'mcp-connect': 'skipped: needs a live launch, run the owner checklist in plan 7B',
    'sessions-live': 'skipped: headless login check is owner-run: npm run linkedin:check and npm run naukri:check',
    'dashboard-login': 'judged by the doctor per auth mode (plan 8C)',
    'backup-configured': 'skipped until installed (plan 7D)',
    'auto-update': 'skipped until installed (plan 7D)',
    'last-update': 'skipped until installed (plan 7D)',
  };
  for (const [id, detail] of Object.entries(want)) {
    it(id, async () => {
      const r = await acct(id, makeCtx());
      expect(r.status).toBe('skip');
      expect(r.detail).toBe(detail);
    });
  }
});
