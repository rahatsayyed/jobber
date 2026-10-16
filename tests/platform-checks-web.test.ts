import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runChecks, type DoctorContext } from '../src/platform/doctor.js';
import { webChecks } from '../src/platform/checksWeb.js';
import { cleanupRoots, copyFromRepo, ctxFor, REPO, realFs, tempRoot } from './helpers/doctorRoot.js';

afterEach(cleanupRoots);

const LIVE = { SCHEDULER_DRY_RUN: 'false', WEB_DRY_RUN: 'false', APPLY_DRY_RUN: 'false', SCOUT_DRY_RUN: 'false' };

async function run(id: string, ctx: DoctorContext, classifierReady = async () => true) {
  const check = webChecks({ classifierReady }).find((c) => c.id === id)!;
  return (await runChecks([check], ctx))[0]!.result;
}
const on = (root: string, env: NodeJS.ProcessEnv = {}) => ctxFor(root, env);

describe('web_flags', () => {
  it('passes in dry run and live with hold', async () => {
    expect((await run('web_flags', on(tempRoot(), {}))).status).toBe('pass');
    expect((await run('web_flags', on(tempRoot(), LIVE))).detail).toMatch(/hold/);
  });
  it('warns live with submit, fails live with submit while the classifier is not ready', async () => {
    const env = { ...LIVE, APPLY_SUBMIT_MODE: 'submit' };
    expect((await run('web_flags', on(tempRoot(), env))).status).toBe('warn');
    expect((await run('web_flags', on(tempRoot(), env), async () => false)).status).toBe('fail');
  });
});

describe('site_accounts', () => {
  const secrets = (root: string, dirMode = 0o700) => {
    mkdirSync(join(root, 'secrets'), { recursive: true });
    chmodSync(join(root, 'secrets'), dirMode);
  };
  const account = { 'acme.wd5.myworkdayjobs.com': { email: 'a@example.test', password: 'Aa1!aaaaaaaa', created_at: '2026-10-01', source: 'agent', verified: true } };

  it('passes when the file is absent and creation flags are off', async () => {
    const r = await run('site_accounts', on(tempRoot()));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/creation off/);
  });
  it('passes with a 0600 file in a 0700 directory', async () => {
    const root = tempRoot();
    secrets(root);
    writeFileSync(join(root, 'secrets/site-accounts.json'), JSON.stringify(account), { mode: 0o600 });
    expect((await run('site_accounts', on(root))).detail).toMatch(/1 stored account/);
  });
  it('fails on a file readable by others', async () => {
    const root = tempRoot();
    secrets(root);
    writeFileSync(join(root, 'secrets/site-accounts.json'), JSON.stringify(account));
    chmodSync(join(root, 'secrets/site-accounts.json'), 0o644);
    expect((await run('site_accounts', on(root))).status).toBe('fail');
  });
  it('fails on a symlinked accounts file', async () => {
    const root = tempRoot({ 'elsewhere.json': '{}' });
    secrets(root);
    symlinkSync(join(root, 'elsewhere.json'), join(root, 'secrets/site-accounts.json'));
    expect((await run('site_accounts', on(root))).status).toBe('fail');
  });
  it('fails on a wrong SITE_MAIL_VERIFY mode and on a password string in .env', async () => {
    expect((await run('site_accounts', on(tempRoot(), { SITE_MAIL_VERIFY: 'imap' }))).status).toBe('fail');
    const root = tempRoot({ '.env': 'SITE_PASSWORD=hunter2hunter2\n' });
    const r = await run('site_accounts', on(root));
    expect(r.status).toBe('fail');
    expect(r.detail).not.toContain('hunter2');
  });
  it('warns on gmail mode with empty senders', async () => {
    const r = await run('site_accounts', on(tempRoot(), { SITE_MAIL_VERIFY: 'gmail', SITE_MAIL_SENDERS: '' }));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/owner_assist/);
  });
  it('warns when account creation is allowed and there are no accounts', async () => {
    expect((await run('site_accounts', on(tempRoot(), { APPLY_ALLOW_ACCOUNT_CREATION: 'true' }))).status).toBe('warn');
  });
});

describe('web_wired', () => {
  const REAL = ['.claude/settings.json', 'config/worker-tools.json', '.claude/agents/apply-operator.md', 'src/applier/tools/state.ts', 'src/applier/escalate.ts', 'src/mcp/applier.ts'];
  it('passes on the committed tree', async () => {
    const r = await run('web_wired', ctxFor(REPO));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/scout: n\/a/);
  });
  it('fails when a mutating tool is outside the kill-switch matcher', async () => {
    const root = tempRoot();
    copyFromRepo(root, REAL);
    const p = join(root, '.claude/settings.json');
    const fs = realFs();
    writeFileSync(p, fs.read(p).replace('apply_(open|autofill|fill|choose|upload|next|submit|propose_recipe)', 'apply_(open|autofill|fill)'));
    const r = await run('web_wired', on(root));
    expect(r.status).toBe('fail');
    expect(r.detail).toMatch(/outside the kill switch/);
  });
  it('fails when an agent tool list drifts from config/worker-tools.json', async () => {
    const root = tempRoot();
    copyFromRepo(root, REAL);
    const p = join(root, 'config/worker-tools.json');
    const cfg = JSON.parse(realFs().read(p)) as Record<string, string[]>;
    cfg['apply-operator'] = cfg['apply-operator']!.filter((t) => t !== 'mcp__applier__apply_close');
    writeFileSync(p, JSON.stringify(cfg));
    expect((await run('web_wired', on(root))).detail).toMatch(/apply-operator tools differ/);
  });
  it('fails when a screened web surface stops calling the screen', async () => {
    const root = tempRoot();
    copyFromRepo(root, REAL);
    writeFileSync(join(root, 'src/applier/escalate.ts'), '// no screen here\nexport {};\n');
    expect((await run('web_wired', on(root))).detail).toMatch(/apply_escalate does not call the screen/);
  });
});

