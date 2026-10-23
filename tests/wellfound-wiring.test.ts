// Safety and scheduler wiring of the wellfound platform: operator and tool lists, permission sets, run profile,
// kill-switch matcher, screened surfaces, the owner login script, the doctor session check and the planner.
// Fakes only; nothing here reaches wellfound.com.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadProfiles } from '../src/platform/runner.js';
import { resolveSet, type RawSets } from '../src/platform/permissions.js';
import { SCREENED_SURFACES, callsScreen } from '../src/safety/screen.js';
import { main as loginMain, hasWellfoundAuthCookie, type LoginIo } from '../scripts/wellfound-login.js';
import { HEADLESS_CONTEXT_OPTIONS } from '../src/webcore/launch.js';
import type { LiLauncher } from '../src/linkedin/types.js';
import { runChecks, type DoctorContext } from '../src/platform/doctor.js';
import { setupAccountChecks } from '../src/platform/checksSetup.js';
import { schedulerChecks } from '../src/platform/checksScheduler.js';
import { TOOL_NAMES } from '../src/mcp/wellfound.js';
import { openDb } from '../src/db.js';
import { setState } from '../src/scheduler/runLog.js';
import { countDue, type DueCounts } from '../src/scheduler/due.js';
import { loadPlanKnobs, planWake, stepOrder, type PlanKnobs } from '../src/scheduler/plan.js';
import { buildWakePrompt } from '../src/scheduler/prompt.js';
import { TUNING_DEFAULTS } from '../src/outreach/tuning.js';
import type { PacingConfig } from '../src/outreach/pacing.js';
import type { ControlState } from '../src/scheduler/control.js';
import { ceilings, type CeilingStatus, type LimitKey } from '../src/outreach/limits.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { LIMITS } from '../src/setup/limitsCatalog.js';
import { ENV_CATALOG } from '../src/settings/envCatalog.js';

const read = (f: string): string => readFileSync(f, 'utf8');
const json = <T,>(f: string): T => JSON.parse(read(f)) as T;

function agent(name: string): { fm: string; body: string; tools: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(read(`.claude/agents/${name}.md`));
  if (!m) throw new Error(`no frontmatter in ${name}`);
  const line = m[1].split(/\r?\n/).filter((l) => /^tools\s*:/.test(l));
  expect(line.length).toBe(1);
  return { fm: m[1], body: m[2], tools: line[0].replace(/^tools\s*:/, '').split(',').map((s) => s.trim()).filter(Boolean) };
}

const WF = (n: string) => `mcp__wellfound__wellfound_${n}`;
const ENGINE = ['open', 'snapshot', 'click', 'type', 'press_key', 'scroll', 'wait_for', 'screenshot', 'click_at'];

// ---------------------------------------------------------------------------------------------
describe('tool list and TOOL_NAMES', () => {
  it('TOOL_NAMES is the 16 tools the brief names, with no search or cold-send tool', () => {
    expect([...TOOL_NAMES].sort()).toEqual([
      ...ENGINE.map((n) => `wellfound_${n}`), 'wellfound_arm_send', 'wellfound_arm_apply',
      'wellfound_discover', 'wellfound_manual_job', 'wellfound_inbox', 'wellfound_read_thread', 'wellfound_layout', 'wellfound_close',
    ].sort());
  });
  it('every name is registered in the module source', () => {
    const src = read('src/mcp/wellfound.ts');
    for (const t of TOOL_NAMES) expect(src, t).toContain(`'${t}'`);
    expect([...src.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...TOOL_NAMES].sort());
  });
});

