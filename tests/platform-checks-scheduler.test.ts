import { describe, it, expect } from 'vitest';
import { runChecks, type DoctorContext } from '../src/platform/doctor.js';
import { schedulerChecks } from '../src/platform/checksScheduler.js';

interface Files { [path: string]: { text: string; mode?: number } }

function ctxWith(files: Files, opts: { tmux?: string | null; env?: NodeJS.ProcessEnv } = {}): DoctorContext {
  return {
    root: '/p',
    env: opts.env ?? {},
    run: async (cmd, args) => {
      if (cmd === 'tmux' && args[0] === '-V') {
        return opts.tmux === null ? { stdout: '', code: 1 } : { stdout: opts.tmux ?? 'tmux 3.4', code: 0 };
      }
      return { stdout: '', code: 1 };
    },
    fs: {
      exists: (p) => p in files || Object.keys(files).some((k) => k.startsWith(p + '/')),
      read: (p) => files[p].text,
      mode: (p) => (p in files ? (files[p].mode ?? 0o700) : null),
    },
  };
}

const run = async (ctx: DoctorContext) => {
  const res = await runChecks(schedulerChecks(), ctx);
  return Object.fromEntries(res.map((r) => [r.id, r.result]));
};

const TOOLS = {
  'linkedin-operator': ['Skill', 'mcp__linkedin__linkedin_layout', 'mcp__outreach__escalate'],
  'naukri-operator': ['Skill', 'mcp__naukri__naukri_layout', 'mcp__outreach__escalate'],
  'wellfound-operator': ['Skill', 'mcp__wellfound__wellfound_layout', 'mcp__outreach__escalate'],
};
const agent = (tools: string[]) => `---\nname: x\ntools: ${tools.join(', ')}\n---\nbody\n`;
const goodAgents = (): Files => {
  const f: Files = { '/p/config/worker-tools.json': { text: JSON.stringify(TOOLS) } };
  for (const [k, v] of Object.entries(TOOLS)) f[`/p/.claude/agents/${k}.md`] = { text: agent(v) };
  return f;
};

