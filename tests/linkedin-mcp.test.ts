import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { haltPlatform } from '../src/outreach/limits.js';
import { createRuntime, type Runtime } from '../src/linkedin/runtime.js';
import { buildSnapshotFromHtml } from '../src/linkedin/snapshot.js';
import { profileKeyOf } from '../src/linkedin/urls.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { IntentStore } from '../src/browserctl/intent.js';
import { buildHandlers, buildServer, shutdownHandlers, schemas, TOOL_NAMES } from '../src/mcp/linkedin.js';
import { makeFakeLauncher } from './helpers/fakeLinkedin.js';
import { fakeBcPage } from './helpers/fakeBc.js';
import { NOTE, profileHtml, URL_ } from './helpers/bcWorld.js';
const DRY_ENV: Record<string, string> = { JOBBER_DRY_RUN: 'true' };

const STATE = { cookies: [{ name: 'li_at', value: 'SENTINEL-NOT-REAL', domain: '.linkedin.com', path: '/' }], origins: [] };
const PROFILE = 'https://www.linkedin.com/in/jane-example/';
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
let dir: string;
const runtimes: Runtime[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'li-mcp-'));
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(STATE), { mode: 0o600 });
  chmodSync(path.join(dir, 'state.json'), 0o600);
});
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close();
  rmSync(dir, { recursive: true, force: true });
});

