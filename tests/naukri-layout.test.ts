// Layout memory for Naukri: one observation per engine read (open, snapshot, every action's re-read), no
// extra page calls, the naukri_layout tool, and drift as telemetry only: layout never refuses or halts.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  naukriOpen, naukriSnapshot, naukriClick, naukriType, naukriArmSend, naukriLayout, naukriServer, shutdownNaukri,
} from '../src/mcp/naukri.js';
import { openDb } from '../src/db.js';
import { IntentStore } from '../src/browserctl/intent.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { upsertPerson } from '../src/outreach/people.js';
import { setState } from '../src/scheduler/runLog.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { observeNaukri } from '../src/layout/fingerprint.js';
import { TOOL_REQUIRES, KINDS } from '../src/layout/vocab.js';
import { MSG, THREAD, refOf, threadHtml } from './helpers/nkWorld.js';
import { bcCall, makeNkLauncher } from './helpers/nkLauncher.js';

const LOGIN_URL = 'https://www.naukri.com/nlogin/login';
const THREAD_URL = 'https://www.naukri.com/mnjuser/inbox?threadId=abc123';
const OPTION_SECRET = 'Fresher-ZZSECRETOPT';
const PLACEHOLDER_SECRET = 'Type ZZSECRETPLACEHOLDER here';

type Mode = 'v1' | 'v2' | 'v3' | 'login';

const HTML: Record<Exclude<Mode, 'login'>, string> = {
  v1: `<html><head><title>Job</title></head><body><button>Apply</button><button>Save</button>
<div class="chatbot_Drawer"><p>How many years of experience?</p><textarea placeholder="${PLACEHOLDER_SECRET}"></textarea>
<span role="radio">${OPTION_SECRET}</span><button class="sendMsg">Send</button></div></body></html>`,
  v2: '<html><head><title>Job</title></head><body><button>Apply</button></body></html>',
  v3: '<html><head><title>Job</title></head><body><p>nothing here</p></body></html>',
};
const LOGIN_HTML = '<html><head><title>Login</title></head><body><input type="password"></body></html>';

function harness(mode: { v: Mode } = { v: 'v1' }) {
  const h = makeNkLauncher({ html: () => (mode.v === 'login' ? LOGIN_HTML : HTML[mode.v]), startUrl: THREAD_URL });
  // a login wall is a different URL
  const origUrl = h.page.url.getMockImplementation()!;
  h.page.url.mockImplementation(() => (mode.v === 'login' ? LOGIN_URL : origUrl()));
  return { ...h, mode };
}

function setup(envExtra: Record<string, string> = {}, h = harness()) {
  const dir = mkdtempSync(path.join(tmpdir(), 'naukri-layout-'));
  const statePath = path.join(dir, 'state.json');
  writeFileSync(statePath, '{"cookies":[],"origins":[]}');
  const env = {
    JOBBER_DRY_RUN: 'false', LAYOUT_DIR: 'layout', LAYOUT_PROMOTE_N: '1', LAYOUT_PROMOTE_RUNS: '1',
    JOBBER_RUN_ID: 'run1', ...envExtra,
  } as NodeJS.ProcessEnv;
  const layoutCfg = loadLayoutConfig(env, dir);
  const file = path.join(layoutCfg.dir, 'naukri.json');
  const d: any = {
    db: openDb(':memory:'), chromium: h.launcher, sessionStatePath: statePath, settleMs: 0, paceMs: () => 0, confirmTimeoutMs: 20,
    env, layoutCfg, now: () => new Date('2026-10-14T10:00:00Z'), intents: new IntentStore(),
    screen: async (t: string) => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' as const }),
    cfg: { ...loadOutreachConfig({}), quietStartHour: 0, quietEndHour: 0 },
    checkText: async (t: string) => ({ ok: true, normalized: t, verdict: 'pass' as const }),
    style: () => ({ ok: true, hits: [] }),
  };
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  return { d, h, file, read, layoutCfg };
}

const head = (s: string) => JSON.parse(s.split('\n')[0]);

afterEach(async () => {
  await shutdownNaukri();
});

