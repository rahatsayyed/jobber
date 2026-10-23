// The wellfound MCP server through its handlers, on a fake patchright launcher: tool surface, session launch and
// lock, engine tools, arm tools, discover, inbox and thread reads. No real browser and no site is contacted.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  isWellfoundUrl, detectLoginRequired, wellfoundOpen, wellfoundSnapshot, wellfoundClick, wellfoundType, wellfoundScreenshot,
  wellfoundClickAt, wellfoundArmSend, wellfoundArmApply, wellfoundClose, wellfoundDiscover, wellfoundInbox, wellfoundReadThread,
  wellfoundLayout, shutdownWellfound, wellfoundServer, threadRefFromRaw, pageAgeDays, SEARCH_SRC, INBOX_SRC, THREAD_SRC, SNAPSHOT_SRC,
  TOOL_NAMES,
} from '../src/mcp/wellfound.js';
import { openDb, saveJob } from '../src/db.js';
import { IntentStore } from '../src/browserctl/intent.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { haltPlatform } from '../src/outreach/limits.js';
import { upsertPerson } from '../src/outreach/people.js';
import { listDryRun } from '../src/safety/dryRun.js';
import { setState } from '../src/scheduler/runLog.js';
import { JOB_ID, JOB_URL, MSG, NOTE, THREAD, THREAD_URL, jobHtml, refOf, threadHtml } from './helpers/wfWorld.js';
import { makeNkLauncher } from './helpers/nkLauncher.js';

const NOW = () => new Date('2026-10-14T10:00:00Z');
const LIVE = { JOBBER_DRY_RUN: 'false' } as NodeJS.ProcessEnv;
const benignScreen = async (t: string) => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' as const });

function tmp(): string { return mkdtempSync(path.join(tmpdir(), 'wellfound-test-')); }
function stateFile(): string {
  const p = path.join(tmp(), 'state.json');
  writeFileSync(p, '{"cookies":[],"origins":[]}');
  return p;
}

function deps(h: ReturnType<typeof makeNkLauncher>, extra: Record<string, unknown> = {}) {
  const sessionStatePath = stateFile();
  const dir = path.dirname(sessionStatePath);
  // layout memory and the session lock go to the temp dir, never the project's .jobber/layout or secrets/
  const layoutCfg = loadLayoutConfig({ LAYOUT_DIR: 'layout' } as NodeJS.ProcessEnv, dir);
  return {
    db: openDb(':memory:'), chromium: h.launcher, sessionStatePath, lockPath: path.join(dir, 'wellfound.lock'),
    settleMs: 0, paceMs: () => 0, confirmTimeoutMs: 50,
    env: LIVE, now: NOW, screen: benignScreen, layoutCfg, intents: new IntentStore(),
    cfg: { ...loadOutreachConfig({}) },
    checkText: async (t: string) => ({ ok: true, normalized: t.trim(), verdict: 'pass' as const }),
    style: () => ({ ok: true, hits: [] }),
    ...extra,
  } as any;
}

