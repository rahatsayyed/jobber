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

  it('the wake profile also allows both (it dispatches the operator for discovery and manual pages)', () => {
    expect(profiles.outreach_wake.allow).toEqual(expect.arrayContaining(['mcp__linkedin__linkedin_attach_file', 'mcp__outreach__save_reply_draft']));
  });
});

describe('profile linkedin_drip', () => {
  const p = profiles.linkedin_drip;
  it('exists, loads, and allows exactly the linkedin-operator tools (minus the Skill builtin)', () => {
    expect(p).toBeDefined();
    expect(p.allow).toEqual(op.filter((t) => t !== 'Skill'));
    const loaded = loadProfiles('config/run-profiles.json', 'config/permission-sets.json').linkedin_drip;
    expect(loaded.allow).toEqual(p.allow);
  });
  it('is restricted: only Skill, Agent and Task builtins, no Bash, files or web, and not an unrestricted session', () => {
    expect(p.builtin_tools).toEqual(['Skill', 'Agent', 'Task']);
    expect(p.unrestricted_builtins).toBeUndefined();
    expect(p.interactive).toBeUndefined();
  });
  it('holds no other platform, no email, no apply and no scout tool', () => {
    for (const t of p.allow as string[]) expect(t, t).toMatch(/^mcp__(linkedin|outreach|db)__/);
    expect((p.allow as string[]).filter((t) => t.startsWith('mcp__db__'))).toEqual(['mcp__db__list_queued_outreach', 'mcp__db__update_outreach_status']);
    expect(p.allow.join()).not.toMatch(/gmail|naukri|wellfound|applier|scout|raw_query|send_email/);
  });
  it('screens the arguments of everything that carries third-party or model text, all inside the allow list', () => {
    expect(p.screen_args).toEqual(expect.arrayContaining(['mcp__linkedin__linkedin_arm_send', 'mcp__linkedin__linkedin_type', 'mcp__outreach__escalate', 'mcp__outreach__record_inbound', 'mcp__outreach__save_reply_draft']));
    for (const t of p.screen_args as string[]) expect(p.allow, t).toContain(t);
  });
  it('has an allowlisted env with no secret keys, and only the LinkedIn pacing and cap keys by prefix', () => {
    expect(p.env_mode).toBe('allowlist');
    expect(p.env_keys).toEqual(expect.arrayContaining(['JOBBER_RUN_ID', 'JOBBER_DRY_RUN', 'TZ']));
    for (const k of [...p.env_keys, ...p.env_prefixes] as string[]) expect(k, k).not.toMatch(/KEY|SECRET|TOKEN|PASSWORD|GMAIL|HUNTER|SERPER|SEND_LIMIT/);
    expect(p.env_prefixes).toContain('LINKEDIN_');
  });
  it('its MCP config starts only the db, outreach and linkedin servers', () => {
    expect(existsSync(p.mcp_config)).toBe(true);
    expect(Object.keys(json(p.mcp_config).mcpServers).sort()).toEqual(['db', 'linkedin', 'outreach']);
  });
  it('the scheduler runs it under the trigger name and lock the docs name', () => {
    const src = readFileSync('src/scheduler/linkedinDrip.ts', 'utf8');
    expect(src).toContain("LI_DRIP_PROFILE = 'linkedin_drip'");
    expect(src).toContain("LI_DRIP_TRIGGER = 'linkedin_drip'");
    expect(src).toContain("LI_DRIP_LOCK = 'linkedin'");
    expect(readFileSync('scripts/scheduler.ts', 'utf8')).toMatch(/linkedinDrip: args\.mode === 'daemon'/);
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