describe('drift side effects are wired to the server db', () => {
  it('escalates into the db the server uses after repeated drift, and never halts', async () => {
    const h = harness({ v: 'v1' });
    const { d } = setup({}, h);
    await naukriOpen({ url: THREAD_URL }, d); // promotes (N=1, runs=1); the thread kind needs chat.input
    h.mode.v = 'v3';
    for (let i = 0; i < 3; i++) await naukriSnapshot(d);
    const rows = d.db.prepare('SELECT platform, reason, detail FROM escalations').all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform: 'naukri', reason: 'layout_drift' });
    expect(rows[0].detail).toMatch(/^kind=thread streak=3 missing=/);
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM halt_flags').get()).toMatchObject({ n: 0 });
  });

  it('even a persistent drift streak past the halt limit halts nothing (telemetry only)', async () => {
    const h = harness({ v: 'v1' });
    const { d } = setup({ LAYOUT_ENFORCE: 'enforce', LAYOUT_DRIFT_HALT_N: '2' }, h);
    await naukriOpen({ url: THREAD_URL }, d);
    h.mode.v = 'v3';
    for (let i = 0; i < 6; i++) await naukriSnapshot(d);
    expect(d.db.prepare("SELECT COUNT(*) AS n FROM halt_flags WHERE reason LIKE 'layout_drift%'").get()).toMatchObject({ n: 0 });
  });
});

describe('observation per engine read', () => {
  it('persists exactly one observation per open and per snapshot', async () => {
    const { d, file, read } = setup({ LAYOUT_PROMOTE_N: '100' });
    await naukriOpen({ url: THREAD_URL }, d);
    expect(read().kinds.thread.variants[0].obs).toBe(1);
    await naukriSnapshot(d);
    expect(read().kinds.thread.variants[0].obs).toBe(2);
    await naukriSnapshot(d);
    expect(read().kinds.thread.variants[0].obs).toBe(3);
    expect(existsSync(file)).toBe(true);
  });

  it('never stores option, placeholder or message text', async () => {
    const { d, file } = setup();
    await naukriOpen({ url: THREAD_URL }, d);
    await naukriSnapshot(d);
    const raw = readFileSync(file, 'utf8');
    for (const s of ['ZZSECRET', 'How many years', '"Apply"', 'NetApp']) expect(raw).not.toContain(s);
    expect(raw).toContain('chat.options');
  });

  it('adds no page interaction beyond the one tree read', async () => {
    const { d, h } = setup();
    await naukriOpen({ url: THREAD_URL }, d);
    h.page.evaluate.mockClear();
    h.page.goto.mockClear();
    h.page.locator.mockClear();
    h.page.waitForTimeout.mockClear();
    await naukriSnapshot(d);
    expect(h.page.evaluate).toHaveBeenCalledTimes(1);
    expect(bcCall(h.page.evaluate.mock.calls[0][0])?.mode).toBe('snapshot');
    expect(h.page.goto).not.toHaveBeenCalled();
    expect(h.page.locator).not.toHaveBeenCalled();
    expect(h.page.waitForTimeout).not.toHaveBeenCalled();
  });

  it('puts a layout class token in the result header', async () => {
    const { d } = setup();
    expect(head(await naukriOpen({ url: THREAD_URL }, d)).layout).toBe('unknown');
    expect(head(await naukriSnapshot(d)).layout).toBe('match');
  });

  it('a login wall is reported as login_required and teaches nothing', async () => {
    const mode = { v: 'login' as Mode };
    const { d, file } = setup({}, harness(mode));
    const out = await naukriOpen({ url: THREAD_URL }, d);
    expect(head(out)).toMatchObject({ ok: false, code: 'login_required' });
    expect(existsSync(file)).toBe(false);
  });

  it('chatbot v1 learned, then v2 reads as drift', async () => {
    const mode = { v: 'v1' as Mode };
    const { d, read } = setup({}, harness(mode));
    await naukriOpen({ url: THREAD_URL }, d);
    expect(head(await naukriSnapshot(d)).layout).toBe('match');
    mode.v = 'v2';
    expect(head(await naukriSnapshot(d)).layout).toBe('drift');
    expect(read().kinds.thread.counters.drift).toBe(1);
  });

  it('an observer failure never reaches the tool result', async () => {
    const { d, h } = setup();
    d.layoutCfg = { ...d.layoutCfg, dir: path.join(path.dirname(d.sessionStatePath), 'state.json', 'nope') };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await naukriOpen({ url: THREAD_URL }, d);
    err.mockRestore();
    expect(head(out)).toMatchObject({ ok: true, layout: 'unknown' });
    expect(h.page.evaluate).toHaveBeenCalled();
  });
});