const head = (s: string) => JSON.parse(s.split('\n')[0]);
const state = (s: string) => s.slice(s.indexOf('\n') + 1);
const reg = () => (wellfoundServer as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;

afterEach(async () => {
  await shutdownWellfound();
});

describe('isWellfoundUrl and detection', () => {
  it('accepts https wellfound.com and subdomains only', () => {
    expect(isWellfoundUrl('https://wellfound.com/jobs/3187261-full-stack-engineer')).toBe(true);
    expect(isWellfoundUrl('https://www.wellfound.com/')).toBe(true);
    expect(isWellfoundUrl('http://wellfound.com/x')).toBe(false);
    expect(isWellfoundUrl('https://evil-wellfound.com/x')).toBe(false);
    expect(isWellfoundUrl('https://wellfound.com.evil.io/x')).toBe(false);
    expect(isWellfoundUrl('https://user:pw@wellfound.com/x')).toBe(false);
    expect(isWellfoundUrl('file:///etc/passwd')).toBe(false);
    expect(isWellfoundUrl('not a url')).toBe(false);
  });
  it('detects login redirects', () => {
    const raw = { title: 'x', url: 'https://wellfound.com/login', buttons: [], form: { open: false, hasNote: false, hasSubmit: false }, composer: { present: false, sendLabel: null }, notices: [], hasPasswordInput: false };
    expect(detectLoginRequired(raw)).toBe(true);
    expect(detectLoginRequired({ ...raw, url: JOB_URL })).toBe(false);
  });
});

describe('tool surface', () => {
  it('registers exactly the engine tools, the arm tools, the data tools and layout', () => {
    const tools = Object.keys(reg()).sort();
    expect(tools).toEqual([
      'wellfound_arm_apply', 'wellfound_arm_send', 'wellfound_click', 'wellfound_click_at', 'wellfound_close', 'wellfound_discover',
      'wellfound_inbox', 'wellfound_layout', 'wellfound_open', 'wellfound_press_key', 'wellfound_read_thread', 'wellfound_screenshot',
      'wellfound_scroll', 'wellfound_snapshot', 'wellfound_type', 'wellfound_wait_for',
    ]);
    expect([...TOOL_NAMES].sort()).toEqual(tools);
  });

  it('has no search tool and no cold-send or connect tool', () => {
    const tools = Object.keys(reg());
    for (const gone of ['wellfound_search', 'wellfound_send_message', 'wellfound_connect', 'wellfound_state']) expect(tools).not.toContain(gone);
  });

  it('descriptions carry the untrusted note and the arm rules', () => {
    for (const t of ['wellfound_open', 'wellfound_snapshot', 'wellfound_click', 'wellfound_type']) expect(reg()[t].description).toMatch(/untrusted/i);
    expect(reg().wellfound_click.description).toMatch(/wellfound_arm_send/);
    expect(reg().wellfound_click.description).toMatch(/wellfound_arm_apply/);
    expect(reg().wellfound_screenshot.description).toMatch(/WELLFOUND_SCREENSHOT/);
    expect(reg().wellfound_arm_send.description).toMatch(/Cold messages are impossible/);
  });

  it('wellfound.ts has no selector-based action code', () => {
    const src = readFileSync(new URL('../src/mcp/wellfound.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/data-nk-i|CANDIDATES_SRC|makeDriver|pickCandidate|sendInThread|page\.click\(|page\.fill\(|page\.locator\(/);
  });

  it('the screenshot and click_at tools are on by default and off only when the flag is exactly false', () => {
    const src = readFileSync(new URL('../src/mcp/wellfound.ts', import.meta.url), 'utf8');
    expect(src).toContain("env.WELLFOUND_SCREENSHOT !== 'false'");
  });
});

describe('wellfoundOpen and the session', () => {
  it('refuses a non-wellfound url before launching a browser', async () => {
    const h = makeNkLauncher();
    expect(head(await wellfoundOpen({ url: 'https://example.com/x' }, deps(h)))).toMatchObject({ ok: false, code: 'not_wellfound' });
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('launches headless real Chrome with the saved state and returns the screened page tree', async () => {
    const h = makeNkLauncher({ html: () => jobHtml(), startUrl: 'https://wellfound.com/' });
    const d = deps(h);
    const out = await wellfoundOpen({ url: JOB_URL }, d);
    expect(h.launch).toHaveBeenCalledWith(expect.objectContaining({ channel: 'chrome', headless: true, args: ['--headless=new'] }));
    const ctxOpts = h.browser.newContext.mock.calls[0][0];
    expect(ctxOpts.userAgent).not.toMatch(/Headless/);
    expect(ctxOpts.storageState).toBe(d.sessionStatePath);
    expect(head(out)).toMatchObject({ ok: true, code: 'ok', dry_run: false });
    expect(out).toContain('<<<PAGE_TEXT');
    expect(out).toMatch(/button "Apply"/);
    expect(h.gotos).toEqual([JOB_URL]);
  });

  it('fails without launching when the session state file is missing', async () => {
    const h = makeNkLauncher();
    const out = head(await wellfoundOpen({ url: JOB_URL }, { ...deps(h), sessionStatePath: '/nonexistent/wellfound-state.json' }));
    expect(out).toMatchObject({ ok: false, code: 'no_session_state' });
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('holds one lock while the session is open: a second process gets session_locked, close releases it', async () => {
    const h = makeNkLauncher({ html: () => jobHtml(), startUrl: 'https://wellfound.com/' });
    const d = deps(h);
    await wellfoundOpen({ url: JOB_URL }, d);
    expect(existsSync(d.lockPath)).toBe(true);
    // the lock names this live pid, so another acquirer is refused
    const { acquireLock } = await import('../src/linkedin/session.js');
    const other = acquireLock(d.lockPath, { pid: process.pid + 1 });
    expect(other.ok).toBe(false);
    expect(await wellfoundClose()).toBe('closed');
    expect(existsSync(d.lockPath)).toBe(false);
  });

  it('a held lock is reported as session_locked and nothing launches', async () => {
    const h = makeNkLauncher();
    const d = deps(h);
    writeFileSync(d.lockPath, JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    const out = head(await wellfoundOpen({ url: JOB_URL }, d));
    expect(out).toMatchObject({ ok: false, code: 'session_locked' });
    expect(out.reason).not.toMatch(/LinkedIn/);
    expect(h.launch).not.toHaveBeenCalled();
  });

  it('a second open reuses the one session (no relaunch)', async () => {
    const h = makeNkLauncher({ html: () => jobHtml(), startUrl: 'https://wellfound.com/' });
    const d = deps(h);
    await wellfoundOpen({ url: JOB_URL }, d);
    await wellfoundOpen({ url: THREAD_URL }, d);
    expect(h.launch).toHaveBeenCalledTimes(1);
    expect(h.browser.close).not.toHaveBeenCalled();
    expect(h.gotos).toEqual([JOB_URL, THREAD_URL]);
  });

  it('a failed launch is a fixed failed result without exception text, and frees the lock', async () => {
    const h = makeNkLauncher();
    h.launch.mockRejectedValueOnce(new Error('secret-detail /Users/x/chrome'));
    const d = deps(h);
    const out = await wellfoundOpen({ url: JOB_URL }, d);
    expect(head(out)).toMatchObject({ ok: false, code: 'failed' });
    expect(out).not.toContain('secret-detail');
    expect(existsSync(d.lockPath)).toBe(false);
  });

  it('closes the browser, is idempotent, and auto-closes after the idle timeout', async () => {
    const h = makeNkLauncher({ startUrl: 'https://wellfound.com/' });
    await wellfoundOpen({ url: JOB_URL }, deps(h));
    expect(await wellfoundClose()).toBe('closed');
    expect(h.browser.close).toHaveBeenCalledTimes(1);
    expect(await wellfoundClose()).toBe('no open session');
    const h2 = makeNkLauncher({ startUrl: 'https://wellfound.com/' });
    await wellfoundOpen({ url: JOB_URL }, deps(h2, { idleMs: 20 }));
    await new Promise((r) => setTimeout(r, 80));
    expect(h2.browser.close).toHaveBeenCalledTimes(1);
  });

  it('a bot wall halts wellfound and closes the session', async () => {
    const h = makeNkLauncher({ html: () => '<html><head><title>Just a moment...</title></head><body><h1>Just a moment...</h1></body></html>', startUrl: 'https://wellfound.com/' });
    const d = deps(h);
    expect(head(await wellfoundOpen({ url: JOB_URL }, d)).code).toBe('halted');
    expect(d.db.prepare("SELECT reason FROM halt_flags WHERE platform = 'wellfound'").get()).toMatchObject({ reason: expect.stringContaining('blocked') });
    expect(h.browser.close).toHaveBeenCalledTimes(1);
  });
});

describe('engine tools through the MCP handlers', () => {
  it('actions need a session', async () => {
    const d = { db: openDb(':memory:'), env: LIVE, now: NOW, screen: benignScreen, intents: new IntentStore() } as any;
    expect(head(await wellfoundSnapshot(d)).code).toBe('no_session');
    expect(head(await wellfoundClick({ ref: 's1.1' }, d)).code).toBe('no_session');
  });

  it('a stale ref is refused, a free control clicks, an unarmed Apply is refused without a counter', async () => {
    const h = makeNkLauncher({ html: () => jobHtml(), startUrl: 'https://wellfound.com/' });
    const d = deps(h);
    const s1 = await wellfoundOpen({ url: JOB_URL }, d);
    const old = refOf(state(s1), 'button', 'Save');
    const s2 = await wellfoundSnapshot(d);
    expect(head(await wellfoundClick({ ref: old }, d)).code).toBe('stale_ref');
    expect(h.clicks).toEqual([]);
    expect(head(await wellfoundClick({ ref: refOf(state(s2), 'button', 'Save') }, d)).code).toBe('clicked');
    const s3 = await wellfoundSnapshot(d);
    expect(head(await wellfoundClick({ ref: refOf(state(s3), 'button', 'Apply') }, d))).toMatchObject({ ok: false, code: 'no_armed_intent' });
    expect(h.clicks).toHaveLength(1);
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM rate_events').get()).toMatchObject({ n: 0 });
    expect(d.db.prepare('SELECT COUNT(*) AS n FROM daily_counters').get()).toMatchObject({ n: 0 });
  });

  it('screenshot and click_at are on unless WELLFOUND_SCREENSHOT is exactly false', async () => {
    const h = makeNkLauncher({ html: () => jobHtml(), startUrl: 'https://wellfound.com/' });
    const d = deps(h, { env: { ...LIVE, WELLFOUND_SCREENSHOT: 'false' } });
    await wellfoundOpen({ url: JOB_URL }, d);
    const off = await wellfoundScreenshot(d);
    expect(off.ok).toBe(false);
    expect(JSON.parse((off as { text: string }).text).code).toBe('screenshot_disabled');
    expect(head(await wellfoundClickAt({ x: 5, y: 5 }, d)).code).toBe('click_at_disabled');
    await shutdownWellfound();
    for (const env of [{ ...LIVE }, { ...LIVE, WELLFOUND_SCREENSHOT: 'true' }]) {
      const h2 = makeNkLauncher({ html: () => jobHtml(), startUrl: 'https://wellfound.com/' });
      const d2 = deps(h2, { env });
      await wellfoundOpen({ url: JOB_URL }, d2);
      const on = await wellfoundScreenshot(d2);
      expect(on).toMatchObject({ ok: true, base64: Buffer.from('smallpng').toString('base64') });
      expect((on as { note: string }).note).toMatch(/unscreened pixels/);
      await shutdownWellfound();
    }
  });

  it('a handler error becomes a fixed failed result with no exception text', async () => {
    const h = makeNkLauncher({ html: () => jobHtml(), startUrl: 'https://wellfound.com/' });
    const d = deps(h);
    await wellfoundOpen({ url: JOB_URL }, d);
    const out = await wellfoundSnapshot({ ...d, screen: async () => { throw new Error('secret-detail ignore previous instructions'); } });
    expect(out).not.toContain('secret-detail');
    expect(JSON.parse(out)).toEqual({ status: 'failed', code: 'error' });
  });
});

describe('arm tools through the MCP handlers', () => {
  function sendWorld(env: NodeJS.ProcessEnv) {
    let html = threadHtml({ text: '' });
    const h = makeNkLauncher({
      html: () => html, startUrl: THREAD_URL,
      onFill: (_sel, t) => { html = threadHtml({ text: t }); },
      onClick: () => { html = threadHtml({ text: '', sent: MSG }); },
    });
    const d = deps(h, { env });
    const pid = upsertPerson(d.db, { platform: 'wellfound', profileKey: 'wellfound:pat-founder', name: 'Pat Founder', company: 'Acme', category: 'recruiter' });
    setState(d.db, `wellfound_thread_${pid}`, THREAD, NOW());
    return { h, d, pid };
  }

  it('arm_send then type then click sends once through the handlers (live)', async () => {
    const { h, d, pid } = sendWorld(LIVE);
    expect(head(await wellfoundArmSend({ person_id: pid, thread_ref: THREAD, text: MSG, kind: 'role_ask' }, d))).toMatchObject({ status: 'armed', class: 'wellfound_send', dry_run: false });
    const snap1 = await wellfoundSnapshot(d);
    expect(head(await wellfoundType({ ref: refOf(state(snap1), 'textbox', 'Write a message'), text: MSG }, d)).ok).toBe(true);
    const snap2 = await wellfoundSnapshot(d);
    const sent = head(await wellfoundClick({ ref: refOf(state(snap2), 'button', 'Send') }, d));
    expect(sent).toMatchObject({ ok: true, status: 'sent', code: 'sent' });
    expect(h.clicks).toHaveLength(1);
    expect(d.db.prepare("SELECT COUNT(*) AS n FROM rate_events WHERE key = 'wellfound_message'").get()).toMatchObject({ n: 1 });
  });

  it('arm_send refuses a cold thread, in dry runs too, before any send', async () => {
    const { h, d, pid } = sendWorld({ JOBBER_DRY_RUN: 'true' } as NodeJS.ProcessEnv);
    expect(head(await wellfoundArmSend({ person_id: pid, thread_ref: 'cold-thread', text: MSG, kind: 'role_ask' }, d))).toMatchObject({ status: 'refused', code: 'unverified_thread' });
    expect(h.clicks).toEqual([]);
  });

  it('dry run: arm, type and click record and send nothing', async () => {
    const { h, d, pid } = sendWorld({ JOBBER_DRY_RUN: 'true' } as NodeJS.ProcessEnv);
    expect(head(await wellfoundArmSend({ person_id: pid, thread_ref: THREAD, text: MSG, kind: 'role_ask' }, d))).toMatchObject({ status: 'armed', dry_run: true });
    const snap1 = await wellfoundSnapshot(d);
    await wellfoundType({ ref: refOf(state(snap1), 'textbox', 'Write a message'), text: MSG }, d);
    const snap2 = await wellfoundSnapshot(d);
    expect(head(await wellfoundClick({ ref: refOf(state(snap2), 'button', 'Send') }, d))).toMatchObject({ ok: true, status: 'dry_run' });
    expect(h.clicks).toEqual([]);
    expect(listDryRun(d.db).map((x) => x.action)).toEqual(expect.arrayContaining(['wellfound_arm_send', 'wellfound_send']));
  });

  it('arm_apply opens the stored job URL, then Apply, the armed note and Submit application run under the intent', async () => {
    let html = jobHtml();
    const h = makeNkLauncher({
      html: () => html, startUrl: JOB_URL,
      onClick: () => { html = html.includes('<dialog') ? jobHtml({ confirm: 'Application sent', applied: true }) : jobHtml({ form: true }); },
      onFill: (_s, t) => { html = jobHtml({ form: true, note: t }); },
    });
    const d = deps(h);
    saveJob(d.db, { id: JOB_ID, source: 'wellfound', title: 'Full Stack Engineer', company: 'Acme', url: JOB_URL, apply_url: JOB_URL, description: 'd' });
    expect(head(await wellfoundArmApply({ job_id: JOB_ID, note: NOTE }, d))).toMatchObject({ status: 'armed', class: 'wellfound_apply' });
    expect(h.gotos).toEqual([JOB_URL]);
    const s1 = await wellfoundSnapshot(d);
    expect(head(await wellfoundClick({ ref: refOf(state(s1), 'button', 'Apply') }, d)).code).toBe('form_opened');
    const s2 = await wellfoundSnapshot(d);
    expect(head(await wellfoundType({ ref: refOf(state(s2), 'textbox', 'Write a note to the team'), text: NOTE }, d)).ok).toBe(true);
    const s3 = await wellfoundSnapshot(d);
    expect(head(await wellfoundClick({ ref: refOf(state(s3), 'button', 'Submit application') }, d))).toMatchObject({ status: 'sent', code: 'applied' });
    expect(d.db.prepare('SELECT platform, method, status FROM applications').all()).toEqual([{ platform: 'wellfound', method: 'native', status: 'submitted' }]);
  });

  it('arm_apply refuses an unknown job without touching the browser', async () => {
    const h = makeNkLauncher({ startUrl: JOB_URL });
    const d = deps(h);
    expect(head(await wellfoundArmApply({ job_id: 'wellfound:424242' }, d))).toMatchObject({ status: 'refused', code: 'unknown_job' });
    expect(h.gotos).toEqual([]);
  });

  it('arm tools report no_session_state without launching', async () => {
    const h = makeNkLauncher();
    const d = { ...deps(h), sessionStatePath: '/nonexistent/wellfound-state.json' };
    expect(head(await wellfoundArmApply({ job_id: JOB_ID }, d)).code).toBe('no_session_state');
    expect(head(await wellfoundArmSend({ person_id: 1, thread_ref: THREAD, text: MSG, kind: 'role_ask' }, d)).code).toBe('no_session_state');
    expect(h.launch).not.toHaveBeenCalled();
  });
});

describe('discover, inbox, thread and layout', () => {
  const cardHref = (n: number) => `https://wellfound.com/jobs/${3187000 + n}-full-stack-engineer`;
  const snapRaw = (url: string) => ({
    title: 'Wellfound', url, buttons: ['Apply'], form: { open: false, hasNote: false, hasSubmit: false },
    composer: { present: false, sendLabel: null }, notices: [], hasPasswordInput: false,
  });

  function world(over: { threadPage?: unknown; loggedOut?: boolean } = {}) {
    const h = makeNkLauncher({
      html: () => jobHtml(), startUrl: 'https://wellfound.com/',
      other: (src) => {
        if (src === SEARCH_SRC) return [1, 2].map((n) => ({ title: `React Engineer ${n}`, company: `Acme ${n}`, href: cardHref(n), snippet: 'Build React apps with TypeScript.' }));
        if (src === INBOX_SRC) return [
          { href: 'https://wellfound.com/jobs/messages/thread-1', sender: 'Pat Founder', company: 'Acme', preview: 'Are you open to a chat?', unread: true, at: 'today' },
          { href: 'https://evil.example/messages/x', id: 'bad ref!', sender: 'X', preview: 'p', unread: true },
        ];
        if (src === THREAD_SRC) return over.threadPage ?? { recipient: 'Pat Founder', company: 'Acme', messages: [{ from: 'them', text: 'Are you open to a chat?', at: 'today' }] };
        if (src === SNAPSHOT_SRC) return snapRaw(over.loggedOut ? 'https://wellfound.com/login' : h.page.url());
        return null;
      },
    });
    return h;
  }

  it('discover runs one named search, saves jobs under source wellfound and returns counts only', async () => {
    const h = world();
    const d = deps(h);
    await wellfoundOpen({ url: 'https://wellfound.com/' }, d);
    const out = JSON.parse(await wellfoundDiscover({ search: 'full-stack-react-india-remote', detail_quota: 0 }, d));
    expect(out).toMatchObject({ status: 'ok', code: 'saved', fetched: 2, new: 2, job_ids: ['wellfound:3187001', 'wellfound:3187002'] });
    expect(JSON.stringify(out)).not.toMatch(/React Engineer|Acme/);
    expect(d.db.prepare("SELECT source FROM jobs WHERE id = 'wellfound:3187001'").get()).toMatchObject({ source: 'wellfound' });
    expect(h.gotos).toContain('https://wellfound.com/role/l/full-stack-engineer/india?remote=true');
  });

  it('discover needs a session, a known search name and an open halt gate', async () => {
    const h = world();
    const d = deps(h);
    expect(JSON.parse(await wellfoundDiscover({ search: 'full-stack-react-india-remote' }, d))).toMatchObject({ status: 'no_session' });
    await wellfoundOpen({ url: 'https://wellfound.com/' }, d);
    expect(JSON.parse(await wellfoundDiscover({ search: 'nope' }, d))).toMatchObject({ status: 'failed', code: 'unknown_search' });
    expect(JSON.parse(await wellfoundDiscover({ search: '../../etc' }, d))).toMatchObject({ code: 'unknown_search' });
    haltPlatform(d.db, 'wellfound', 'test', NOW());
    expect(JSON.parse(await wellfoundDiscover({ search: 'full-stack-react-india-remote' }, d))).toMatchObject({ status: 'halted' });
  });

  it('discover stops at the login wall', async () => {
    const h = world({ loggedOut: true });
    const d = deps(h);
    await wellfoundOpen({ url: 'https://wellfound.com/' }, d);
    const out = JSON.parse(await wellfoundDiscover({ search: 'full-stack-react-india-remote' }, d));
    expect(out).toMatchObject({ status: 'failed', code: 'login_required' });
    expect(d.db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE source = 'wellfound'").get()).toMatchObject({ n: 0 });
  });

  it('inbox lists addressable threads and skips the unaddressable, inside an untrusted block', async () => {
    const h = world();
    const d = deps(h);
    await wellfoundOpen({ url: 'https://wellfound.com/' }, d);
    const out = await wellfoundInbox({ unread_only: true }, d);
    expect(out).toContain('count=1 skipped_unaddressable=1');
    expect(out).toContain('<<<PAGE_TEXT');
    expect(out).toContain('ref=thread-1');
    expect(h.gotos).toContain('https://wellfound.com/jobs/messages');
  });

  it('read_thread returns the classifier verdict before the untrusted text; a bad ref is refused; a halt stops it', async () => {
    const h = world();
    const d = deps(h);
    await wellfoundOpen({ url: 'https://wellfound.com/' }, d);
    const out = await wellfoundReadThread({ thread_ref: THREAD }, d);
    expect(out.indexOf('verdict:')).toBeGreaterThan(-1);
    expect(out.indexOf('verdict:')).toBeLessThan(out.indexOf('<<<PAGE_TEXT'));
    expect(out).toContain('person_id=null');
    expect(JSON.parse(await wellfoundReadThread({ thread_ref: 'a b' }, d))).toMatchObject({ status: 'refused' });
    haltPlatform(d.db, 'wellfound', 'x', NOW());
    expect(JSON.parse(await wellfoundReadThread({ thread_ref: THREAD }, d))).toMatchObject({ status: 'halted' });
  });

  it('read_thread escalates an inbound message that asks for salary and never allows an auto reply', async () => {
    const h = world({ threadPage: { recipient: 'Pat Founder', company: 'Acme', messages: [{ from: 'them', text: 'What are your salary expectations? CTC please.', at: 'today' }] } });
    const d = deps(h);
    await wellfoundOpen({ url: 'https://wellfound.com/' }, d);
    const out = await wellfoundReadThread({ thread_ref: THREAD }, d);
    expect(out).toMatch(/escalate=true may_auto_reply=false/);
  });

  it('layout is read-only vocabulary data and the session feeds it', async () => {
    const h = world();
    const d = deps(h);
    await wellfoundOpen({ url: JOB_URL }, d);
    const l = JSON.parse(await wellfoundLayout(d));
    expect(l).toHaveProperty('enforce');
    expect(l).toHaveProperty('verdict_last');
    expect(JSON.stringify(l)).not.toMatch(/Build React apps/);
  });

  it('threadRefFromRaw and pageAgeDays', () => {
    expect(threadRefFromRaw('https://wellfound.com/jobs/messages/abc-12')).toBe('abc-12');
    expect(threadRefFromRaw('https://evil.example/jobs/messages/abc-12')).toBeNull();
    expect(threadRefFromRaw(undefined, 'id-9')).toBe('id-9');
    expect(threadRefFromRaw(undefined, 'bad id!')).toBeNull();
    expect(pageAgeDays('3 days ago', 0)).toBe(3);
    expect(pageAgeDays('2999-01-01', 0)).toBeNull();
  });
});
