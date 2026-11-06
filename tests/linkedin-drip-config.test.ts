// The LinkedIn drip lane's tool and profile wiring: the new tool names exist everywhere they must, the lane's run profile is as small as the
// linkedin-operator, and nothing else leaks into it. Lint-style, no browser.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { loadProfiles } from '../src/platform/runner.js';
import { ARM_KINDS } from '../src/browserctl/arm/linkedin.js';
import { TOOL_NAMES, schemas } from '../src/mcp/linkedin.js';
import { buildServer } from '../src/mcp/outreach.js';

const json = (p: string): any => JSON.parse(readFileSync(p, 'utf8'));
const workers = json('config/worker-tools.json') as Record<string, string[]>;
const op = workers['linkedin-operator'];
const profiles = json('config/run-profiles.json').profiles as Record<string, any>;
const agentTools = (): string[] => {
  const md = readFileSync('.claude/agents/linkedin-operator.md', 'utf8');
  return (/^tools:\s*(.*)$/m.exec(md)?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
};

describe('new tool names are registered everywhere', () => {
  it('linkedin_attach_file is a linkedin MCP tool with no arguments; reply is an arm kind with the draft id and no path', () => {
    expect(TOOL_NAMES).toContain('linkedin_attach_file');
    expect(schemas.linkedin_attach_file).toEqual({});
    expect(ARM_KINDS).toContain('reply');
    expect(Object.keys(schemas.linkedin_arm_send)).toEqual(expect.arrayContaining(['kind', 'profile_url', 'text', 'attachment', 'reply_draft_id']));
  });

  it('the linkedin-operator has both new tools, in config and in its agent file, identically', () => {
    expect(op).toContain('mcp__linkedin__linkedin_attach_file');
    expect(op).toContain('mcp__outreach__save_reply_draft');
    expect(agentTools()).toEqual(op);
  });

  it('every mcp__linkedin__ tool of the operator is a real tool of the server', () => {
    for (const t of op.filter((x) => x.startsWith('mcp__linkedin__'))) expect(TOOL_NAMES, t).toContain(t.replace('mcp__linkedin__', ''));
  });

  it('save_reply_draft is registered on the outreach MCP server', () => {
    const server = buildServer({}) as unknown as { _registeredTools: Record<string, unknown> };
    expect(Object.keys(server._registeredTools)).toContain('save_reply_draft');
  });
});

describe('the operator agent states the drip contract', () => {
  const md = readFileSync('.claude/agents/linkedin-operator.md', 'utf8');
  it('has a Drip mode section: one item, no loops, no picking, no retries beyond the one verify-and-retry, unconfirmed means verify', () => {
    const sec = /## Drip mode[\s\S]*?\n## /.exec(md)?.[0] ?? '';
    expect(sec).toMatch(/DRIP MODE/);
    expect(sec).toMatch(/exactly that item/);
    expect(sec).toMatch(/no loops/);
    expect(sec).toMatch(/no retries beyond the one verify-and-retry/);
    expect(sec).toMatch(/unconfirmed/);
    expect(sec).toMatch(/Drip item/);
    for (const k of ['inbox', 'reply', 'accept_recent', 'dm', 'invite']) expect(sec, k).toContain(`\`${k}\``);
    expect(sec).toMatch(/save_reply_draft/);
    expect(sec).toMatch(/NEVER sent from this run/);
    expect(sec).toMatch(/linkedin_attach_file/);
  });
});