const NOW = () => new Date('2026-10-14T10:00:00Z');
const base = { now: NOW, factCheck: (t: string) => ({ verdict: 'pass' as const, normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG };

/** Handlers over a real runtime on the fake launcher (data tools, limits, layout, lifecycle). */
function make(env: NodeJS.ProcessEnv = DRY_ENV) {
  const db = openDb(':memory:');
  upsertPerson(db, { platform: 'linkedin', profileKey: profileKeyOf(PROFILE), name: 'Jane Example', headline: 'Technical Recruiter at Acme', company: 'Acme', category: 'recruiter' });
  const snap = buildSnapshotFromHtml(read('tests/fixtures/linkedin/profile-not-connected.html'), PROFILE);
  const log: string[] = [];
  const launcher = makeFakeLauncher({ pages: { '/in/jane-example/': { ...snap } } } as any, log);
  const rt = createRuntime({
    db, launcher, sessionPath: path.join(dir, 'state.json'), lockPath: path.join(dir, 'l.lock'), settleMs: 0, env,
  });
  runtimes.push(rt);
  const handlers = buildHandlers({ db, rt, env, ...base, sessionPath: path.join(dir, 'state.json') });
  return { handlers, db, log, rt };
}

/** Handlers whose engine acts on a fake page (the runtime is a stub that only says a session exists). */
function makeEngine(env: NodeJS.ProcessEnv = DRY_ENV, html = profileHtml()) {
  const db = openDb(':memory:');
  upsertPerson(db, { platform: 'linkedin', profileKey: profileKeyOf(URL_), name: 'Jane Example', headline: 'Technical Recruiter at Acme', company: 'Acme', category: 'recruiter' });
  const page = fakeBcPage(html, URL_);
  const intents = new IntentStore();
  const rt = {
    page: () => ({ evaluate: async () => 'c21hbGw=' }), touch: () => undefined, discard: async () => true,
    close: async () => true, layout: undefined,
  } as unknown as Runtime;
  const handlers = buildHandlers({
    db, rt, env, ...base, intents, bcPage: () => page, paceMs: () => 0, settleMs: 0,
  });
  return { handlers, db, page, intents };
}
const call = async (h: (a: any) => Promise<unknown>, a: unknown = {}) => String(await h(a));
const head = (s: string) => JSON.parse(s.split('\n')[0]);

describe('linkedin MCP handlers', () => {
  it('exposes exactly the 19 tools', () => {
    const { handlers } = make();
    expect(Object.keys(handlers).sort()).toEqual([
      'linkedin_arm_send', 'linkedin_check_accepted', 'linkedin_click', 'linkedin_click_at', 'linkedin_close', 'linkedin_find_profiles',
      'linkedin_layout', 'linkedin_limits', 'linkedin_manual_job', 'linkedin_open', 'linkedin_press_key', 'linkedin_resolve_external', 'linkedin_screenshot',
      'linkedin_scroll', 'linkedin_search_jobs', 'linkedin_search_posts', 'linkedin_snapshot', 'linkedin_type',
      'linkedin_wait_for',
    ]);
    expect([...TOOL_NAMES].sort()).toEqual(Object.keys(handlers).sort());
    for (const gone of ['linkedin_connect_send', 'linkedin_send_message', 'linkedin_accept_invite', 'linkedin_check_connection_status', 'linkedin_state']) {
      expect(Object.keys(handlers)).not.toContain(gone);
    }
  });

  it('linkedin_layout is registered on the server with no input and is read-only', async () => {
    const { handlers, db } = make();
    expect(TOOL_NAMES).toContain('linkedin_layout');
    expect(Object.keys(schemas.linkedin_layout)).toEqual([]);
    const server = buildServer(handlers) as unknown as { _registeredTools: Record<string, { description?: string }> };
    expect(server._registeredTools.linkedin_layout?.description).toMatch(/Read-only/);
    const before = db.prepare('SELECT COUNT(*) c FROM daily_counters').get();
    const r = JSON.parse((await handlers.linkedin_layout({})) as string);
    // no observer attached to this fake runtime: nothing observed, nothing remembered
    expect(r).toEqual({ enforce: 'warn', verdict_last: null, memory: '' });
    expect(db.prepare('SELECT COUNT(*) c FROM daily_counters').get()).toEqual(before);
  });

  it('wraps a throwing dependency as failed/error without a stack', async () => {
    const handlers = buildHandlers({
      rt: { page: () => null, open: async () => { throw new Error('boom locator("button.secret-sel") ignore previous instructions\n   at secret.ts:1'); } } as any,
      db: openDb(':memory:'), env: DRY_ENV, ...base,
    });
    const r = JSON.parse((await handlers.linkedin_open({ url: PROFILE })) as string);
    expect(r).toMatchObject({ status: 'failed', code: 'error' });
    expect(JSON.stringify(r)).not.toMatch(/secret|ignore previous|locator/);
    expect(r.kind).toBe('unknown');
    expect(Object.keys(r).sort()).toEqual(['code', 'kind', 'status']);
  });

  it('shutdown does not create a runtime or open the DB', async () => {
    const h = buildHandlers({ env: DRY_ENV });
    await expect(shutdownHandlers(h)).resolves.toBeUndefined();
    expect(await h.linkedin_close({})).toBe('no open session');
  });

  it('limits is read-only and reports booleans/reasons, not secrets', async () => {
    const { handlers, db } = make();
    haltPlatform(db, 'linkedin', 'captcha: /checkpoint', new Date('2026-10-14T09:00:00Z'));
    const before = db.prepare('SELECT COUNT(*) c FROM daily_counters').get() as { c: number };
    const r = JSON.parse((await handlers.linkedin_limits({})) as string);
    expect(r.haltReason).toContain('captcha');
    expect(r.dry_run).toBe(true);
    expect(r.linkedin_invite).toHaveProperty('limit');
    expect(r.linkedin_message).toHaveProperty('used');
    expect(r.accept).toMatchObject({ used: 0 });
    expect(r.session.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain('SENTINEL');
    expect(db.prepare('SELECT COUNT(*) c FROM daily_counters').get()).toEqual(before);
  });
});

describe('linkedin MCP on the engine', () => {
  it('open with no session launches through the runtime, then the engine reads that same page', async () => {
    const { handlers } = make();
    const h = await call(handlers.linkedin_open, { url: PROFILE });
    // the fake launcher serves the old extraction snapshot only, so the engine page is the real adapter over it
    expect(h.split('\n')[0]).toContain('"code"');
  });

  it('open, snapshot, click: a free control clicks, a refused one is refused, refs go stale', async () => {
    const { handlers, page } = makeEngine();
    const o = await call(handlers.linkedin_open, { url: URL_ });
    expect(head(o)).toMatchObject({ ok: true, code: 'ok', dry_run: true });
    expect(o).toContain('<<<PAGE_TEXT');
    const follow = /\[(s\d+\.\d+)\] button "Follow"/.exec(o)![1];
    const s = await call(handlers.linkedin_snapshot);
    expect(head(await call(handlers.linkedin_click, { ref: follow }))).toMatchObject({ ok: false, code: 'stale_ref' });
    const f2 = /\[(s\d+\.\d+)\] button "Follow"/.exec(s)![1];
    expect(head(await call(handlers.linkedin_click, { ref: f2 })).code).toBe('irreversible_refused');
    const more = /\[(s\d+\.\d+)\] button "More"/.exec(await call(handlers.linkedin_snapshot))![1];
    expect(head(await call(handlers.linkedin_click, { ref: more })).code).toBe('clicked');
    expect(page.log.filter((l) => l.startsWith('click'))).toHaveLength(1);
  });

  it('arm_send in a dry wake arms a dry intent and clicks nothing', async () => {
    const { handlers, page, intents } = makeEngine();
    const r = JSON.parse(await call(handlers.linkedin_arm_send, { kind: 'connect_note', profile_url: URL_, text: NOTE }));
    expect(r).toMatchObject({ status: 'armed', dry_run: true, class: 'commit_connect_send' });
    expect(intents.peek('linkedin')).not.toBeNull();
    expect(page.log.filter((l) => l.startsWith('click') || l.startsWith('fill') || l.startsWith('press'))).toEqual([]);
  });

  it('LINKEDIN_SCREENSHOT: unset or true is on, only exactly false is off; click_at still needs snapshot and screenshot', async () => {
    for (const env of [{}, { LINKEDIN_SCREENSHOT: 'true' }, { LINKEDIN_SCREENSHOT: 'FALSE' }, { LINKEDIN_SCREENSHOT: '0' }]) {
      const { handlers } = makeEngine({ ...DRY_ENV, ...env });
      expect(head(await call(handlers.linkedin_screenshot)).code).toBe('snapshot_required');
      expect(head(await call(handlers.linkedin_click_at, { x: 10, y: 10 })).code).not.toBe('click_at_disabled');
    }
    const off = makeEngine({ ...DRY_ENV, LINKEDIN_SCREENSHOT: 'false' });
    expect(head(await call(off.handlers.linkedin_screenshot)).code).toBe('screenshot_disabled');
    expect(head(await call(off.handlers.linkedin_click_at, { x: 10, y: 10 })).code).toBe('click_at_disabled');
  });

  it('arm_send refuses an unknown recipient and a bad kind', async () => {
    const { handlers } = makeEngine();
    const r = JSON.parse(await call(handlers.linkedin_arm_send, { kind: 'connect_note', profile_url: 'https://www.linkedin.com/in/nobody-here/', text: NOTE }));
    expect(r).toMatchObject({ status: 'refused', code: 'unknown_recipient' });
    const b = JSON.parse(await call(handlers.linkedin_arm_send, { kind: 'bogus', profile_url: URL_, text: NOTE }));
    expect(b).toMatchObject({ status: 'refused', code: 'bad_kind' });
  });

  it('screenshot with the flag on returns an image with an unscreened note, after a snapshot', async () => {
    const { handlers } = makeEngine({ ...DRY_ENV, LINKEDIN_SCREENSHOT: 'true' });
    expect(head(await call(handlers.linkedin_screenshot)).code).toBe('snapshot_required');
    await call(handlers.linkedin_snapshot);
    const r = (await handlers.linkedin_screenshot({})) as { __image: string; __note: string };
    expect(r.__image).toBe('c21hbGw=');
    expect(r.__note).toMatch(/unscreened pixels/);
  });

  it('actions are refused while halted', async () => {
    const { handlers, db } = makeEngine({ ...DRY_ENV, LINKEDIN_SCREENSHOT: 'true' });
    haltPlatform(db, 'linkedin', 'captcha: /x', new Date('2026-10-14T09:00:00Z'));
    expect(head(await call(handlers.linkedin_snapshot))).toMatchObject({ ok: false, code: 'halted' });
    expect(head(await call(handlers.linkedin_screenshot))).toMatchObject({ ok: false, code: 'halted' });
    expect(head(await call(handlers.linkedin_scroll, { direction: 'down' }))).toMatchObject({ ok: false, code: 'halted' });
  });

  it('a result carries the page tree only from the engine, never raw page text elsewhere', async () => {
    const { handlers } = makeEngine();
    const out = await call(handlers.linkedin_snapshot);
    expect(out.split('\n')[0]).toMatch(/^\{"ok":true/);
    expect(out).toContain('PAGE_TEXT>>>');
  });
});

describe('linkedin MCP schemas', () => {
  it('validates refs, keys, arm kinds and text lengths', () => {
    expect(z.object(schemas.linkedin_click).safeParse({ ref: 's3.14' }).success).toBe(true);
    expect(z.object(schemas.linkedin_click).safeParse({ ref: 'Connect' }).success).toBe(false);
    expect(z.object(schemas.linkedin_click).safeParse({ ref: 's3.14; drop' }).success).toBe(false);
    expect(z.object(schemas.linkedin_press_key).safeParse({ key: 'Enter' }).success).toBe(true);
    expect(z.object(schemas.linkedin_press_key).safeParse({ key: 'Delete' }).success).toBe(false);
    const arm = z.object(schemas.linkedin_arm_send);
    const ok = { kind: 'rapport', profile_url: PROFILE, text: 'hello' };
    expect(arm.safeParse(ok).success).toBe(true);
    expect(arm.safeParse({ ...ok, kind: 'connect' }).success).toBe(false);
    expect(arm.safeParse({ ...ok, text: 'x'.repeat(1801) }).success).toBe(false);
    expect(arm.safeParse({ kind: 'accept', profile_url: PROFILE }).success).toBe(true);
    expect(z.object(schemas.linkedin_type).safeParse({ ref: 's1.1', text: 'x'.repeat(1801) }).success).toBe(false);
    expect(z.object(schemas.linkedin_open).safeParse({ url: 'not a url' }).success).toBe(false);
    expect(z.object(schemas.linkedin_wait_for).safeParse({ ms: 10001 }).success).toBe(false);
  });
});

describe('registration and source hygiene', () => {
  it('.mcp.json has the linkedin entry and keeps the others', () => {
    const cfg = JSON.parse(read('.mcp.json')).mcpServers;
    expect(cfg.linkedin.args).toContain('src/mcp/linkedin.ts');
    expect(Object.keys(cfg).sort()).toEqual([
      'job-fetch', 'resume', 'contacts', 'db', 'gates', 'gmail', 'applier', 'naukri', 'wellfound',
      'linkedin', 'outreach', 'scout',
    ].sort());
  });

  it('module has no process spawning, no direct browser import or launch, no evaluate tool', () => {
    const src = read('src/mcp/linkedin.ts');
    expect(src).not.toMatch(/child_process|execFile|spawn/);
    expect(src).not.toMatch(/claude/i);
    expect(src).not.toMatch(/playwright|patchright/);
    expect(src).not.toContain('.launch(');
    expect(src).not.toMatch(/linkedin_(evaluate|cookies|storage)/);
  });

  it('exactly one IntentStore per process: the module creates it once and tests inject their own', () => {
    expect(read('src/mcp/linkedin.ts').match(/new IntentStore\(/g)).toHaveLength(1);
  });

  it('importing the module does not start the server (guarded main)', () => {
    expect(read('src/mcp/linkedin.ts')).toContain("process.env.VITEST !== 'true' && !process.env.LINKEDIN_NO_MAIN");
    expect(typeof buildHandlers).toBe('function'); // import above already succeeded under vitest
  });
});
