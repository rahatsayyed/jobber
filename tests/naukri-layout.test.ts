// Layout memory for Naukri (plan 8B task 7): one observation per state call, no extra page calls,
// naukri_layout tool, and the enforce-mode precondition on naukri_send_message only.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  naukriOpen, naukriState, naukriClick, naukriReadThread, naukriSendMessageTool, naukriLayout, naukriServer,
  shutdownNaukri, SNAPSHOT_SRC, THREAD_SRC, type RawSnapshot,
} from '../src/mcp/naukri.js';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { setState } from '../src/scheduler/runLog.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { observeNaukri } from '../src/layout/fingerprint.js';
import { TOOL_REQUIRES, KINDS } from '../src/layout/vocab.js';
import { naukriLayoutPrecondition } from '../src/naukri/layoutGuard.js';
import type { Verdict } from '../src/layout/types.js';

const JOB_URL = 'https://www.naukri.com/job-listings-software-engineer-netapp-bengaluru-5-to-8-years-081026050522';
const LOGIN_URL = 'https://www.naukri.com/nlogin/login';
const THREAD_URL = 'https://www.naukri.com/mnjuser/inbox?threadId=abc123';
const OPTION_SECRET = 'Fresher-ZZSECRETOPT';
const PLACEHOLDER_SECRET = 'Type ZZSECRETPLACEHOLDER here';

type Mode = 'v1' | 'v2' | 'v3' | 'login';

const snapV1 = (url: string): RawSnapshot => ({
  title: 'Job', url, buttons: ['Apply', 'Save'],
  chatbot: {
    open: true, messages: [{ from: 'bot', text: 'How many years of experience?' }],
    placeholder: PLACEHOLDER_SECRET, sendLabel: 'Send', options: [OPTION_SECRET],
  },
  notices: [], hasPasswordInput: false,
});
const snapV2 = (url: string): RawSnapshot => ({
  title: 'Job', url, buttons: ['Apply'],
  chatbot: { open: false, messages: [], placeholder: null, sendLabel: null, options: [] },
  notices: [], hasPasswordInput: false,
});

function harness(mode: { v: Mode } = { v: 'v1' }) {
  const gotos: string[] = [];
  const typed: string[] = [];
  const clicks: string[] = [];
  const evaluated: string[] = [];
  const page: any = {
    url: vi.fn(() => gotos[gotos.length - 1] ?? JOB_URL),
    goto: vi.fn(async (u: string) => { gotos.push(u); }),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (src: string) => {
      evaluated.push(src);
      if (src === THREAD_SRC) {
        return { recipient: 'Pat Recruiter', company: 'Acme Labs', messages: [{ from: 'them', text: 'Hello Pat here, are you open to roles?', at: 'yesterday' }] };
      }
      if (src.includes('data-nk-i')) return [{ i: 1, text: 'Apply', native: true, company: false }];
      const url = mode.v === 'login' ? LOGIN_URL : gotos[gotos.length - 1] ?? JOB_URL;
      if (mode.v === 'v3') return { ...snapV2(url), buttons: [] };
      return mode.v === 'v2' ? snapV2(url) : snapV1(url);
    }),
    locator: vi.fn((sel: string) => {
      const loc: any = {
        first: () => loc,
        count: async () => 1,
        click: vi.fn(async () => { clicks.push(sel); }),
        fill: vi.fn(async (t: string) => { typed.push(t); }),
      };
      return loc;
    }),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
  };
  const context: any = { newPage: vi.fn(async () => page), waitForEvent: vi.fn(async () => { throw new Error('timeout'); }) };
  const browser: any = { newContext: vi.fn(async () => context), close: vi.fn().mockResolvedValue(undefined) };
  return { launcher: { launch: vi.fn(async () => browser) }, page, gotos, typed, clicks, evaluated, mode };
}