describe('naukri_layout', () => {
  it('is registered, takes no input and is read-only', async () => {
    const server = naukriServer as unknown as { _registeredTools: Record<string, { description?: string }> };
    expect(server._registeredTools.naukri_layout?.description).toMatch(/Read-only/);
    expect(server._registeredTools.naukri_layout?.description).toMatch(/telemetry only/);
  });

  it('returns enforce, the last verdict and a vocabulary-only summary, with no page calls', async () => {
    const { d, h } = setup({ LAYOUT_ENFORCE: 'enforce' });
    expect(JSON.parse(await naukriLayout(d))).toMatchObject({ enforce: 'enforce', verdict_last: null });
    await naukriOpen({ url: THREAD_URL }, d);
    await naukriSnapshot(d);
    h.page.evaluate.mockClear();
    const r = JSON.parse(await naukriLayout(d));
    expect(h.page.evaluate).not.toHaveBeenCalled();
    expect(r.enforce).toBe('enforce');
    expect(r.verdict_last).toMatchObject({ kind: 'thread', class: 'match' });
    expect(r.memory).toContain('thread:');
    expect(JSON.stringify(r)).not.toContain('ZZSECRET');
  });
});

describe('thread kind', () => {
  it('maps an inbox thread URL to thread and keeps the bare inbox as inbox; no tool needs a landmark', () => {
    const base = { title: 't', buttons: [], chatbot: { open: false, messages: [], placeholder: null, sendLabel: null, options: [] }, notices: [], hasPasswordInput: false };
    expect(observeNaukri({ ...base, url: THREAD_URL }, { loginRequired: false }).kind).toBe('thread');
    expect(observeNaukri({ ...base, url: 'https://www.naukri.com/mnjuser/inbox' }, { loginRequired: false }).kind).toBe('inbox');
    expect(KINDS.naukri).toContain('thread');
    // the engine acts and feeds telemetry only: no landmark precondition exists for a send or an apply
    expect(Object.keys(TOOL_REQUIRES).filter((k) => k.startsWith('naukri_'))).toEqual([]);
  });
});

describe('layout never gates an action', () => {
  it('LAYOUT_ENFORCE=enforce on an unlearned thread layout still sends (the old precondition is gone)', async () => {
    let html = threadHtml({ text: '' });
    const h = makeNkLauncher({
      html: () => html, startUrl: THREAD_URL,
      onFill: (_s, t) => { html = threadHtml({ text: t }); },
      onClick: () => { html = threadHtml({ text: '', sent: MSG }); },
    });
    const s = setup({ LAYOUT_ENFORCE: 'enforce' }, h as never);
    const pid = upsertPerson(s.d.db, { platform: 'naukri', profileKey: 'naukri:pat-recruiter', name: 'Pat Recruiter', company: 'Acme', category: 'recruiter' });
    setState(s.d.db, `naukri_thread_${pid}`, THREAD, new Date());
    const armed = head(await naukriArmSend({ person_id: pid, thread_ref: THREAD, text: MSG, kind: 'role_ask' }, s.d));
    expect(armed.status).toBe('armed');
    const snap1 = await naukriSnapshot(s.d);
    await naukriType({ ref: refOf(snap1, 'textbox', 'Type a message'), text: MSG }, s.d);
    const snap2 = await naukriSnapshot(s.d);
    const r = head(await naukriClick({ ref: refOf(snap2, 'button', 'Send') }, s.d));
    expect(r).toMatchObject({ ok: true, status: 'sent' });
    expect(['layout_drift', 'layout_unverified']).not.toContain(r.code);
  });
});
