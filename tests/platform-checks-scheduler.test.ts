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

const TOOLS = { 'due-followups': ['Skill', 'mcp__a__b'], 'new-outreach': ['mcp__c__d'], 'inbox-recruiter-replies': ['Skill'], 'naukri-search': ['mcp__e__f'] };
const agent = (tools: string[]) => `---\nname: x\ntools: ${tools.join(', ')}\n---\nbody\n`;
const goodAgents = (): Files => {
  const f: Files = { '/p/config/worker-tools.json': { text: JSON.stringify(TOOLS) } };
  for (const [k, v] of Object.entries(TOOLS)) f[`/p/.claude/agents/${k}.md`] = { text: agent(v) };
  return f;
};

describe('scheduler doctor checks', () => {
  it('has the six kebab-case ids', () => {
    expect(schedulerChecks().map((c) => c.id)).toEqual([
      'scheduler-tmux', 'scheduler-lock-dir', 'scheduler-stop-file', 'scheduler-dry-run', 'scheduler-units', 'agents-worker-tools',
    ]);
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

  it('dry run state reports dry or LIVE and never the env values', async () => {
    const dry = (await run(ctxWith({})))['scheduler-dry-run'];
    expect(dry).toMatchObject({ status: 'pass', detail: 'dry' });
    const live = (await run(ctxWith({}, { env: { SCHEDULER_DRY_RUN: 'false', LINKEDIN_DRY_RUN: 'false' } })))['scheduler-dry-run'];
    expect(live.status).toBe('warn');
    expect(live.detail).toMatch(/^LIVE/);
    const fromFile = await run(ctxWith({ '/p/.env': { text: 'SCHEDULER_DRY_RUN=false\nLINKEDIN_DRY_RUN=false\n' } }));
    expect(fromFile['scheduler-dry-run'].detail).toMatch(/^LIVE/);
    const both = await run(ctxWith({}, { env: { SCHEDULER_DRY_RUN: 'false', LINKEDIN_DRY_RUN: 'false', JOBBER_DRY_RUN: '1' } }));
    expect(both['scheduler-dry-run'].detail).toBe('dry');
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
    drift['/p/.claude/agents/new-outreach.md'] = { text: agent(['mcp__c__d', 'Bash']) };
    const r = await run(ctxWith(drift));
    expect(r['agents-worker-tools'].status).toBe('fail');
    expect(r['agents-worker-tools'].detail).toContain('new-outreach');
    const missing = goodAgents();
    delete missing['/p/config/worker-tools.json'];
    expect((await run(ctxWith(missing)))['agents-worker-tools'].status).toBe('fail');
  });
});
