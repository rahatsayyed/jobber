import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  MUTATING_TOOLS, NON_MUTATING_TOOLS, TOOL_NAMES, buildHandlers, buildServer, registeredToolNames, schemas,
} from '../src/mcp/applier.js';
import { SCREENED_SURFACES, callsScreen } from '../src/safety/screen.js';
import { APPLIER_TOOL_SCHEMAS } from '../src/applier/tools/index.js';
import { resolveSet, type RawSets } from '../src/platform/permissions.js';
import { makeApplier, WHY, type ApplierHarness } from './helpers/applierHarness.js';

let h: ApplierHarness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const COMMITTED = [
  'apply_open', 'apply_state', 'apply_autofill', 'apply_fill', 'apply_choose', 'apply_upload', 'apply_next',
  'apply_submit', 'apply_escalate', 'apply_recipe', 'apply_propose_recipe', 'apply_limits', 'apply_close',
  'apply_screenshot', 'site_login', 'site_signup', 'site_open_link',
];
const sets = JSON.parse(fs.readFileSync('config/permission-sets.json', 'utf8')) as RawSets;
const full = (t: string) => `mcp__applier__${t}`;

describe('applier MCP surface', () => {
  it('TOOL_NAMES equals the committed list', () => {
    expect([...TOOL_NAMES]).toEqual(COMMITTED);
    for (const t of Object.keys(APPLIER_TOOL_SCHEMAS)) expect(TOOL_NAMES).toContain(t);
    for (const t of TOOL_NAMES) expect(schemas).toHaveProperty(t);
    expect([...MUTATING_TOOLS, ...NON_MUTATING_TOOLS].sort()).toEqual([...COMMITTED].sort());
  });

  it('every mutating tool is in the kill-switch list', () => {
    const settings = JSON.parse(fs.readFileSync('.claude/settings.json', 'utf8'));
    const entry = settings.hooks.PreToolUse.find((e: { hooks: Array<{ command: string }> }) => e.hooks.some((x) => x.command.includes('kill-switch.cjs')));
    const re = new RegExp(`^(?:${entry.matcher})$`);
    for (const t of MUTATING_TOOLS) expect(re.test(full(t)), t).toBe(true);
    for (const t of NON_MUTATING_TOOLS) expect(re.test(full(t)), t).toBe(false);
  });

  it('permission sets are exact for read_only and outreach_send', () => {
    const ro = resolveSet(sets, 'read_only').filter((e) => e.startsWith('mcp__applier'));
    expect(ro.sort()).toEqual(['apply_limits', 'apply_recipe', 'apply_state'].map(full).sort());
    const os = resolveSet(sets, 'outreach_send').filter((e) => e.startsWith('mcp__applier'));
    expect(os.sort()).toEqual(TOOL_NAMES.map(full).sort());
    for (const t of MUTATING_TOOLS) expect(ro).not.toContain(full(t));
  });

  it('apply_screenshot absent unless APPLY_SCREENSHOT=true', () => {
    expect(registeredToolNames({})).not.toContain('apply_screenshot');
    expect(registeredToolNames({ APPLY_SCREENSHOT: 'false' })).not.toContain('apply_screenshot');
    expect(registeredToolNames({ APPLY_SCREENSHOT: 'true ' })).not.toContain('apply_screenshot');
    expect(registeredToolNames({ APPLY_SCREENSHOT: 'true' })).toContain('apply_screenshot');
    const reg = (env: NodeJS.ProcessEnv) => Object.keys((buildServer(buildHandlers({ env }), env) as unknown as { _registeredTools: object })._registeredTools);
    expect(reg({})).not.toContain('apply_screenshot');
    expect(reg({})).toContain('apply_submit');
    expect(reg({ APPLY_SCREENSHOT: 'true' })).toContain('apply_screenshot');
  });

  it('the new surfaces are screened and really call the screen', () => {
    for (const id of ['apply_escalate', 'applier_site_state']) {
      const s = SCREENED_SURFACES.find((x) => x.id === id);
      expect(s, id).toBeTruthy();
      expect(callsScreen(fs.readFileSync(s!.file, 'utf8')), id).toBe(true);
    }
  });

  it('is registered in .mcp.json and package.json', () => {
    expect(JSON.parse(fs.readFileSync('.mcp.json', 'utf8')).mcpServers.applier).toEqual({ command: 'npx', args: ['tsx', 'src/mcp/applier.ts'] });
    expect(JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts['mcp:applier']).toBe('tsx src/mcp/applier.ts');
  });
});

describe('applier MCP handlers', () => {
  it('no canary secret or answer value appears in any result, and extra properties are refused', async () => {
    h = makeApplier();
    const handlers = buildHandlers({
      db: h.db, runtime: h.runtime, env: h.env, answers: h.deps.answers, classifier: h.classifier,
      stopFile: h.stopFile, resumeRoot: h.deps.resumeRoot, profileEmail: 'canary@example.invalid',
      escalate: { notify: () => undefined, runId: 'r-1' },
    });
    const out: string[] = [];
    out.push(String(await handlers.apply_open({ job_id: 'job-1' })));
    out.push(String(await handlers.apply_state({})));
    out.push(String(await handlers.apply_fill({ field: 'f1', ref: { kind: 'profile', field: 'name.first' } })));
    out.push(String(await handlers.apply_limits({})));
    out.push(String(await handlers.apply_escalate({ job_id: 'job-1', reason: 'question', detail: 'CANARY-NOTE-7' })));
    out.push(String(await handlers.site_login({})));
    out.push(String(await handlers.site_signup({ purpose: 'apply' })));
    const bad = String(await handlers.apply_fill({ field: 'f1', ref: { kind: 'profile', field: 'name.first' }, value: 'typed text' }));
    const text = out.join('\n');
    expect(text).not.toContain(WHY);
    expect(text).not.toContain('canary@example.invalid');
    expect(text).not.toContain('CANARY-NOTE-7');
    expect(h.site.fills.every((f) => f.value !== 'typed text')).toBe(true);
    expect(JSON.parse(bad)).toMatchObject({ status: 'refused', code: 'invalid_input' });
    expect(JSON.parse(out[0])).toMatchObject({ status: 'ok', code: 'opened' });
    expect(JSON.parse(out[3])).toMatchObject({ dry_run: false, submit_mode: 'submit' });
  });

  it('site_open_link needs an open job', async () => {
    h = makeApplier();
    const handlers = buildHandlers({ db: h.db, runtime: h.runtime, env: h.env, answers: h.deps.answers, classifier: h.classifier, stopFile: h.stopFile });
    expect(JSON.parse(String(await handlers.site_open_link({ url_or_message_text: 'https://x.example.com/verify?token=abc' })))).toMatchObject({ code: 'no_job' });
  });
});
