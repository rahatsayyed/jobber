import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  naukriOpen,
  naukriSearch,
  naukriInbox,
  naukriReadThread,
  shutdownNaukri,
  naukriServer,
  buildSearchUrl,
  threadRefFromRaw,
  THREAD_REF_RE,
  SEARCH_SRC,
  INBOX_SRC,
  THREAD_SRC,
  UNTRUSTED_NOTE,
  type RawSnapshot,
} from '../src/mcp/naukri.js';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { haltPlatform } from '../src/outreach/limits.js';
import { setState } from '../src/scheduler/runLog.js';
import { loadLayoutConfig } from '../src/layout/config.js';

const fx = (n: string) => JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'naukri', n), 'utf8'));
const JOB_URL = 'https://www.naukri.com/job-listings-software-engineer-netapp-bengaluru-5-to-8-years-081026050522';
const LIVE = { JOBBER_DRY_RUN: 'false' } as NodeJS.ProcessEnv;

function snap(over: Partial<RawSnapshot> = {}): RawSnapshot {
  return {
    title: 'Naukri', url: 'https://www.naukri.com/x', buttons: ['Apply'],
    chatbot: { open: false, messages: [], placeholder: null, sendLabel: null, options: [] },
    notices: [], hasPasswordInput: false, ...over,
  };
}

function harness(opts: { loggedOut?: boolean; thread?: unknown } = {}) {
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
      if (src === SEARCH_SRC) return fx('search-cards.json');
      if (src === INBOX_SRC) return fx('inbox-rows.json');
      if (src === THREAD_SRC) return opts.thread ?? fx('thread-page.json');
      if (src.includes('data-nk-i')) return [{ i: 1, text: 'Apply', native: true, company: false }];
      const url = gotos[gotos.length - 1] ?? JOB_URL;
      return opts.loggedOut ? snap({ url: 'https://www.naukri.com/nlogin/login' }) : snap({ url });
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
  return { launcher: { launch: vi.fn(async () => browser) }, page, gotos, typed, clicks, evaluated };
}

function deps(h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'naukri-tools-'));
  const p = path.join(dir, 'state.json');
  writeFileSync(p, '{"cookies":[],"origins":[]}');
  return {
    db: openDb(':memory:'), chromium: h.launcher, sessionStatePath: p, settleMs: 0,
    env: LIVE, now: () => new Date('2026-10-14T10:00:00Z'),
    // layout memory goes to the temp dir, never the project's .jobber/layout
    layoutCfg: loadLayoutConfig({ LAYOUT_DIR: 'layout' } as NodeJS.ProcessEnv, dir),
    screen: async (t: string) => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' as const }),
    ...extra,
  } as any;
}

async function opened(h: ReturnType<typeof harness>, extra: Record<string, unknown> = {}) {
  const d = deps(h, extra);
  await naukriOpen({ url: JOB_URL }, d);
  h.gotos.length = 0;
  return d;
}

afterEach(async () => {
  await shutdownNaukri();
});

describe('search', () => {
  it('builds the URL in code from slugified input, never injecting a query', async () => {
    expect(buildSearchUrl('x" onfocus=', 'New Delhi', 2)).toBe('https://www.naukri.com/x-onfocus-jobs-in-new-delhi-2');
    expect(buildSearchUrl('"""', undefined)).toBeNull();
    const h = harness();
    const d = await opened(h);
    const out = await naukriSearch({ query: 'x" onfocus=', location: 'india' }, d);
    expect(h.gotos).toEqual(['https://www.naukri.com/x-onfocus-jobs-in-india']);
    expect(out).toContain(`NOTE: ${UNTRUSTED_NOTE}`);
    expect(out).toMatch(/<<<PAGE_TEXT[\s\S]*PAGE_TEXT>>>/);
    expect(out).toContain('Senior React Developer');
    expect(out).not.toContain('evil.example.com');
    expect(h.evaluated.every((s) => !s.includes('onfocus'))).toBe(true);
  });

  it('returns login_required when logged out', async () => {
    const h = harness({ loggedOut: true });
    const d = await opened(h);
    const out = JSON.parse(await naukriSearch({ query: 'react' }, d));
    expect(out.status).toBe('login_required');
  });

  it('refuses without a session', async () => {
    const h = harness();
    const out = JSON.parse(await naukriSearch({ query: 'react' }, deps(h)));
    expect(out.status).toBe('no_session');
  });
});