function setup(envExtra: Record<string, string> = {}, h = harness()) {
  const dir = mkdtempSync(path.join(tmpdir(), 'naukri-layout-'));
  const statePath = path.join(dir, 'state.json');
  writeFileSync(statePath, '{"cookies":[],"origins":[]}');
  const env = {
    SCHEDULER_DRY_RUN: 'false', LAYOUT_DIR: 'layout', LAYOUT_PROMOTE_N: '1', LAYOUT_PROMOTE_RUNS: '1',
    JOBBER_RUN_ID: 'run1', ...envExtra,
  } as NodeJS.ProcessEnv;
  const layoutCfg = loadLayoutConfig(env, dir);
  const file = path.join(layoutCfg.dir, 'naukri.json');
  const d: any = {
    db: openDb(':memory:'), chromium: h.launcher, sessionStatePath: statePath, settleMs: 0, env, layoutCfg,
    now: () => new Date('2026-10-14T10:00:00Z'),
    screen: async (t: string) => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' as const }),
    cfg: { ...loadOutreachConfig({}), quietStartHour: 0, quietEndHour: 0 },
    checkText: async (t: string) => ({ ok: true, normalized: t, verdict: 'pass' as const }),
    style: () => ({ ok: true, hits: [] }),
  };
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  return { d, h, file, read, layoutCfg };
}

afterEach(async () => {
  await shutdownNaukri();
});

describe('drift side effects are wired to the server db', () => {
  it('escalates into the db the server uses after repeated drift', async () => {
    const h = harness({ v: 'v1' });
    const { d } = setup({}, h);
    await naukriOpen({ url: THREAD_URL }, d); // promotes (N=1, runs=1); the thread kind needs chat.input
    h.mode.v = 'v3';
    for (let i = 0; i < 3; i++) await naukriState(d);
    const rows = d.db.prepare('SELECT platform, reason, detail FROM escalations').all();
    expect(rows).toEqual([{ platform: 'naukri', reason: 'layout_drift', detail: 'kind=thread streak=3 missing=button:apply,button:save,chat.input,chat.messages,chat.open,chat.options,chat.send' }]);
  });
});

describe('observation per state call', () => {
  it('persists exactly one observation per open and per state call', async () => {
    const { d, file, read } = setup({ LAYOUT_PROMOTE_N: '100' });
    await naukriOpen({ url: THREAD_URL }, d);
    expect(read().kinds.thread.variants[0].obs).toBe(1);
    await naukriState(d);
    expect(read().kinds.thread.variants[0].obs).toBe(2);
    await naukriState(d);
    expect(read().kinds.thread.variants[0].obs).toBe(3);
    expect(existsSync(file)).toBe(true);
  });

  it('never stores option, placeholder or message text', async () => {
    const { d, file } = setup();
    await naukriOpen({ url: THREAD_URL }, d);
    await naukriState(d);
    const raw = readFileSync(file, 'utf8');
    for (const s of ['ZZSECRET', 'How many years', '"Apply"', 'NetApp']) expect(raw).not.toContain(s);
    expect(raw).toContain('chat.options');
  });

  it('adds no page interaction beyond the existing snapshot', async () => {
    const { d, h } = setup();
    await naukriOpen({ url: THREAD_URL }, d);
    h.page.evaluate.mockClear();
    h.page.goto.mockClear();
    h.page.locator.mockClear();
    h.page.waitForTimeout.mockClear();
    await naukriState(d);
    expect(h.page.evaluate).toHaveBeenCalledTimes(1);
    expect(h.page.evaluate).toHaveBeenCalledWith(SNAPSHOT_SRC);
    expect(h.page.goto).not.toHaveBeenCalled();
    expect(h.page.locator).not.toHaveBeenCalled();
    expect(h.page.waitForTimeout).not.toHaveBeenCalled();
  });

  it('puts a layout= class token in the state header', async () => {
    const { d } = setup();
    const first = await naukriOpen({ url: THREAD_URL }, d);
    expect(first.split('\n')[0]).toMatch(/ layout=unknown$| layout=unknown /);
    const second = await naukriState(d);
    expect(second.split('\n')[0]).toContain('layout=match');
  });

  it('a login wall is logged_out and teaches nothing', async () => {
    const mode = { v: 'login' as Mode };
    const { d, file } = setup({}, harness(mode));
    const out = await naukriOpen({ url: THREAD_URL }, d);
    expect(out).toContain('login_required=true');
    expect(out.split('\n')[0]).toContain('layout=logged_out');
    expect(existsSync(file)).toBe(false);
  });

  it('chatbot v1 learned, then v2 reads as drift', async () => {
    const mode = { v: 'v1' as Mode };
    const { d, read } = setup({}, harness(mode));
    await naukriOpen({ url: THREAD_URL }, d);
    expect((await naukriState(d)).split('\n')[0]).toContain('layout=match');
    mode.v = 'v2';
    expect((await naukriState(d)).split('\n')[0]).toContain('layout=drift');
    expect(read().kinds.thread.counters.drift).toBe(1);
  });

  it('an observer failure never reaches the tool result', async () => {
    const { d, h } = setup();
    d.layoutCfg = { ...d.layoutCfg, dir: path.join(path.dirname(d.sessionStatePath), 'state.json', 'nope') };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = await naukriOpen({ url: THREAD_URL }, d);
    err.mockRestore();
    expect(out).toContain('chatbot_open=true');
    expect(out.split('\n')[0]).toContain('layout=unknown');
    expect(h.page.evaluate).toHaveBeenCalled();
  });
});

