// tests/hook-kill-switch.test.ts
// Facts: before this task tool-allowlist.cjs had no STOP logic, settings.json had only the path hook,
// and run-hunt.sh / run-claude.ts never read .jobber/STOP.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadProfiles, renderSettings } from '../src/platform/runner.js';

const require = createRequire(import.meta.url);
const ROOT = resolve(__dirname, '..');
const kill = require('../.claude/hooks/kill-switch.cjs') as {
  stopActive: (root: string, env: Record<string, string>) => { stopped: boolean; reason: string };
  decide: (e: unknown, o: { root: string; env?: Record<string, string> }) => { allow: boolean; reason: string };
};
const allow = require('../.claude/hooks/tool-allowlist.cjs') as {
  decide: (e: unknown, p: unknown, o: { root: string; env?: Record<string, string> }) => { allow: boolean; reason: string };
};

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'killsw-'));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const profiles = loadProfiles(join(ROOT, 'config/run-profiles.json'), join(ROOT, 'config/permission-sets.json'));
const hunt = profiles.hunt;

const SEND_TOOLS = [
  'mcp__gmail__send_email',
  'mcp__apply__auto',
  'mcp__apply__linkedin',
  'mcp__apply__greenhouse',
  'mcp__apply__lever',
  'mcp__apply__workday',
  'mcp__apply__ashby',
  'mcp__connect__connect_send',
  'mcp__connect__send_linkedin_message',
  'mcp__linkedin__linkedin_connect_send',
  'mcp__linkedin__linkedin_send_message',
  'mcp__naukri__naukri_send_message',
];

describe('stopActive', () => {
  it('no STOP file and no JOBBER_KILL: not stopped', () => {
    expect(kill.stopActive(tmp, {}).stopped).toBe(false);
  });
  it('STOP file present: stopped', () => {
    mkdirSync(join(tmp, '.jobber'));
    writeFileSync(join(tmp, '.jobber', 'STOP'), 'x');
    expect(kill.stopActive(tmp, {}).stopped).toBe(true);
  });
  it('JOBBER_KILL=1: stopped', () => {
    expect(kill.stopActive(tmp, { JOBBER_KILL: '1' }).stopped).toBe(true);
  });
  it('.jobber is a regular file (ENOTDIR): fails closed', () => {
    writeFileSync(join(tmp, '.jobber'), 'not a dir');
    expect(kill.stopActive(tmp, {}).stopped).toBe(true);
  });
});

describe('restricted runner (hunt profile)', () => {
  for (const tool of SEND_TOOLS) {
    it(`${tool}: allowed without STOP, denied with kill switch reason when STOP exists`, () => {
      const ev = { tool_name: tool, tool_input: {} };
      expect(allow.decide(ev, hunt, { root: tmp, env: {} }).allow).toBe(true);
      mkdirSync(join(tmp, '.jobber'));
      writeFileSync(join(tmp, '.jobber', 'STOP'), 'x');
      const d = allow.decide(ev, hunt, { root: tmp, env: {} });
      expect(d.allow).toBe(false);
      expect(d.reason).toContain('kill switch');
    });
  }
});