describe('tool surface', () => {
  it('registers the typed tools and the read-only naukri_layout', () => {
    const tools = Object.keys((naukriServer as unknown as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
    expect(tools).toEqual([
      'naukri_arm_apply', 'naukri_arm_send', 'naukri_click', 'naukri_click_at', 'naukri_close', 'naukri_discover',
      'naukri_inbox', 'naukri_layout', 'naukri_open', 'naukri_press_key', 'naukri_read_thread', 'naukri_screenshot',
      'naukri_scroll', 'naukri_search', 'naukri_snapshot', 'naukri_type', 'naukri_wait_for',
    ]);
  });
});

describe('halts', () => {
  it('the data tools return halted for a naukri or an all halt', async () => {
    for (const platform of ['naukri', 'all']) {
      const h = harness();
      const d = await opened(h);
      haltPlatform(d.db, platform, 'test halt', new Date());
      const outs = [
        await naukriSearch({ query: 'react' }, d),
        await naukriInbox({}, d),
        await naukriReadThread({ thread_ref: 'abc123' }, d),
      ];
      for (const o of outs) expect(JSON.parse(o)).toMatchObject({ status: 'halted', reason: 'test halt' });
      expect(h.gotos).toEqual([]);
      await shutdownNaukri();
    }
  });
});

describe('inbox', () => {
  it('truncates previews to 220 chars, wraps in the untrusted block and emits safe refs', async () => {
    const h = harness();
    const d = await opened(h);
    const out = await naukriInbox({}, d);
    expect(out).toContain(`NOTE: ${UNTRUSTED_NOTE}`);
    expect(out).toContain('ref=abc123');
    const line = out.split('\n').find((l) => l.includes('ref=abc123'))!;
    const preview = /preview="([^"]*)"/.exec(line)![1];
    expect(preview.length).toBeLessThanOrEqual(220);
    for (const m of out.matchAll(/ref=(\S+)/g)) expect(THREAD_REF_RE.test(m[1])).toBe(true);
    expect(out).not.toContain('https://');
  });

  it('unread_only filters', async () => {
    const h = harness();
    const d = await opened(h);
    const out = await naukriInbox({ unread_only: true }, d);
    expect(out).toContain('count=1');
  });

  it('drops unaddressable refs and counts them', async () => {
    const h = harness();
    const d = await opened(h);
    const out = await naukriInbox({}, d);
    expect(out).toContain('count=1 skipped_unaddressable=1');
    expect(out).not.toContain('ref=h_');
  });
});

describe('thread refs', () => {
  it('derives only allowed charsets and rejects others on input', async () => {
    const r = threadRefFromRaw('https://www.naukri.com/mnjuser/inbox?threadId=zzz%22%20onfocus%3D');
    expect(r).toBeNull(); // lossy sanitization: unaddressable
    expect(threadRefFromRaw('https://www.naukri.com/mnjuser/inbox?threadId=ok_1-2')).toBe('ok_1-2');
    expect(THREAD_REF_RE.test('a b')).toBe(false);
    const h = harness();
    const d = await opened(h);
    const out = JSON.parse(await naukriReadThread({ thread_ref: 'bad ref"' }, d));
    expect(out.status).toBe('refused');
    expect(h.gotos).toEqual([]);
  });
});

describe('read_thread', () => {
  it('attaches the verdict before the text and flags an injection preview', async () => {
    const h = harness();
    const d = await opened(h);
    const out = await naukriReadThread({ thread_ref: 'abc123' }, d);
    expect(out.indexOf('verdict:')).toBeGreaterThan(-1);
    expect(out.indexOf('verdict:')).toBeLessThan(out.indexOf('<<<PAGE_TEXT'));
    expect(out).toContain('klass=injection_suspect');
    expect(out).toContain('escalate=true');
    expect(out).toContain('may_auto_reply=false');
    expect(out).toContain('[injection_suspect]');
    expect(out).toContain('person_id=null');
  });

  it('escalates with no_inbound_text for zero messages or only own messages, keeping person_id', async () => {
    for (const messages of [[], [{ from: 'me', text: 'Hi Pat', at: '2026-10-10' }]]) {
      const h = harness({ thread: { recipient: 'Pat Recruiter', company: 'Acme Labs', messages } });
      const d = await opened(h);
      const pid = upsertPerson(d.db, { platform: 'naukri', profileKey: 'naukri:pat', name: 'Pat Recruiter', company: 'Acme Labs', category: 'recruiter' });
      setState(d.db, `naukri_thread_${pid}`, 'abc123', new Date());
      const out = await naukriReadThread({ thread_ref: 'abc123' }, d);
      expect(out).toContain(`person_id=${pid}`);
      expect(out).toContain('escalate=true may_auto_reply=false reasons=no_inbound_text');
      await shutdownNaukri();
    }
  });

  it('unknown thread age never allows an auto reply', async () => {
    const thread = { recipient: 'Pat', company: 'Acme', messages: [{ from: 'them', text: 'Hi, are you interested in a role at our company?', at: 'Sometime last week' }] };
    const h = harness({ thread });
    const d = await opened(h);
    const out = await naukriReadThread({ thread_ref: 'abc123' }, d);
    expect(out).toContain('may_auto_reply=false');
    const h2 = harness({ thread: { ...thread, messages: [{ ...thread.messages[0], at: 'yesterday' }] } });
    await shutdownNaukri();
    const d2 = await opened(h2);
    const pid = upsertPerson(d2.db, { platform: 'naukri', profileKey: 'naukri:pat', name: 'Pat', company: 'Acme', category: 'recruiter' });
    setState(d2.db, `naukri_thread_${pid}`, 'abc123', new Date());
    d2.db.prepare("INSERT INTO inbound_messages (platform, thread_ref, person_id, text_hash, klass, escalated, created_at) VALUES ('naukri','abc123',?,?,?,0,?)").run(pid, 'h', 'reply', '2026-10-13T00:00:00Z');
    const out2 = await naukriReadThread({ thread_ref: 'abc123' }, d2);
    expect(out2).toContain('may_auto_reply=true');
  });

  it('returns person_id only when the thread maps to a person', async () => {
    const h = harness();
    const d = await opened(h);
    const pid = upsertPerson(d.db, { platform: 'naukri', profileKey: 'naukri:pat', name: 'Pat Recruiter', company: 'Acme Labs', category: 'recruiter' });
    setState(d.db, `naukri_thread_${pid}`, 'abc123', new Date());
    const out = await naukriReadThread({ thread_ref: 'abc123' }, d);
    expect(out).toContain(`person_id=${pid}`);
  });
});