describe('naukri_layout', () => {
  it('is registered, takes no input and is read-only', async () => {
    const server = naukriServer as unknown as { _registeredTools: Record<string, { description?: string }> };
    expect(server._registeredTools.naukri_layout?.description).toMatch(/Read-only/);
  });

  it('returns enforce, the last verdict and a vocabulary-only summary, with no page calls', async () => {
    const { d, h } = setup({ LAYOUT_ENFORCE: 'enforce' });
    expect(JSON.parse(await naukriLayout(d))).toMatchObject({ enforce: 'enforce', verdict_last: null });
    await naukriOpen({ url: THREAD_URL }, d);
    await naukriState(d);
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
  it('maps an inbox thread URL to thread and keeps the bare inbox as inbox', () => {
    const base = { title: 't', buttons: [], chatbot: { open: false, messages: [], placeholder: null, sendLabel: null, options: [] }, notices: [], hasPasswordInput: false };
    expect(observeNaukri({ ...base, url: THREAD_URL }, { loginRequired: false }).kind).toBe('thread');
    expect(observeNaukri({ ...base, url: 'https://www.naukri.com/mnjuser/inbox' }, { loginRequired: false }).kind).toBe('inbox');
    expect(KINDS.naukri).toContain('thread');
    expect(TOOL_REQUIRES.naukri_send_message?.kind).toBe('thread');
    expect(TOOL_REQUIRES.naukri_send_message?.landmarks.length).toBeGreaterThan(0);
  });
});

describe('naukriLayoutPrecondition', () => {
  const cfg = (enforce: 'off' | 'warn' | 'enforce') => ({ ...loadLayoutConfig({ LAYOUT_ENFORCE: enforce } as NodeJS.ProcessEnv) });
  const need = TOOL_REQUIRES.naukri_send_message!.landmarks;
  const V = (c: Verdict['class'], missing: string[] = []): Verdict =>
    (c === 'blocked' || c === 'logged_out' || c === 'unloaded'
      ? { class: c }
      : { class: c, score: 0.7, missing, variant: 'v' });

  it('only enforce restricts', () => {
    for (const e of ['off', 'warn'] as const) {
      for (const c of ['drift', 'unknown', 'unloaded', 'partial'] as const) {
        expect(naukriLayoutPrecondition(V(c), cfg(e), []).ok).toBe(true);
      }
    }
  });

  it('enforce: match, blocked and logged_out pass', () => {
    for (const c of ['match', 'blocked', 'logged_out'] as const) {
      expect(naukriLayoutPrecondition(V(c), cfg('enforce'), []).ok).toBe(true);
    }
  });

  it('enforce: drift, unknown, unloaded and a null verdict refuse', () => {
    const drift = naukriLayoutPrecondition(V('drift'), cfg('enforce'), []);
    expect(drift).toMatchObject({ ok: false, code: 'layout_drift' });
    for (const v of [V('unknown'), V('unloaded'), null]) {
      expect(naukriLayoutPrecondition(v, cfg('enforce'), [])).toMatchObject({ ok: false, code: 'layout_unverified' });
    }
  });

  it('enforce: partial passes only when every needed landmark is present', () => {
    expect(naukriLayoutPrecondition(V('partial'), cfg('enforce'), [...need]).ok).toBe(true);
    expect(naukriLayoutPrecondition(V('partial'), cfg('enforce'), undefined)).toMatchObject({ ok: false, code: 'layout_unverified' });
    expect(naukriLayoutPrecondition(V('partial', [...need]), cfg('enforce'), [])).toMatchObject({ ok: false, code: 'layout_drift' });
  });
});

describe('naukri_send_message layout gate', () => {
  async function ready(env: Record<string, string>, mode = { v: 'v1' as Mode }) {
    const s = setup(env, harness(mode));
    await naukriOpen({ url: JOB_URL }, s.d);
    const pid = upsertPerson(s.d.db, { platform: 'naukri', profileKey: 'naukri:pat-recruiter', name: 'Pat Recruiter', company: 'Acme Labs', category: 'recruiter' });
    setState(s.d.db, `naukri_thread_${pid}`, 'abc123', new Date());
    return { ...s, pid, mode };
  }
  const send = (s: Awaited<ReturnType<typeof ready>>) =>
    naukriSendMessageTool({ person_id: s.pid, thread_ref: 'abc123', text: 'Hi Pat, happy to share more about my React work.', kind: 'role_ask' }, s.d)
      .then((x) => JSON.parse(x));
  const ceiling = (s: Awaited<ReturnType<typeof ready>>) =>
    s.d.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE key = 'naukri_message'").get().n;

  it('enforce refuses on drift with no send attempt and no ceiling used', async () => {
    const s = await ready({ LAYOUT_ENFORCE: 'enforce' });
    await naukriReadThread({ thread_ref: 'abc123' }, s.d);   // learns the v1 thread layout
    s.mode.v = 'v2';                                          // composer gone
    const r = await send(s);
    expect(r).toMatchObject({ status: 'refused', code: 'layout_drift' });
    expect(s.h.typed).toEqual([]);
    expect(s.h.clicks).toEqual([]);
    expect(ceiling(s)).toBe(0);
  });

  it('enforce refuses on an unlearned thread layout (unknown)', async () => {
    const s = await ready({ LAYOUT_ENFORCE: 'enforce' });
    const r = await send(s);
    expect(r).toMatchObject({ status: 'refused', code: 'layout_unverified' });
    expect(s.h.typed).toEqual([]);
    expect(ceiling(s)).toBe(0);
  });

  it('enforce lets a matching layout through to the send', async () => {
    const s = await ready({ LAYOUT_ENFORCE: 'enforce' });
    await naukriReadThread({ thread_ref: 'abc123' }, s.d);
    const r = await send(s);
    expect(r.code).toBeUndefined();
    expect(s.h.typed.length).toBe(1);
  });

  it('warn mode never refuses on layout', async () => {
    const s = await ready({ LAYOUT_ENFORCE: 'warn' });
    await naukriReadThread({ thread_ref: 'abc123' }, s.d);
    s.mode.v = 'v2';
    const r = await send(s);
    expect(r.code).toBeUndefined();
    expect(s.h.typed.length).toBe(1);
  });

  it('the native Apply click is not affected by enforce on drift', async () => {
    const mode = { v: 'v1' as Mode };
    const s = setup({ LAYOUT_ENFORCE: 'enforce' }, harness(mode));
    await naukriOpen({ url: JOB_URL }, s.d);
    mode.v = 'v2';
    await naukriClick({ text: 'Apply' }, s.d);
    // same behaviour as without the layout: the click goes through its own ceilings
    expect(s.h.clicks.length).toBe(1);
  });
});
