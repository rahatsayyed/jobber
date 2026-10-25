// Live failure of wake 3440d5ba: arm bumped the epoch, a parallel arm+click lost the session, and the
// Connect click saw no invite dialog. Fakes only (invented profile "Jane Example").
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { profileKeyOf } from '../src/linkedin/urls.js';
import { createRuntime } from '../src/linkedin/runtime.js';
import { IntentStore } from '../src/browserctl/intent.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { buildHandlers } from '../src/mcp/linkedin.js';
import { fakeBcPage } from './helpers/fakeBc.js';
import { makeFakeLauncher } from './helpers/fakeLinkedin.js';
import { LIVE_ENV, NOTE, URL_, inviteDialog, profileHtml, refOf, world, type World } from './helpers/bcWorld.js';

const worlds: World[] = [];
const mk = (o: Parameters<typeof world>[0]) => { const w = world(o); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });
const clicks = (w: World) => w.page.log.filter((l) => l.startsWith('click'));
const epochOf = (state: string) => Number(/^epoch: (\d+)/m.exec(state)![1]);

const NAMED_ELSEWHERE = (name = 'Jane Example', note = NOTE) => `<div role="alertdialog" aria-label="Grow your network">
<h2>Grow your network</h2><p>Invite ${name} to connect</p><textarea>${note}</textarea>
<footer><button>Cancel</button><button>Add a note</button><button>Send without a note</button><button>Send</button></footer></div>`;

describe('arm keeps the operator refs valid', () => {
  it('arm on the already open profile does not change the epoch, and the earlier ref still clicks', async () => {
    const w = mk({ html: profileHtml(), env: LIVE_ENV });
    const state = await w.snap();
    const connect = refOf(state, 'button', 'Connect');
    const e0 = w.engine.refs.epoch;
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    expect(w.engine.refs.epoch).toBe(e0);
    expect(w.page.log.some((l) => l.startsWith('goto'))).toBe(false);
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(profileHtml({ dialog: inviteDialog() })); };
    expect(await w.engine.click(connect)).toMatchObject({ ok: true, code: 'dialog_opened' });
  });

  it('a refused commit with no armed intent leaves the refs valid', async () => {
    const w = mk({ html: profileHtml(), env: LIVE_ENV });
    const connect = refOf(await w.snap(), 'button', 'Connect');
    expect((await w.engine.click(connect)).code).toBe('no_armed_intent');
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(profileHtml({ dialog: inviteDialog() })); };
    expect((await w.engine.click(connect)).code).toBe('dialog_opened');
  });

  it('ordinals that moved after a page mutation are re-resolved by role and name', async () => {
    const w = mk({ html: profileHtml(), env: LIVE_ENV });
    const connect = refOf(await w.snap(), 'button', 'Connect');
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    // LinkedIn injects a control in front: every ordinal after it shifts by one.
    w.page.setHtml(profileHtml().replace('<h1>', '<button>Notifications</button><h1>'));
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(profileHtml({ dialog: inviteDialog() })); };
    expect(await w.engine.click(connect)).toMatchObject({ ok: true, code: 'dialog_opened' });
    expect(clicks(w)).toHaveLength(1);
  });

  it('a ref whose name now matches two elements fails closed', async () => {
    const w = mk({ html: profileHtml(), env: LIVE_ENV });
    const more = refOf(await w.snap(), 'button', 'More');
    w.page.setHtml(profileHtml().replace('<h1>', '<button>Notifications</button><h1>').replace('<button>Follow</button>', '<button>More</button>'));
    const r = await w.engine.click(more);
    expect(r.code).toBe('target_changed');
    expect(clicks(w)).toEqual([]);
  });
});

describe('Connect click: invite surface detection', () => {
  const armedWorld = async () => {
    const w = mk({ html: profileHtml(), env: LIVE_ENV });
    const connect = refOf(await w.snap(), 'button', 'Connect');
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    return { w, connect };
  };

  it('waits for a dialog that appears a moment after the click', async () => {
    const { w, connect } = await armedWorld();
    let afterClick = false; let waits = 0;
    w.page.onAct = (what) => { if (what.startsWith('click')) afterClick = true; };
    w.page.waitMs = async () => { if (afterClick && ++waits === 4) w.page.setHtml(profileHtml({ dialog: inviteDialog() })); };
    expect(await w.engine.click(connect)).toMatchObject({ ok: true, code: 'dialog_opened' });
    expect(waits).toBeGreaterThanOrEqual(4);
  });

  it('no_dialog (nothing sent) when nothing appears within the wait', async () => {
    const { w, connect } = await armedWorld();
    const r = await w.engine.click(connect);
    expect(r).toMatchObject({ status: 'failed', code: 'no_dialog_after_connect' });
    expect(w.intents.peek('linkedin')).toBeNull();
  });

  it('accepts an alertdialog with an unrelated name when it holds the invite controls', async () => {
    const { w, connect } = await armedWorld();
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(profileHtml({ dialog: NAMED_ELSEWHERE() })); };
    expect(await w.engine.click(connect)).toMatchObject({ ok: true, code: 'dialog_opened' });
    expect(w.intents.peek('linkedin')).not.toBeNull();
  });

  it('accepts a navigated invite page that carries Add a note / Send controls', async () => {
    const { w, connect } = await armedWorld();
    w.page.onAct = (what) => {
      if (!what.startsWith('click')) return;
      w.page.currentUrl = 'https://www.linkedin.com/preload/custom-invite/?vanityName=jane-example';
      w.page.setHtml('<html><head><title>Invite</title></head><body><main><h1>Invite Jane Example to connect</h1><button>Add a note</button><button>Send without a note</button></main></body></html>');
    };
    expect(await w.engine.click(connect)).toMatchObject({ ok: true, code: 'invite_page_opened' });
  });

  it('a page that merely moved without invite controls is not an invite page', async () => {
    const { w, connect } = await armedWorld();
    w.page.onAct = (what) => {
      if (!what.startsWith('click')) return;
      w.page.currentUrl = 'https://www.linkedin.com/feed/';
      w.page.setHtml('<html><body><main><h1>Feed</h1><button>Post</button></main></body></html>');
    };
    expect((await w.engine.click(connect)).code).toBe('no_dialog_after_connect');
  });

  it('a message overlay is not mistaken for the invite dialog', async () => {
    const { w, connect } = await armedWorld();
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(profileHtml({ dialog: '<div role="dialog" aria-label="Messaging"><h2>Jane Example</h2><textarea></textarea><footer><button>Send</button></footer></div>' })); };
    expect((await w.engine.click(connect)).code).toBe('no_dialog_after_connect');
  });
});

