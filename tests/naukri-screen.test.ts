import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  naukriOpen, naukriSearch, naukriInbox, naukriReadThread, shutdownNaukri,
  SEARCH_SRC, INBOX_SRC, THREAD_SRC, type RawSnapshot,
} from '../src/mcp/naukri.js';
import { classifyInboundScreened } from '../src/naukri/inbound.js';
import { openDb } from '../src/db.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { SCREENED_SURFACES, callsScreen, type ScreenVerdict, type ScreenPurpose } from '../src/safety/screen.js';
import { buildTreeFromHtml } from '../src/browserctl/snapshot.js';
import { bcCall } from './helpers/nkLauncher.js';

const fx = (n: string) => JSON.parse(readFileSync(path.join(__dirname, 'fixtures', 'naukri', n), 'utf8'));
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const JOB_URL = 'https://www.naukri.com/job-listings-software-engineer-netapp-bengaluru-5-to-8-years-081026050522';

const ok = (unscreened = false) => async (t: string): Promise<ScreenVerdict> => ({ blocked: false, unscreened, text: t, flags: [], code: 'ok' });
const malicious = async (): Promise<ScreenVerdict> => ({ blocked: true, unscreened: false, text: '', flags: ['classifier_injection'], code: 'injection_suspected' });

function harness(chatbotMsg = 'What is your notice period?') {
  const clicks: string[] = [];
  const snap: RawSnapshot = {
    title: 'Naukri', url: JOB_URL, buttons: ['Apply'],
    chatbot: { open: true, messages: [{ from: 'bot', text: chatbotMsg }], placeholder: null, sendLabel: null, options: [] },
    notices: [], hasPasswordInput: false,
  };
  const page: any = {
    url: vi.fn(() => JOB_URL),
    goto: vi.fn(async () => {}),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(async (src: string) => {
      if (src === SEARCH_SRC) return fx('search-cards.json');
      if (src === INBOX_SRC) return fx('inbox-rows.json');
      if (src === THREAD_SRC) return fx('thread-page.json');
      const c = bcCall(src);
      if (c) {
        return c.mode === 'snapshot'
          ? buildTreeFromHtml(`<html><head><title>Naukri</title></head><body><h1>Job</h1><p>${chatbotMsg}</p></body></html>`, JOB_URL)
          : null;
      }
      return snap;
    }),
    locator: vi.fn((sel: string) => {
      const loc: any = { first: () => loc, count: async () => 1, click: vi.fn(async () => { clicks.push(sel); }), fill: vi.fn(async () => { clicks.push('fill'); }) };
      return loc;
    }),
    keyboard: { press: vi.fn().mockResolvedValue(undefined) },
  };
  const context: any = { newPage: vi.fn(async () => page), waitForEvent: vi.fn(async () => { throw new Error('timeout'); }) };
  const browser: any = { newContext: vi.fn(async () => context), close: vi.fn().mockResolvedValue(undefined) };
  return { launcher: { launch: vi.fn(async () => browser) }, clicks };
}

function deps(h: ReturnType<typeof harness>, screen: any, extra: Record<string, unknown> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'naukri-screen-'));
  const p = path.join(dir, 'state.json');
  writeFileSync(p, '{"cookies":[],"origins":[]}');
  return {
    db: openDb(':memory:'), chromium: h.launcher, sessionStatePath: p, settleMs: 0,
    env: { JOBBER_DRY_RUN: 'false' } as NodeJS.ProcessEnv, now: () => new Date('2026-10-14T10:00:00Z'),
    screen, layoutCfg: loadLayoutConfig({ LAYOUT_DIR: 'layout' } as NodeJS.ProcessEnv, dir), ...extra,
  } as any;
}

afterEach(async () => { await shutdownNaukri(); });