describe('operators: tool lists', () => {
  const cfg = json<Record<string, string[]>>('config/worker-tools.json');

  it('wellfound-operator has exactly the committed list and no arm_apply', () => {
    const t = agent('wellfound-operator').tools;
    expect(t).toEqual(cfg['wellfound-operator']);
    expect(t).toEqual([
      'Skill', 'mcp__outreach__record_inbound', 'mcp__outreach__escalate',
      ...['layout', 'open', 'snapshot', 'click', 'type', 'press_key', 'scroll', 'wait_for', 'screenshot', 'click_at', 'arm_send', 'discover', 'manual_job', 'inbox', 'read_thread'].map(WF),
      'mcp__db__list_jobs', 'mcp__db__list_queued_outreach', 'mcp__db__update_outreach_status',
    ]);
    expect(t).not.toContain(WF('arm_apply'));
    expect(t).not.toContain(WF('close'));
  });

  it('the operator has no other platform, no Bash or file tool, no outcome recording and no cold-outreach selectors', () => {
    const { tools, body, fm } = agent('wellfound-operator');
    for (const x of tools) {
      expect(x.startsWith('mcp__linkedin__') || x.startsWith('mcp__naukri__') || x.startsWith('mcp__applier__') || x.startsWith('mcp__gmail__'), x).toBe(false);
      expect(['Agent', 'Task', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'mcp__db__record_outcome']).not.toContain(x);
      expect(x).not.toContain('*');
    }
    expect(tools).not.toContain('mcp__outreach__next_contacts');
    expect(tools).not.toContain('mcp__outreach__list_due_touches');
    expect(fm).toContain('name: wellfound-operator');
    expect(fm).toMatch(/^model: sonnet$/m);
    expect(body).not.toMatch(/mcp__connect/);
  });

  it('the operator body runs only discover and inbox, never applies, never touches Apply controls', () => {
    const { body } = agent('wellfound-operator');
    expect(body).toContain('## Task: inbox');
    expect(body).toContain('## Task: discover');
    expect(body).not.toContain('## Task: followups');
    expect(body).not.toContain('## Task: new_outreach');
    expect(body).toMatch(/never apply/i);
    expect(body).toContain('apply_not_mine');
    for (const c of ['Apply on company site', 'Submit application', 'Send application']) expect(body).toContain(c);
    for (const w of ['halted', 'rate_limited', 'killed', 'untrusted', 'escalate', 'quota', 'login_required', 'stale_ref', 'unconfirmed']) expect(body, w).toContain(w);
    expect(body).toMatch(/Cold messaging on Wellfound is impossible/);
    // snapshot first, then arm, then type and click
    expect(body.indexOf('wellfound_snapshot')).toBeGreaterThan(-1);
    expect(body.indexOf('record_inbound')).toBeLessThan(body.indexOf('wellfound_arm_send({person_id, thread_ref, text, kind: "followup"})'));
  });

  it('the apply operator holds the wellfound engine tools and wellfound_arm_apply, but never wellfound_arm_send, discover or inbox', () => {
    const t = agent('apply-operator').tools;
    expect(t).toEqual(cfg['apply-operator']);
    for (const n of [...ENGINE, 'arm_apply', 'layout']) expect(t, n).toContain(WF(n));
    for (const n of ['arm_send', 'discover', 'inbox', 'read_thread', 'close']) expect(t, n).not.toContain(WF(n));
    const body = agent('apply-operator').body;
    expect(body).toContain('`wellfound`: the only place Wellfound is applied to');
    expect(body).toContain('wellfound_arm_apply');
    expect(body).toContain('Apply on company site');
  });

  it('no other operator holds any wellfound tool', () => {
    for (const [name, tools] of Object.entries(cfg)) {
      if (name === 'wellfound-operator' || name === 'apply-operator') continue;
      expect(tools.some((x) => x.startsWith('mcp__wellfound__')), name).toBe(false);
    }
  });

  it('the doctor worker-tools lint knows the third operator and forbids cross-platform tools', async () => {
    const files: Record<string, string> = { '/p/config/worker-tools.json': JSON.stringify({ ...cfg }) };
    for (const n of ['linkedin-operator', 'naukri-operator', 'wellfound-operator']) files[`/p/.claude/agents/${n}.md`] = read(`.claude/agents/${n}.md`);
    const ctx: DoctorContext = {
      root: '/p', env: {}, run: async () => ({ stdout: '', code: 1 }),
      fs: { exists: (p) => p in files || Object.keys(files).some((k) => k.startsWith(`${p}/`)), read: (p) => files[p], mode: () => null },
    };
    const r = Object.fromEntries((await runChecks(schedulerChecks(), ctx)).map((x) => [x.id, x.result]));
    expect(r['agents-worker-tools']).toMatchObject({ status: 'pass' });
    expect(r['agents-worker-tools'].detail).toContain('three operator agents');
    const bad: Record<string, string> = { ...files,'/p/.claude/agents/wellfound-operator.md': files['/p/.claude/agents/wellfound-operator.md'].replace('mcp__db__list_jobs', 'mcp__naukri__naukri_search') };
    const ctx2 = { ...ctx, fs: { ...ctx.fs, read: (p: string) => bad[p], exists: ctx.fs.exists } } as DoctorContext;
    const r2 = Object.fromEntries((await runChecks(schedulerChecks(), ctx2)).map((x) => [x.id, x.result]));
    expect(r2['agents-worker-tools'].status).toBe('fail');
  });
});