describe('Send in an oddly named invite dialog stays fail closed', () => {
  const sendRef = (state: string) => refOf(state, 'button', 'Send');

  it('verified recipient and exact text: sent', async () => {
    const w = mk({ html: profileHtml({ dialog: NAMED_ELSEWHERE() }), env: LIVE_ENV });
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    const ref = sendRef(await w.snap());
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(profileHtml()); };
    const r = await w.engine.click(ref);
    expect(r).toMatchObject({ ok: true, status: 'sent' });
    expect(clicks(w)).toHaveLength(1);
  });

  it('a different person named in the dialog: refused, nothing clicked', async () => {
    const w = mk({ html: profileHtml({ dialog: NAMED_ELSEWHERE('Mallory Evil') }), env: LIVE_ENV });
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    const r = await w.engine.click(sendRef(await w.snap()));
    expect(r.code).toBe('dialog_recipient_mismatch');
    expect(clicks(w)).toEqual([]);
  });

  it('different text in the composer: refused, nothing clicked', async () => {
    const w = mk({ html: profileHtml({ dialog: NAMED_ELSEWHERE('Jane Example', 'Buy my course today') }), env: LIVE_ENV });
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    const r = await w.engine.click(sendRef(await w.snap()));
    expect(r.ok).toBe(false);
    expect(clicks(w)).toEqual([]);
  });

  it('a Send button in an unrelated dialog is still refused', async () => {
    const w = mk({ html: profileHtml({ dialog: '<div role="dialog" aria-label="Share"><h2>Share this</h2><footer><button>Send</button></footer></div>' }), env: LIVE_ENV });
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    const r = await w.engine.click(sendRef(await w.snap()));
    expect(r.code).toBe('irreversible_refused');
    expect(clicks(w)).toEqual([]);
  });
});

describe('MCP: a parallel arm and click', () => {
  it('run one after the other: click sees the armed intent and a valid ref', async () => {
    const db = openDb(':memory:');
    upsertPerson(db, { platform: 'linkedin', profileKey: profileKeyOf(URL_), name: 'Jane Example', headline: 'Technical Recruiter at Acme', company: 'Acme', category: 'recruiter' });
    const page = fakeBcPage(profileHtml(), URL_);
    const rt = { page: () => ({ evaluate: async () => 'c21hbGw=' }), touch: () => undefined, discard: async () => true, close: async () => true, layout: undefined } as never;
    const handlers = buildHandlers({
      db, rt, env: { JOBBER_DRY_RUN: 'true' }, now: () => new Date('2026-10-14T10:00:00Z'),
      factCheck: (t: string) => ({ verdict: 'pass' as const, normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG,
      intents: new IntentStore(), bcPage: () => page, paceMs: () => 0, settleMs: 0,
    });
    const opened = String(await handlers.linkedin_open({ url: URL_ }));
    const ref = /\[(s\d+\.\d+)\] button "Connect"/.exec(opened)![1];
    const e0 = epochOf(opened);
    const [arm, click] = await Promise.all([
      handlers.linkedin_arm_send({ kind: 'connect_note', profile_url: URL_, text: NOTE }),
      handlers.linkedin_click({ ref }),
    ]);
    expect(JSON.parse(String(arm))).toMatchObject({ status: 'armed' });
    expect(JSON.parse(String(click).split('\n')[0])).toMatchObject({ status: 'dry_run' });
    expect(e0).toBeGreaterThan(0);
  });
});

describe('runtime idle close', () => {
  it('does not close the session while a tool call is in flight', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'li-idle-'));
    try {
      const { writeFileSync, chmodSync } = await import('node:fs');
      const sessionPath = path.join(dir, 'state.json');
      writeFileSync(sessionPath, JSON.stringify({ cookies: [{ name: 'li_at', value: 'X', domain: '.linkedin.com', path: '/' }], origins: [] }), { mode: 0o600 });
      chmodSync(sessionPath, 0o600);
      const launcher = makeFakeLauncher({ state: { cookies: [{ name: 'li_at', value: 'X', domain: '.linkedin.com', path: '/' }], origins: [] }, pages: { '/in/jane-example/': { title: 'Jane | LinkedIn' } } } as never, []);
      let busy = true;
      const rt = createRuntime({ db: openDb(':memory:'), launcher, sessionPath, lockPath: path.join(dir, 'l.lock'), settleMs: 0, idleMs: 30, env: {}, isBusy: () => busy });
      expect((await rt.open('https://www.linkedin.com/in/jane-example/')).ok).toBe(true);
      await new Promise((r) => setTimeout(r, 120));
      expect(rt.page()).not.toBeNull();
      busy = false;
      await new Promise((r) => setTimeout(r, 120));
      expect(rt.page()).toBeNull();
      await rt.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