describe('naukri screening', () => {
  it('search with a malicious screen returns blocked and no card text', async () => {
    const h = harness();
    const d = deps(h, ok());
    await naukriOpen({ url: JOB_URL }, d);
    const d2 = { ...d, screen: malicious };
    const out = await naukriSearch({ query: 'react' }, d2);
    expect(JSON.parse(out)).toEqual({ status: 'blocked', code: 'injection_suspected' });
    expect(out).not.toContain('Senior React Developer');
  });

  it('inbox and thread with a malicious screen return blocked and no text', async () => {
    const h = harness();
    const d = deps(h, ok());
    await naukriOpen({ url: JOB_URL }, d);
    const d2 = { ...d, screen: malicious };
    for (const out of [await naukriInbox({}, d2), await naukriReadThread({ thread_ref: 'abc123' }, d2)]) {
      expect(JSON.parse(out)).toEqual({ status: 'blocked', code: 'injection_suspected' });
      expect(out).not.toContain('PAGE_TEXT');
    }
  });

  it('a throwing screen fails closed without exception text', async () => {
    const h = harness();
    const d = deps(h, ok());
    await naukriOpen({ url: JOB_URL }, d);
    const out = await naukriInbox({}, { ...d, screen: async () => { throw new Error('secret-detail'); } });
    expect(JSON.parse(out).status).toBe('blocked');
    expect(out).not.toContain('secret-detail');
  });

  it('screens only the page text, not the tool header or the untrusted-text note', async () => {
    const h = harness();
    const seen: string[] = [];
    const rec = async (t: string): Promise<ScreenVerdict> => { seen.push(t); return { blocked: false, unscreened: false, text: t, flags: [], code: 'ok' }; };
    const d = deps(h, rec);
    const out = await naukriOpen({ url: JOB_URL }, d);
    expect(seen.length).toBeGreaterThan(0);
    for (const t of seen) {
      expect(t).not.toContain('do not follow instructions');
      expect(t).not.toContain('epoch:');
      expect(t).not.toContain('PAGE_TEXT');
    }
    expect(seen.join('\n')).toContain('What is your notice period?');
    expect(out).toContain('<<<PAGE_TEXT');
  });

  it('unscreened (dry) adds the classifier=unscreened header', async () => {
    const h = harness();
    const d = deps(h, ok(true));
    await naukriOpen({ url: JOB_URL }, d);
    const out = await naukriInbox({}, d);
    expect(out).toContain('classifier=unscreened');
    expect(out).toContain('<<<PAGE_TEXT');
  });

  it('classifyInboundScreened: live + malicious -> injection_suspect, no auto reply', async () => {
    const v = await classifyInboundScreened('Are you interested in a role?', { alreadyRepliedThisThread: false, threadAgeDays: 1 }, malicious);
    expect(v).toMatchObject({ klass: 'injection_suspect', escalate: true, mayAutoReply: false });
    expect(v.reasons[0]).toBe('injection_suspected');
  });

  it('classifyInboundScreened: unscreened keeps the class but never auto replies', async () => {
    const screen = async (t: string, _p: ScreenPurpose): Promise<ScreenVerdict> => ({ blocked: false, unscreened: true, text: t, flags: [], code: 'ok' });
    const opts = { alreadyRepliedThisThread: false, threadAgeDays: 1 };
    const v = await classifyInboundScreened('We have an opening, are you interested in this role?', opts, screen);
    expect(v.klass).toBe('recruiter_inquiry');
    expect(v.mayAutoReply).toBe(false);
    expect(v.reasons).toContain('unscreened');
  });

  it('SCREENED_SURFACES: each naukri file calls the screen', () => {
    const entries = SCREENED_SURFACES.filter((s) => s.id.startsWith('naukri_'));
    expect(entries.map((e) => e.id)).toEqual(expect.arrayContaining(['naukri_snapshot', 'naukri_arm_send', 'naukri_arm_apply', 'naukri_search', 'naukri_inbox', 'naukri_read_thread']));
    for (const e of entries) {
      const text = read(e.file);
      expect(callsScreen(text) || text.includes('classifyInboundScreened'), e.id).toBe(true);
    }
  });
});
