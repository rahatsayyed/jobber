import { describe, it, expect } from 'vitest';
import { summarizeRunLog, renderRunToolCounts } from '../src/status/runs.js';

const line = (o: unknown): string => JSON.stringify(o);

describe('summarizeRunLog', () => {
  it('counts tool calls per subagent_type and tool, counts only', () => {
    const log = [
      line({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'linkedin-operator', prompt: 'SECRET' } },
        { type: 'tool_use', id: 'a2', name: 'mcp__db__sweep_deadlines', input: {} },
      ] } }),
      line({ type: 'assistant', parent_tool_use_id: 'a1', message: { content: [
        { type: 'tool_use', id: 'b1', name: 'mcp__linkedin__linkedin_snapshot', input: {} },
        { type: 'tool_use', id: 'b2', name: 'mcp__linkedin__linkedin_snapshot', input: {} },
      ] } }),
      'not json',
      line({ type: 'user', message: { content: [] } }),
    ].join('\n');
    const r = summarizeRunLog(log);
    expect(r.total).toBe(4);
    expect(r.byAgent['linkedin-operator']['mcp__linkedin__linkedin_snapshot']).toBe(2);
    expect(r.byAgent['(main)']['Agent']).toBe(1);
    expect(r.byAgent['(main)']['mcp__db__sweep_deadlines']).toBe(1);
    expect(renderRunToolCounts('r1', r)).not.toContain('SECRET');
  });
});