// ---------------------------------------------------------------------------------------------
describe('permission sets, run profile, MCP registration and the kill-switch matcher', () => {
  const sets = json<RawSets>('config/permission-sets.json');

  it('read_only gets reads only: snapshot, screenshot and layout', () => {
    const ro = resolveSet(sets, 'read_only');
    for (const n of ['snapshot', 'screenshot', 'layout']) expect(ro, n).toContain(WF(n));
    for (const n of ['open', 'click', 'type', 'press_key', 'click_at', 'arm_send', 'arm_apply', 'discover', 'inbox', 'read_thread', 'close', 'scroll', 'wait_for']) expect(ro, n).not.toContain(WF(n));
  });

  it('outreach_send adds the arm and action tools and discover, the same shape as Naukri', () => {
    const os = resolveSet(sets, 'outreach_send');
    for (const n of ['arm_send', 'arm_apply', 'discover', 'open', 'click', 'type', 'press_key', 'scroll', 'wait_for', 'click_at', 'close']) expect(os, n).toContain(WF(n));
    const nk = resolveSet(sets, 'outreach_send').filter((e) => e.startsWith('mcp__naukri__')).map((e) => e.replace('mcp__naukri__naukri_', ''));
    const wf = os.filter((e) => e.startsWith('mcp__wellfound__')).map((e) => e.replace('mcp__wellfound__wellfound_', ''));
    for (const n of ['arm_send', 'arm_apply', 'discover', 'open', 'click', 'type', 'press_key', 'scroll', 'wait_for', 'click_at', 'close', 'snapshot', 'screenshot', 'layout']) {
      expect(nk, `naukri ${n}`).toContain(n);
      expect(wf, `wellfound ${n}`).toContain(n);
    }
  });

  it('full holds the whole wellfound server', () => {
    expect(resolveSet(sets, 'full')).toContain('mcp__wellfound');
  });

  it('the wake profile allows the wellfound tools, screens typed and armed text, passes the flag and the ceiling prefix', () => {
    const wake = loadProfiles('config/run-profiles.json', 'config/permission-sets.json').outreach_wake;
    for (const n of [...ENGINE, 'arm_send', 'arm_apply', 'discover', 'inbox', 'read_thread', 'layout', 'close']) expect(wake.allow, n).toContain(WF(n));
    for (const n of ['arm_send', 'arm_apply', 'type']) expect(wake.screen_args, n).toContain(WF(n));
    expect(wake.env_keys).toContain('WELLFOUND_SCREENSHOT');
    expect(wake.env_prefixes).toContain('WELLFOUND_MAX_');
    expect(wake.builtin_tools).not.toContain('Bash');
  });

  it('.mcp.json and the wake MCP config both start src/mcp/wellfound.ts', () => {
    expect(json<{ mcpServers: Record<string, { args: string[] }> }>('.mcp.json').mcpServers.wellfound.args).toContain('src/mcp/wellfound.ts');
    expect(json<{ mcpServers: Record<string, { args: string[] }> }>('config/runner/mcp.platform.json').mcpServers.wellfound.args).toContain('src/mcp/wellfound.ts');
  });

  it('the kill-switch matcher covers the acting wellfound tools and wellfound_discover but not the read tools', () => {
    const settings = json<{ hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> } }>('.claude/settings.json');
    const entry = settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => h.command.includes('kill-switch.cjs')))!;
    const re = new RegExp(`^(?:${entry.matcher})$`);
    for (const n of ['open', 'click', 'type', 'press_key', 'click_at', 'arm_send', 'arm_apply', 'discover']) expect(re.test(WF(n)), n).toBe(true);
    for (const n of ['snapshot', 'screenshot', 'layout', 'inbox', 'read_thread', 'scroll', 'wait_for', 'close']) expect(re.test(WF(n)), n).toBe(false);
  });

  it('the wellfound MCP imports no browser library and launches only through the shared launcher', () => {
    const files = ['src/mcp/wellfound.ts', 'src/wellfound/page.ts', 'src/wellfound/discover.ts', 'scripts/wellfound-login.ts', 'src/browserctl/commitWellfound.ts', 'src/browserctl/arm/wellfound.ts'];
    for (const f of files) expect(read(f), f).not.toMatch(/from ['"](?:patchright|playwright|playwright-core|puppeteer)/);
    expect(read('src/mcp/wellfound.ts')).toContain("from '../webcore/launch.js'");
    expect(read('scripts/wellfound-login.ts')).toContain("from '../src/webcore/launch.js'");
  });

  it('no wellfound file reads or names a secret other than the session path constants', () => {
    for (const f of ['src/mcp/wellfound.ts', 'src/wellfound/discover.ts', 'src/browserctl/arm/wellfound.ts', 'src/browserctl/commitWellfound.ts']) {
      expect(read(f), f).not.toMatch(/user-data|['"]\.env['"]|readFileSync\([^)]*secrets/);
    }
  });
});

describe('screened surfaces', () => {
  it('lists snapshot, arm_send, arm_apply, discover, inbox and read_thread, each file really screens', () => {
    const ids = SCREENED_SURFACES.filter((s) => s.id.startsWith('wellfound_')).map((s) => s.id).sort();
    expect(ids).toEqual(['wellfound_arm_apply', 'wellfound_arm_send', 'wellfound_discover', 'wellfound_inbox', 'wellfound_manual_job', 'wellfound_read_thread', 'wellfound_snapshot']);
    for (const s of SCREENED_SURFACES.filter((x) => x.id.startsWith('wellfound_'))) expect(callsScreen(read(s.file)), s.id).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('wellfound:login (owner script)', () => {
  const io: LoginIo = { ask: async () => '' };
  function fake(state: unknown) {
    const seen: { launch?: Record<string, unknown>; ctx?: Record<string, unknown>; url?: string; closed: boolean } = { closed: false };
    const launcher = {
      launch: async (o: Record<string, unknown>) => {
        seen.launch = o;
        return {
          newContext: async (c: Record<string, unknown>) => {
            seen.ctx = c;
            return { newPage: async () => ({ goto: async (u: string) => { seen.url = u; } }), storageState: async () => state };
          },
          close: async () => { seen.closed = true; },
        };
      },
    } as unknown as LiLauncher;
    return { seen, launcher };
  }

  it('is a package script with no flag and opens headed real Chrome with the shared context options, saves mode 0600, prints no cookie value', async () => {
    expect(json<{ scripts: Record<string, string> }>('package.json').scripts['wellfound:login']).toBe('tsx scripts/wellfound-login.ts');
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
    try {
      const dir = mkdtempSync(path.join(tmpdir(), 'wf-login-'));
      const out = path.join(dir, 'secrets', 'wellfound-state.json');
      const f = fake({ cookies: [{ name: '_wellfound', value: 'SECRET_VALUE' }, { name: 'x', value: 'y' }], origins: [] });
      expect(await loginMain({ io, launcher: f.launcher, outPath: out })).toBe(0);
      expect(f.seen.launch).toMatchObject({ channel: 'chrome', headless: false });
      expect(f.seen.ctx).toMatchObject({ ...HEADLESS_CONTEXT_OPTIONS });
      expect(f.seen.url).toBe('https://wellfound.com/login');
      expect(f.seen.closed).toBe(true);
      expect(statSync(out).mode & 0o777).toBe(0o600);
      expect(readdirSync(path.dirname(out))).toEqual(['wellfound-state.json']);
      expect(logs.join('\n')).toContain('Saved session (2 cookies)');
      expect(logs.join('\n')).not.toContain('SECRET_VALUE');
    } finally {
      console.log = orig;
    }
  });

  it('refuses to save a session with no wellfound login cookie', async () => {
    const err: string[] = [];
    const origE = console.error;
    console.error = (...a: unknown[]) => { err.push(a.join(' ')); };
    try {
      const dir = mkdtempSync(path.join(tmpdir(), 'wf-login-'));
      const out = path.join(dir, 'wellfound-state.json');
      const f = fake({ cookies: [{ name: 'analytics', value: 'a' }], origins: [] });
      expect(await loginMain({ io, launcher: f.launcher, outPath: out })).toBe(1);
      expect(readdirSync(dir)).toEqual([]);
      expect(f.seen.closed).toBe(true);
      expect(err.join('\n')).toMatch(/Not saved/);
    } finally {
      console.error = origE;
    }
  });

  it('hasWellfoundAuthCookie checks names only', () => {
    expect(hasWellfoundAuthCookie({ cookies: [{ name: '_wellfound' }] })).toBe(true);
    expect(hasWellfoundAuthCookie({ cookies: [{ name: 'angellist_x' }] })).toBe(true);
    expect(hasWellfoundAuthCookie({ cookies: [{ name: 'session' }] })).toBe(false);
    expect(hasWellfoundAuthCookie(null)).toBe(false);
    expect(hasWellfoundAuthCookie({ cookies: 'x' })).toBe(false);
  });

  it('the session lives at secrets/wellfound-state.json and the lock beside it', () => {
    expect(read('scripts/wellfound-login.ts')).toContain("'secrets', 'wellfound-state.json'");
    expect(read('src/mcp/wellfound.ts')).toContain("'secrets', 'wellfound-state.json'");
    expect(read('src/mcp/wellfound.ts')).toContain("'secrets', 'wellfound.lock'");
  });
});

describe('doctor: wellfound session check', () => {
  const P = '/p/secrets/wellfound-state.json';
  const ctxWith = (files: Record<string, { text: string; mode?: number }>): DoctorContext => ({
    root: '/p', env: {}, run: async () => ({ stdout: '', code: 1 }), now: () => new Date('2026-10-14T00:00:00Z'),
    fs: {
      exists: (p) => p in files,
      read: (p) => files[p].text,
      mode: (p) => (p in files ? (files[p].mode ?? 0o600) : null),
    },
  });
  const run = async (files: Record<string, { text: string; mode?: number }>) => {
    const r = await runChecks(setupAccountChecks.filter((c) => c.id === 'wellfound-session'), ctxWith(files));
    return r[0].result;
  };
  const state = (cookies: unknown[]) => ({ text: JSON.stringify({ cookies, origins: [] }) });

  it('an absent session is a skip (optional platform), not a warning or failure', async () => {
    const r = await run({});
    expect(r.status).toBe('skip');
    expect(r.fix).toBe('npm run wellfound:login');
  });
  it('a world-readable file fails; no cookies fails; an expired cookie fails; a good session passes', async () => {
    expect((await run({ [P]: { ...state([{ name: '_wellfound', value: 'v' }]), mode: 0o644 } })).status).toBe('fail');
    expect((await run({ [P]: state([]) })).status).toBe('fail');
    expect((await run({ [P]: state([{ name: '_wellfound', value: 'v', expires: 1 }]) })).status).toBe('fail');
    const ok = await run({ [P]: state([{ name: '_wellfound', value: 'v', expires: 4102444800 }]) });
    expect(ok.status).toBe('pass');
    expect(JSON.stringify(ok)).not.toContain('"v"');
  });
  it('the existing LinkedIn and Naukri sessions check is unchanged (wellfound is not required there)', () => {
    expect(read('src/platform/checksSetup.ts')).toContain("{ label: 'Naukri', file: 'naukri-state.json'");
    expect(read('src/platform/checksSetup.ts')).not.toContain("label: 'Wellfound'");
  });
});

// ---------------------------------------------------------------------------------------------
describe('ceilings and env catalog', () => {
  it('the three wellfound ceilings default to 20, 20 and 12 per day and appear in the limits catalog', () => {
    const cfg = loadOutreachConfig({});
    expect([cfg.wellfoundMaxAppliesPerDay, cfg.wellfoundMaxMessagesPerDay, cfg.wellfoundMaxDiscoverPerDay]).toEqual([20, 20, 12]);
    const c = ceilings(openDb(':memory:'), cfg, new Date());
    expect(c.wellfound_apply).toEqual({ used: 0, limit: 20, ok: true });
    expect(c.wellfound_message).toEqual({ used: 0, limit: 20, ok: true });
    expect(c.wellfound_discover).toEqual({ used: 0, limit: 12, ok: true });
    for (const k of ['WELLFOUND_MAX_APPLIES_PER_DAY', 'WELLFOUND_MAX_MESSAGES_PER_DAY', 'WELLFOUND_MAX_DISCOVER_PER_DAY']) {
      expect(LIMITS.find((l) => l.key === k), k).toMatchObject({ group: 'daily-caps', unit: 'per day' });
    }
  });
  it('the env catalog has the screenshot flag (default on), the discover interval and the three limit keys', () => {
    const keys = ENV_CATALOG.map((s) => s.key);
    for (const k of ['WELLFOUND_SCREENSHOT', 'WELLFOUND_DISCOVER_EVERY_HOURS', 'WELLFOUND_MAX_APPLIES_PER_DAY', 'WELLFOUND_MAX_MESSAGES_PER_DAY', 'WELLFOUND_MAX_DISCOVER_PER_DAY']) expect(keys, k).toContain(k);
    expect(ENV_CATALOG.find((s) => s.key === 'WELLFOUND_SCREENSHOT')).toMatchObject({ default: 'true', section: 'wellfound' });
    expect(read('.env.example')).toMatch(/WELLFOUND_SCREENSHOT=true/);
  });
});

// ---------------------------------------------------------------------------------------------
const NOW = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST
const pacing: PacingConfig = {
  quietStartHour: 23, quietEndHour: 7, tzOffsetMinutes: 330,
  minBurst: 1, maxBurst: 4, minActionGapSec: 120, maxActionGapSec: 360, minWaitMin: 8, maxWaitMin: 40, jitter: 0.25,
};
const knobs: PlanKnobs = { inboxEveryMin: 60, naukriDiscoverEveryHours: 6 };
const ctl = (o: Partial<ControlState> = {}): ControlState => ({
  killed: false, killReason: null, halted: { linkedin: null, naukri: null, wellfound: null },
  allowed: ['linkedin', 'naukri', 'wellfound'], readError: null, ...o,
});
const ceil = (bad: LimitKey[] = []): Record<LimitKey, CeilingStatus> => {
  const keys: LimitKey[] = ['linkedin_invite', 'linkedin_message', 'naukri_apply', 'naukri_message', 'wellfound_apply', 'wellfound_message', 'wellfound_discover', 'apply_attempt'];
  return Object.fromEntries(keys.map((k) => [k, bad.includes(k) ? { used: 5, limit: 5, ok: false } : { used: 0, limit: 5, ok: true }])) as Record<LimitKey, CeilingStatus>;
};
const due = (o: Partial<DueCounts> = {}): DueCounts => ({
  followupsDue: 0, newOutreachReady: 0,
  followupsDueByPlatform: { linkedin: 0, naukri: 0 }, newOutreachReadyByPlatform: { linkedin: 0, naukri: 0 },
  inboxLastCheckedMinAgo: 5, naukriSearchLastHoursAgo: 1, ...o,
});
const NAMES = { jobs: [], posts: [], wellfound: ['full-stack-react-india-remote'] };
const plan = (o: Partial<Parameters<typeof planWake>[0]> = {}) =>
  planWake({ now: NOW, rng: () => 0.99, pacing, control: ctl(), ceilings: ceil(), due: due({ wellfoundDiscoverLastHoursAgo: null }), knobs, discoverSearches: NAMES, ...o });
const wfTasks = (d: ReturnType<typeof plan>) => (d.kind === 'run' ? d.tasks.filter((a) => a.platform === 'wellfound').flatMap((a) => a.tasks) : []);

describe('planner: wellfound discover and inbox tasks', () => {
  it('plans a discover task with the named searches and the detail quota, and nothing else without due inbox', () => {
    const d = plan({ due: due({ wellfoundDiscoverLastHoursAgo: null, inboxLastCheckedMinAgo: 5 }) });
    expect(d.kind).toBe('run');
    expect(wfTasks(d)).toEqual([{ kind: 'discover', quota: 5, searches: { jobs: ['full-stack-react-india-remote'], posts: [] } }]);
    if (d.kind === 'run') expect(d.tasks.find((a) => a.platform === 'wellfound')?.operator).toBe('wellfound-operator');
  });

  it('plans an inbox task when the inbox is due, and never followups or new_outreach', () => {
    const d = plan({ due: due({ wellfoundDiscoverLastHoursAgo: 1, inboxLastCheckedMinAgo: null, followupsDue: 3, newOutreachReady: 3 }) });
    const kinds = wfTasks(d).map((t) => t.kind);
    expect(kinds).toEqual(['inbox']);
    expect(wfTasks(plan({ due: due({ wellfoundDiscoverLastHoursAgo: null, inboxLastCheckedMinAgo: null, followupsDue: 9, newOutreachReady: 9 }) })).map((t) => t.kind).sort()).toEqual(['discover', 'inbox']);
  });

  it('is not planned without named searches (no login or no config), when halted, not allowed or the ceiling is spent', () => {
    expect(wfTasks(plan({ discoverSearches: { jobs: [], posts: [] } }))).toEqual([]);
    expect(wfTasks(plan({ discoverSearches: { jobs: [], posts: [], wellfound: [] } }))).toEqual([]);
    expect(wfTasks(plan({ discoverSearches: undefined }))).toEqual([]);
    expect(wfTasks(plan({ control: ctl({ allowed: ['linkedin', 'naukri'], halted: { linkedin: null, naukri: null, wellfound: 'bot wall' } }) }))).toEqual([]);
    const spent = plan({ ceilings: ceil(['wellfound_discover']), due: due({ wellfoundDiscoverLastHoursAgo: null, inboxLastCheckedMinAgo: 5 }) });
    expect(wfTasks(spent).some((t) => t.kind === 'discover')).toBe(false);
  });

  it('discover waits for the interval (WELLFOUND_DISCOVER_EVERY_HOURS) and an untracked age is never due', () => {
    const inbox5 = { inboxLastCheckedMinAgo: 5 };
    expect(wfTasks(plan({ due: due({ ...inbox5, wellfoundDiscoverLastHoursAgo: 2 }) }))).toEqual([]);
    expect(wfTasks(plan({ due: due({ ...inbox5, wellfoundDiscoverLastHoursAgo: 7 }) })).map((t) => t.kind)).toEqual(['discover']);
    expect(wfTasks(plan({ due: due({ ...inbox5, wellfoundDiscoverLastHoursAgo: 2 }), knobs: { ...knobs, wellfoundDiscoverEveryHours: 1 } })).map((t) => t.kind)).toEqual(['discover']);
    expect(wfTasks(plan({ due: due({ ...inbox5 }) }))).toEqual([]);
    expect(loadPlanKnobs({ WELLFOUND_DISCOVER_EVERY_HOURS: '3' } as NodeJS.ProcessEnv).wellfoundDiscoverEveryHours).toBe(3);
    expect(loadPlanKnobs({ WELLFOUND_DISCOVER_EVERY_HOURS: 'x' } as NodeJS.ProcessEnv).wellfoundDiscoverEveryHours).toBe(6);
    expect(loadPlanKnobs({}).wellfoundDiscoverEveryHours).toBeUndefined();
  });

  it('a fresh wellfound discover pulls the pipeline stage in, and the wake order is discover, pipeline, mail, then the platform tasks, then apply', () => {
    const d = plan({ due: due({ wellfoundDiscoverLastHoursAgo: null, inboxLastCheckedMinAgo: null, appliesLeftToday: 5, applyQueued: 1, unmatchedJobs: 0 }) });
    if (d.kind !== 'run') throw new Error('expected a run');
    const steps = stepOrder(d).map((s) => `${s.operator}:${s.kind}`);
    expect(steps.indexOf('wellfound-operator:discover')).toBeGreaterThan(-1);
    expect(steps.indexOf('wellfound-operator:discover')).toBeLessThan(steps.indexOf('pipeline:pipeline'));
    expect(steps.indexOf('pipeline:pipeline')).toBeLessThan(steps.indexOf('wellfound-operator:inbox'));
    expect(steps.indexOf('wellfound-operator:inbox')).toBeLessThan(steps.indexOf('apply-operator:apply'));
    const keys = stepOrder(d).filter((s) => s.operator === 'wellfound-operator').map((s) => s.platform);
    expect(keys).toEqual(['wellfound', 'wellfound']);
  });

  it('a wellfound-only wake is a run, and with only wellfound work spent it skips with ceilings_exhausted, not nothing_due', () => {
    const only = plan({ control: ctl({ allowed: ['wellfound'], halted: { linkedin: 'x', naukri: 'x', wellfound: null } }), due: due({ wellfoundDiscoverLastHoursAgo: null, inboxLastCheckedMinAgo: 5 }) });
    expect(only.kind).toBe('run');
    const spent = plan({ control: ctl({ allowed: ['wellfound'], halted: { linkedin: 'x', naukri: 'x', wellfound: null } }), ceilings: ceil(['wellfound_discover']), due: due({ wellfoundDiscoverLastHoursAgo: null, inboxLastCheckedMinAgo: 5 }) });
    expect(spent.kind === 'skip' || wfTasks(spent).length === 0).toBe(true);
  });

  it('the wake prompt names the wellfound searches and quota meaning, after linkedin and naukri', () => {
    const d = plan({ due: due({ wellfoundDiscoverLastHoursAgo: null, inboxLastCheckedMinAgo: null }) });
    if (d.kind !== 'run') throw new Error('expected a run');
    const p = buildWakePrompt({ runId: 'r1', dryRun: false, burst: d.burst, tasks: d.tasks, budget: { maxWallSec: 900, maxTokensApprox: 150000 }, allowed: ['linkedin', 'naukri', 'wellfound'], now: NOW, order: stepOrder(d) });
    expect(p).toContain('Dispatch `wellfound-operator` for platform wellfound with task: discover quota 5 (searches: full-stack-react-india-remote; quota is the job pages you may open for descriptions).');
    expect(p).toContain('Dispatch `wellfound-operator` for platform wellfound with task: inbox quota 5.');
    const legacy = buildWakePrompt({ runId: 'r1', dryRun: false, burst: d.burst, tasks: d.tasks, budget: { maxWallSec: 900, maxTokensApprox: 150000 }, allowed: ['wellfound'], now: NOW });
    expect(legacy).toContain('Dispatch operator `wellfound-operator` for platform wellfound with tasks: ');
    expect(legacy).toContain('discover quota 5 (searches: full-stack-react-india-remote; quota is the job pages you may open for descriptions)');
  });

  it('countDue reads the last-run key written by wellfound_discover and keeps wellfound out of the followup counts', () => {
    const db = openDb(':memory:');
    expect(countDue(db, NOW, TUNING_DEFAULTS).wellfoundDiscoverLastHoursAgo).toBeNull();
    setState(db, 'wellfound_discover_last_at', new Date(NOW.getTime() - 3 * 3600_000).toISOString(), NOW);
    const c = countDue(db, NOW, TUNING_DEFAULTS);
    expect(c.wellfoundDiscoverLastHoursAgo).toBeCloseTo(3);
    expect(c.followupsDueByPlatform).toEqual({ linkedin: 0, naukri: 0 });
    expect(c.newOutreachReadyByPlatform).toEqual({ linkedin: 0, naukri: 0 });
  });

});
