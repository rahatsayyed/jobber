// tests/platform-hook-probe.test.ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { evaluateProbeLog } from '../src/platform/hookProbe.js';

const line = (o: object): string => JSON.stringify(o);

describe('evaluateProbeLog', () => {
  it('passes when the hook fired and denied inside the subagent', () => {
    const r = evaluateProbeLog([
      line({ event: 'PreToolUse', tool_name: 'Read', agent_type: 'hook-probe', agent_id: 'a1', decision: 'allow' }),
      line({ event: 'PreToolUse', tool_name: 'Read', agent_type: 'hook-probe', agent_id: 'a1', decision: 'deny' }),
    ]);
    expect(r.ok).toBe(true);
  });

  it('fails when only the main session was logged', () => {
    const r = evaluateProbeLog([line({ event: 'PreToolUse', tool_name: 'Agent', decision: 'allow' })]);
    expect(r.ok).toBe(false);
    expect(r.findings.join(' ')).toMatch(/subagent/i);
  });

  it('fails when no deny was issued inside the subagent', () => {
    const r = evaluateProbeLog([
      line({ event: 'PreToolUse', tool_name: 'Read', agent_type: 'hook-probe', agent_id: 'a1', decision: 'allow' }),
    ]);
    expect(r.ok).toBe(false);
  });

  it('ignores unparseable lines', () => {
    expect(evaluateProbeLog(['not json']).ok).toBe(false);
  });
});

describe('hook-probe.cjs', () => {
  const run = (event: unknown) =>
    spawnSync('node', ['.claude/hooks/hook-probe.cjs'], { input: JSON.stringify(event), encoding: 'utf8' });

  it('denies the marker path and allows other paths (log writing disabled for tests)', () => {
    const env = { ...process.env, HOOK_PROBE_NO_LOG: '1' };
    const deny = spawnSync('node', ['.claude/hooks/hook-probe.cjs'], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'debug/probe-deny-marker.txt' }, agent_type: 'hook-probe' }),
      encoding: 'utf8',
      env,
    });
    expect(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision).toBe('deny');
    const allow = spawnSync('node', ['.claude/hooks/hook-probe.cjs'], {
      input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: 'package.json' } }),
      encoding: 'utf8',
      env,
    });
    expect(allow.stdout.trim()).toBe('');
  });

  it('exits cleanly on garbage input', () => {
    expect(run('x' as unknown).status).toBe(0);
  });
});