describe('hook spawn proof', () => {
  it('denies every tool while STOP exists and allows after removal', () => {
    mkdirSync(join(tmp, '.claude', 'hooks'), { recursive: true });
    mkdirSync(join(tmp, 'config'));
    for (const f of ['tool-allowlist.cjs', 'kill-switch.cjs', 'block-outside-project.cjs']) {
      copyFileSync(join(ROOT, '.claude/hooks', f), join(tmp, '.claude/hooks', f));
    }
    copyFileSync(join(ROOT, 'config/run-profiles.json'), join(tmp, 'config/run-profiles.json'));
    // resolved profile (permission set expanded) as the launcher would render it
    const policyPath = join(tmp, 'config', 'policy.json');
    const { allow_from_permission_set: _s, allow_extra: _e, name: _n, ...rest } = hunt as unknown as Record<string, unknown>;
    void _s; void _e; void _n;
    writeFileSync(policyPath, JSON.stringify({ version: 1, profiles: { hunt: rest } }));
    const hook = join(tmp, '.claude/hooks/tool-allowlist.cjs');
    const run = () =>
      execFileSync('node', [hook, 'hunt', policyPath], {
        input: JSON.stringify({ tool_name: 'mcp__gmail__send_email', tool_input: {} }),
        encoding: 'utf8',
        env: { ...process.env, HOOK_NO_LOG: '1', JOBBER_KILL: '', JOBBER_DRY_RUN: '' },
      });
    mkdirSync(join(tmp, '.jobber'));
    writeFileSync(join(tmp, '.jobber', 'STOP'), 'x');
    const out = JSON.parse(run());
    expect(out.hookSpecificOutput.permissionDecision).toBe('deny');
    rmSync(join(tmp, '.jobber', 'STOP'));
    expect(run()).toBe('');
  });

  it('kill-switch.cjs CLI denies on malformed stdin', () => {
    let out = '';
    try {
      out = execFileSync('node', [join(ROOT, '.claude/hooks/kill-switch.cjs')], { input: 'not json', encoding: 'utf8' });
    } catch {
      out = 'threw';
    }
    expect(JSON.parse(out).hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

describe('rendered settings and committed settings.json', () => {
  it('renderSettings: first PreToolUse entry is the every-tool allowlist hook with onFailure block', () => {
    const s = renderSettings('hunt', hunt, { hookPath: '$CLAUDE_PROJECT_DIR/.claude/hooks/tool-allowlist.cjs', policyPath: '$CLAUDE_PROJECT_DIR/debug/runner/hunt.policy.json' }) as {
      hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ onFailure: string }> }> };
    };
    const first = s.hooks.PreToolUse[0];
    expect(first.matcher).toBe('.*');
    expect(first.hooks[0].onFailure).toBe('block');
  });

  const COVERED = [
    ...SEND_TOOLS,
    'mcp__connect__check_connection_status',
    'mcp__linkedin__linkedin_accept_invite',
    'mcp__naukri__naukri_click',
    'mcp__naukri__naukri_type',
  ];

  function registered(file: string): Set<string> {
    const out = new Set<string>();
    for (const m of readFileSync(join(ROOT, file), 'utf8').matchAll(/registerTool\(\s*'([A-Za-z0-9_]+)'/g)) out.add(m[1]);
    return out;
  }
  function realTools(): Set<string> {
    const all = new Set<string>(['mcp__gmail__send_email']);
    const li = readFileSync(join(ROOT, 'src/mcp/linkedin.ts'), 'utf8');
    const arr = /TOOL_NAMES = \[([\s\S]*?)\]/.exec(li)![1];
    for (const m of arr.matchAll(/'([a-z_]+)'/g)) all.add(`mcp__linkedin__${m[1]}`);
    for (const m of readFileSync(join(ROOT, 'src/mcp/naukri.ts'), 'utf8').matchAll(/'(naukri_[a-z_]+)'/g)) all.add(`mcp__naukri__${m[1]}`);
    for (const t of registered('src/mcp/apply.ts')) all.add(`mcp__apply__${t}`);
    for (const t of registered('src/mcp/connect.ts')) all.add(`mcp__connect__${t}`);
    // apply.ts registers greenhouse/lever/workday/ashby through a loop over a literal list
    for (const p of ['greenhouse', 'lever', 'workday', 'ashby']) all.add(`mcp__apply__${p}`);
    return all;
  }

  const settings = JSON.parse(readFileSync(join(ROOT, '.claude/settings.json'), 'utf8')) as {
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string; onFailure?: string }> }> };
  };
  const entry = settings.hooks.PreToolUse.find((e) => e.hooks.some((h) => h.command.includes('kill-switch.cjs')));

  it('settings.json has a kill-switch entry that blocks on failure', () => {
    expect(entry).toBeDefined();
    expect(entry!.hooks[0].onFailure).toBe('block');
  });

  it('every send/apply/connect tool is registered and matched by the kill-switch matcher', () => {
    const re = new RegExp('^(?:' + entry!.matcher + ')$');
    const real = realTools();
    for (const t of COVERED) {
      expect(real.has(t), `${t} is not a registered tool`).toBe(true);
      expect(re.test(t), `${t} not matched`).toBe(true);
    }
  });

  it('every outreach_send tool on a platform server that looks like a send is covered', () => {
    const re = new RegExp('^(?:' + entry!.matcher + ')$');
    const sets = JSON.parse(readFileSync(join(ROOT, 'config/permission-sets.json'), 'utf8')) as Record<string, { allow: string[] }>;
    for (const t of sets.outreach_send.allow) {
      const m = /^mcp__([a-z0-9-]+)__(.+)$/.exec(t);
      if (!m) continue;
      if (!['gmail', 'apply', 'connect', 'linkedin', 'naukri'].includes(m[1])) continue;
      if (!/(send|apply|connect|accept|submit|click|type)/.test(m[2])) continue;
      if (/(check_connection_status|record_connection_status)$/.test(m[2])) continue; // read-only status tools
      expect(COVERED, `${t} missing from the covered list`).toContain(t);
      expect(re.test(t), `${t} not matched`).toBe(true);
    }
  });
});

describe('gmail dry run', () => {
  it('denies gmail send with JOBBER_DRY_RUN=1 and allows other tools', () => {
    const d = allow.decide({ tool_name: 'mcp__gmail__send_email', tool_input: {} }, hunt, { root: tmp, env: { JOBBER_DRY_RUN: '1' } });
    expect(d.allow).toBe(false);
    expect(d.reason).toContain('dry run');
    const o = allow.decide({ tool_name: 'mcp__db__get_funnel', tool_input: {} }, hunt, { root: tmp, env: { JOBBER_DRY_RUN: '1' } });
    expect(o.allow).toBe(true);
  });
});