describe('apply_recipes', () => {
  it('passes on the shipped recipes', async () => {
    const r = await run('apply_recipes', ctxFor(REPO));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/5 shipped/);
  });
  it('warns on an invalid learned recipe, fails on an invalid shipped one', async () => {
    const root = tempRoot({ '.jobber/ats-recipes/bogus.json': '{"id":"bogus"}' });
    copyFromRepo(root, ['config/ats-recipes/greenhouse.json']);
    expect((await run('apply_recipes', on(root))).status).toBe('warn');
    writeFileSync(join(root, 'config/ats-recipes/lever.json'), '{}');
    expect((await run('apply_recipes', on(root))).status).toBe('fail');
  });
});

describe('legacy_removed', () => {
  it('passes on a clean tree', async () => {
    expect((await run('legacy_removed', on(tempRoot({ 'config/run-profiles.json': '{}' })))).status).toBe('pass');
  });
  it('fails on an mcp__apply__ string or a deleted apply file', async () => {
    expect((await run('legacy_removed', on(tempRoot({ 'config/permission-sets.json': '"mcp__apply__linkedin"' })))).status).toBe('fail');
    expect((await run('legacy_removed', on(tempRoot({ 'src/apply/linkedin.ts': '' })))).status).toBe('fail');
  });
  it('only warns for the discoverer and sender agents and mcp__discover__ (removed by 8G-1 Task 14)', async () => {
    const root = tempRoot({ '.claude/agents/sender.md': 'tools: mcp__apply__linkedin', '.claude/agents/discoverer.md': 'x', 'config/permission-sets.json': '"mcp__discover__linkedin_jobs"' });
    const r = await run('legacy_removed', on(root));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/Task 14/);
  });
});

describe('login_commands', () => {
  const pkg = JSON.stringify({ scripts: { 'naukri:login': 'x', 'linkedin:login': 'y' } });
  it('passes with both scripts and no env read', async () => {
    expect((await run('login_commands', on(tempRoot({ 'package.json': pkg, 'scripts/naukri-login.ts': 'export {}' })))).status).toBe('pass');
  });
  it('warns when a script is missing or the legacy linkedin-login still reads the env', async () => {
    expect((await run('login_commands', on(tempRoot({ 'package.json': JSON.stringify({ scripts: { 'linkedin:login': 'y' } }) })))).status).toBe('warn');
    const r = await run('login_commands', on(tempRoot({ 'package.json': pkg, 'scripts/linkedin-login.ts': 'process.env.LINKEDIN_LOGIN_ACCOUNT' })));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/Task 12/);
  });
  it('fails on an env read in any other script', async () => {
    const r = await run('login_commands', on(tempRoot({ 'package.json': pkg, 'scripts/other.ts': 'env.LINKEDIN_LOGIN_ACCOUNT' })));
    expect(r.status).toBe('fail');
  });
});

describe('apply_limits', () => {
  it('passes on defaults and shows the effective cap per platform id', async () => {
    const r = await run('apply_limits', on(tempRoot()));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/greenhouse=10/);
    expect(r.detail).toMatch(/browser=10/);
  });
  it('warns when APPLY_MAX_PER_HOST=99 is clamped', async () => {
    const r = await run('apply_limits', on(tempRoot(), { APPLY_MAX_PER_HOST: '99' }));
    expect(r.status).toBe('warn');
    expect(r.detail).toMatch(/greenhouse=50/);
  });
});

describe('browser_launch', () => {
  it('fails on a fixture file with chromium.launch', async () => {
    const root = tempRoot({ 'src/rogue.ts': 'const b = await chromium.launch({});\n' });
    const r = await run('browser_launch', on(root));
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('src/rogue.ts');
  });
  it('passes when only the home file launches, and tolerates the legacy allowlist', async () => {
    const root = tempRoot({
      'src/linkedin/browser.ts': 'await chromium.launch({});\n',
      'src/legacy.ts': 'await chromium.launch({});\n',
      'tests/browser-launch-lint.test.ts': "export const LEGACY_LAUNCH_ALLOWLIST: string[] = [\n  'src/legacy.ts',\n];\n",
    });
    const r = await run('browser_launch', on(root));
    expect(r.status).toBe('pass');
    expect(r.detail).toMatch(/1 legacy file/);
  });
  it('fails when a scripted-apply file is still allowlisted, and passes on the committed tree', async () => {
    const root = tempRoot({ 'tests/browser-launch-lint.test.ts': "export const LEGACY_LAUNCH_ALLOWLIST: string[] = [\n  'src/apply/linkedin.ts',\n];\n" });
    expect((await run('browser_launch', on(root))).status).toBe('fail');
    expect((await run('browser_launch', ctxFor(REPO))).status).toBe('pass');
  });
});

describe('registration', () => {
  it('every new check id is in the doctor list and the JSON output', async () => {
    const { allDoctorChecks } = await import('../src/platform/checkLists.js');
    const ids = allDoctorChecks().map((c) => c.id);
    for (const id of ['source_status', 'search_providers', 'generated_providers', 'web_flags', 'site_accounts', 'web_wired', 'apply_recipes', 'legacy_removed', 'login_commands', 'apply_limits', 'browser_launch']) {
      expect(ids.filter((x) => x === id), id).toHaveLength(1);
    }
  });
});