describe('scheduler doctor checks', () => {
  it('mail-drip-config: defaults pass, an inverted window or gap fails', async () => {
    expect((await run(ctxWith({})))['mail-drip-config'].status).toBe('pass');
    const bad = (env: NodeJS.ProcessEnv) => run(ctxWith({}, { env }));
    expect((await bad({ EMAIL_SEND_WINDOW_START: '19:00', EMAIL_SEND_WINDOW_END: '09:30' }))['mail-drip-config'].status).toBe('fail');
    expect((await bad({ EMAIL_DRIP_MIN_GAP_MIN: '9', EMAIL_DRIP_MAX_GAP_MIN: '8' }))['mail-drip-config'].status).toBe('fail');
    expect((await bad({ EMAIL_DRIP_MIN_BATCH: '4', EMAIL_DRIP_MAX_BATCH: '3' }))['mail-drip-config'].status).toBe('fail');
    expect((await bad({ EMAIL_SEND_WINDOW_START: 'nine' }))['mail-drip-config'].status).toBe('fail');
  });

  it('linkedin-drip-config: defaults and an explicit off pass, a bad value or an inverted gap fails and says why', async () => {
    expect((await run(ctxWith({})))['linkedin-drip-config'].status).toBe('pass');
    const ok = (env: NodeJS.ProcessEnv) => run(ctxWith({}, { env }));
    expect((await ok({ LINKEDIN_DRIP: 'false' }))['linkedin-drip-config'].status).toBe('pass');
    expect((await ok({ LINKEDIN_DRIP_MIN_GAP_MIN: '12', LINKEDIN_DRIP_MAX_GAP_MIN: '30' }))['linkedin-drip-config'].detail).toMatch(/12-30 min/);
    for (const env of [{ LINKEDIN_DRIP: 'sometimes' }, { LINKEDIN_DRIP_MIN_GAP_MIN: '30', LINKEDIN_DRIP_MAX_GAP_MIN: '10' }, { LINKEDIN_INBOX_MIN_GAP_MIN: '1' }, { LINKEDIN_DRIP_MAX_GAP_MIN: 'soon' }]) {
      const r = (await ok(env))['linkedin-drip-config'];
      expect(r.status, JSON.stringify(env)).toBe('fail');
      expect(r.detail).toMatch(/does nothing until fixed/);
    }
  });

  it('linkedin-easy-apply: off by default passes, a misspelled value warns, on warns about a missing answer file and a zero cap', async () => {
    const ok = (env: NodeJS.ProcessEnv) => run(ctxWith({}, { env }));
    expect((await ok({}))['linkedin-easy-apply']).toMatchObject({ status: 'pass', detail: expect.stringMatching(/apply:manual/) });
    expect((await ok({ APPLY_LINKEDIN_EASY: 'false' }))['linkedin-easy-apply'].status).toBe('pass');
    expect((await ok({ APPLY_LINKEDIN_EASY: 'yes' }))['linkedin-easy-apply'].status).toBe('warn');
    const on = (await ok({ APPLY_LINKEDIN_EASY: 'true', LINKEDIN_DRIP: 'false', LINKEDIN_MAX_EASY_APPLIES_PER_DAY: '0' }))['linkedin-easy-apply'];
    expect(on.status).toBe('warn');
    expect(on.detail).toMatch(/drip lane is off/);
    expect(on.detail).toMatch(/is 0/);
  });

  it('has the eleven kebab-case ids', () => {
    expect(schedulerChecks().map((c) => c.id)).toEqual([
      'scheduler-tmux', 'scheduler-lock-dir', 'scheduler-stop-file', 'scheduler-dry-run', 'mail-drip-config', 'run-budget-config', 'linkedin-active-hours', 'linkedin-drip-config', 'linkedin-easy-apply', 'dry-run-legacy-keys', 'scheduler-units', 'agents-worker-tools', 'window-foundation',
    ]);
  });

  it('window-foundation warns when the mail window started with another daily limit than EMAIL_MAX_PER_DAY now gives', async () => {
    const base: Files = {
      '/p/scripts/claude-window.sh': { text: '' }, '/p/scripts/window-env.ts': { text: '' }, '/p/.claude/hooks/window-guard.cjs': { text: '' },
    };
    const rec = (v: string): Files => ({ ...base, '/p/.jobber/window-start/mail.json': { text: JSON.stringify({ SEND_LIMIT_PER_RUN: v }) } });
    const stale = (await run(ctxWith(rec('100000'), { env: { WINDOW_LANES: 'mail', EMAIL_MAX_PER_DAY: '20' } })))['window-foundation'];
    expect(stale.status).toBe('warn');
    expect(stale.detail).toMatch(/EMAIL_MAX_PER_DAY/);
    const same = (await run(ctxWith(rec('20'), { env: { WINDOW_LANES: 'mail', EMAIL_MAX_PER_DAY: '20' } })))['window-foundation'];
    expect(same.detail).not.toMatch(/started with/);
    const off = (await run(ctxWith(rec('100000'), { env: { EMAIL_MAX_PER_DAY: '20' } })))['window-foundation'];
    expect(off.status).toBe('skip');
  });

  it('window-foundation warns when the linkedin window started with another dry-run flag, Easy Apply switch or limit than .env gives now', async () => {
    const base: Files = {
      '/p/scripts/claude-window.sh': { text: '' }, '/p/scripts/window-env.ts': { text: '' }, '/p/.claude/hooks/window-guard.cjs': { text: '' },
    };
    const rec = (o: Record<string, string>): Files => ({ ...base, '/p/.jobber/window-start/linkedin.json': { text: JSON.stringify(o) } });
    const stale = (await run(ctxWith(rec({ JOBBER_DRY_RUN: 'true', APPLY_LINKEDIN_EASY: '' }), { env: { WINDOW_LANES: 'linkedin', JOBBER_DRY_RUN: 'false' } })))['window-foundation'];
    expect(stale.status).toBe('warn');
    expect(stale.detail).toMatch(/JOBBER_DRY_RUN/);
    expect(stale.detail).toMatch(/restart the linkedin window|started with/);
    const same = (await run(ctxWith(rec({ JOBBER_DRY_RUN: 'true' }), { env: { WINDOW_LANES: 'linkedin', JOBBER_DRY_RUN: 'true' } })))['window-foundation'];
    expect(same.detail).not.toMatch(/started with/);
    const off = (await run(ctxWith(rec({ JOBBER_DRY_RUN: 'true' }), { env: { JOBBER_DRY_RUN: 'false' } })))['window-foundation'];
    expect(off.status).toBe('skip');
  });

  it('window-foundation, wake lane: warns on a changed start value, a missing config window, a missing dispatcher or a window that is not running', async () => {
    const base: Files = {
      '/p/scripts/claude-window.sh': { text: '' }, '/p/scripts/window-env.ts': { text: '' }, '/p/.claude/hooks/window-guard.cjs': { text: '' },
      '/p/src/scheduler/windowDispatch.ts': { text: '' },
      '/p/config/manager-windows.json': { text: JSON.stringify({ windows: { sources: {}, pipeline: {}, boards: {}, apply: {} } }) },
    };
    const env = { WINDOW_LANES: 'wake' };
    const fine = (await run(ctxWith(base, { env })))['window-foundation'];
    expect(fine.status).toBe('warn');
    expect(fine.detail).toMatch(/lanes through windows: wake/);
    const stale = (await run(ctxWith({ ...base, '/p/.jobber/window-start/boards.json': { text: JSON.stringify({ JOBBER_DRY_RUN: 'true', MAX_APPLIES_PER_DAY: '5' }) } }, { env: { ...env, JOBBER_DRY_RUN: 'false' } })))['window-foundation'];
    expect(stale.detail).toMatch(/boards \(JOBBER_DRY_RUN/);
    const noCfg = (await run(ctxWith({ ...base, '/p/config/manager-windows.json': { text: JSON.stringify({ windows: { sources: {} } }) } }, { env })))['window-foundation'];
    expect(noCfg.detail).toMatch(/no window: pipeline, boards, apply/);
    const { '/p/src/scheduler/windowDispatch.ts': _gone, ...noDisp } = base;
    expect((await run(ctxWith(noDisp, { env })))['window-foundation'].detail).toMatch(/dispatcher .* is missing/);
    // the lane off: the wake windows are not looked at
    expect((await run(ctxWith(base, { env: {} })))['window-foundation'].status).toBe('skip');
  });

  it('window-foundation, wake lane: a required window that tmux does not list is reported', async () => {
    const files: Files = {
      '/p/scripts/claude-window.sh': { text: '' }, '/p/scripts/window-env.ts': { text: '' }, '/p/.claude/hooks/window-guard.cjs': { text: '' },
      '/p/src/scheduler/windowDispatch.ts': { text: '' },
      '/p/config/manager-windows.json': { text: JSON.stringify({ windows: { sources: {}, pipeline: {}, boards: {}, apply: {}, linkedin: {} } }) },
    };
    const ctx = ctxWith(files, { env: { WINDOW_LANES: 'wake,linkedin' } });
    ctx.run = async (cmd, args) => (cmd === 'tmux' && args[0] === 'list-windows' ? { stdout: 'sources\npipeline\nboards\n', code: 0 } : { stdout: '', code: 1 });
    const r = (await run(ctx))['window-foundation'];
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/not running: apply, linkedin/);
  });

  it('tmux version gate', async () => {
    expect((await run(ctxWith({})))['scheduler-tmux'].status).toBe('pass');
    expect((await run(ctxWith({}, { tmux: 'tmux 3.2a' })))['scheduler-tmux'].status).toBe('pass');
    expect((await run(ctxWith({}, { tmux: 'tmux next-3.5' })))['scheduler-tmux'].status).toBe('pass');
    expect((await run(ctxWith({}, { tmux: 'tmux 3.1c' })))['scheduler-tmux'].status).toBe('fail');
    expect((await run(ctxWith({}, { tmux: 'tmux 2.9' })))['scheduler-tmux'].status).toBe('fail');
    expect((await run(ctxWith({}, { tmux: null })))['scheduler-tmux'].status).toBe('fail');
    expect((await run(ctxWith({}, { tmux: 'tmux wat' })))['scheduler-tmux'].status).toBe('warn');
  });

  it('lock dir: absent passes, read-only fails', async () => {
    expect((await run(ctxWith({})))['scheduler-lock-dir'].status).toBe('pass');
    expect((await run(ctxWith({ '/p/.jobber': { text: '', mode: 0o500 } })))['scheduler-lock-dir'].status).toBe('fail');
    expect((await run(ctxWith({ '/p/.jobber': { text: '', mode: 0o700 } })))['scheduler-lock-dir'].status).toBe('pass');
  });

  it('STOP file is reported', async () => {
    expect((await run(ctxWith({})))['scheduler-stop-file'].status).toBe('pass');
    expect((await run(ctxWith({ '/p/.jobber/STOP': { text: 'x' } })))['scheduler-stop-file'].status).toBe('warn');
  });

  it('dry run mode prints MODE: DRY RUN or MODE: LIVE, never env values; unset runs LIVE', async () => {
    const dry = (await run(ctxWith({}, { env: { JOBBER_DRY_RUN: 'true' } })))['scheduler-dry-run'];
    expect(dry).toMatchObject({ status: 'pass', detail: 'MODE: DRY RUN' });
    const unset = (await run(ctxWith({})))['scheduler-dry-run'];
    expect(unset.status).toBe('warn');
    expect(unset.detail).toMatch(/^MODE: LIVE/);
    expect(unset.detail).toMatch(/not set/);
    const live = (await run(ctxWith({}, { env: { JOBBER_DRY_RUN: 'false' } })))['scheduler-dry-run'];
    expect(live.status).toBe('warn');
    expect(live.detail).toMatch(/^MODE: LIVE/);
    const fromFile = await run(ctxWith({ '/p/.env': { text: 'JOBBER_DRY_RUN=false\n' } }));
    expect(fromFile['scheduler-dry-run'].detail).toMatch(/^MODE: LIVE/);
    const fileDry = await run(ctxWith({ '/p/.env': { text: 'JOBBER_DRY_RUN=TRUE\n' } }));
    expect(fileDry['scheduler-dry-run'].detail).toBe('MODE: DRY RUN');
    const legacyOnly = await run(ctxWith({}, { env: { SCHEDULER_DRY_RUN: 'true', LINKEDIN_DRY_RUN: 'true' } }));
    expect(legacyOnly['scheduler-dry-run'].detail).toMatch(/^MODE: LIVE/);
  });

  it('warns once, by name only, about leftover legacy *_DRY_RUN keys and ignores them', async () => {
    const clean = (await run(ctxWith({ '/p/.env': { text: 'JOBBER_DRY_RUN=true\n' } })))['dry-run-legacy-keys'];
    expect(clean.status).toBe('pass');
    const text = 'JOBBER_DRY_RUN=true\nSCHEDULER_DRY_RUN=SECRETISH-1\nLINKEDIN_DRY_RUN=false\nWEB_DRY_RUN=true\nAPPLY_DRY_RUN=true\nSCOUT_DRY_RUN=true\n';
    const r = await run(ctxWith({ '/p/.env': { text } }));
    const w = r['dry-run-legacy-keys'];
    expect(w.status).toBe('warn');
    for (const k of ['SCHEDULER_DRY_RUN', 'LINKEDIN_DRY_RUN', 'WEB_DRY_RUN', 'APPLY_DRY_RUN', 'SCOUT_DRY_RUN']) expect(w.detail).toContain(k);
    expect(w.detail).toMatch(/ignored/);
    expect(w.fix).toMatch(/remove/);
    expect(JSON.stringify(r)).not.toContain('SECRETISH-1');
    expect(r['scheduler-dry-run'].detail).toBe('MODE: DRY RUN');
  });

  it('units generated', async () => {
    expect((await run(ctxWith({})))['scheduler-units'].status).toBe('skip');
    const one = await run(ctxWith({ '/p/.jobber/units/jobber-scheduler.service': { text: '' } }));
    expect(one['scheduler-units'].status).toBe('warn');
    const both = await run(ctxWith({
      '/p/.jobber/units/jobber-scheduler.service': { text: '' },
      '/p/.jobber/units/dev.jobber.scheduler.plist': { text: '' },
    }));
    expect(both['scheduler-units'].status).toBe('pass');
  });

  it('worker tools lint', async () => {
    expect((await run(ctxWith(goodAgents())))['agents-worker-tools'].status).toBe('pass');
    const drift = goodAgents();
    drift['/p/.claude/agents/naukri-operator.md'] = { text: agent(['mcp__naukri__naukri_layout', 'Skill', 'mcp__outreach__escalate', 'Bash']) };
    const r = await run(ctxWith(drift));
    expect(r['agents-worker-tools'].status).toBe('fail');
    expect(r['agents-worker-tools'].detail).toContain('naukri-operator');
    const missing = goodAgents();
    delete missing['/p/config/worker-tools.json'];
    expect((await run(ctxWith(missing)))['agents-worker-tools'].status).toBe('fail');
  });

  it('fails when a retired worker file still exists', async () => {
    for (const w of ['due-followups', 'new-outreach', 'inbox-recruiter-replies', 'naukri-search']) {
      const f = goodAgents();
      f[`/p/.claude/agents/${w}.md`] = { text: agent(['Skill']) };
      const r = await run(ctxWith(f));
      expect(r['agents-worker-tools'].status).toBe('fail');
      expect(r['agents-worker-tools'].detail).toContain(w);
    }
  });

  it('fails when an operator lists Agent, Bash, Read, Write, Edit or a tool of the other platform', async () => {
    const bad: Array<[string, string]> = [
      ['linkedin-operator', 'Agent'], ['linkedin-operator', 'Bash'], ['linkedin-operator', 'Read'],
      ['linkedin-operator', 'Write'], ['linkedin-operator', 'Edit'],
      ['linkedin-operator', 'mcp__naukri__naukri_search'], ['naukri-operator', 'mcp__linkedin__linkedin_state'],
      ['wellfound-operator', 'mcp__naukri__naukri_search'], ['wellfound-operator', 'mcp__linkedin__linkedin_state'],
      ['linkedin-operator', 'mcp__wellfound__wellfound_discover'], ['naukri-operator', 'mcp__wellfound__wellfound_discover'],
    ];
    for (const [op, tool] of bad) {
      // config and agent file agree, so only the policy check can fail
      const f = goodAgents();
      const tools = [...(TOOLS as Record<string, string[]>)[op], tool];
      f['/p/config/worker-tools.json'] = { text: JSON.stringify({ ...TOOLS, [op]: tools }) };
      f[`/p/.claude/agents/${op}.md`] = { text: agent(tools) };
      const r = await run(ctxWith(f));
      expect(r['agents-worker-tools'].status, `${op} ${tool}`).toBe('fail');
      expect(r['agents-worker-tools'].detail).toContain(tool);
    }
  });
});
