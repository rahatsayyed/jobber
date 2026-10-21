import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { haltReason, recordEvent } from '../src/outreach/limits.js';
import { createRuntime, type Runtime } from '../src/linkedin/runtime.js';
import { buildSnapshotFromHtml } from '../src/linkedin/snapshot.js';
import { loadLinkedinConfig } from '../src/linkedin/config.js';
import { SELECTORS } from '../src/linkedin/selectors.js';
import { profileKeyOf } from '../src/linkedin/urls.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { sendMessage } from '../src/linkedin/sendMessage.js';
import type { ToolDeps } from '../src/linkedin/toolDeps.js';
import { makeFakeLauncher, type FakeElement, type FakeSite } from './helpers/fakeLinkedin.js';

const STATE = { cookies: [{ name: 'li_at', value: 'SENTINEL-NOT-REAL', domain: '.linkedin.com', path: '/' }], origins: [] };
const fx = (n: string) => readFileSync(new URL(`./fixtures/linkedin/${n}`, import.meta.url), 'utf8');
const URL_ = 'https://www.linkedin.com/in/jane-example/';
const P = '/in/jane-example/';
const MSG = 'Hi Jane, thanks for connecting. Curious how the platform team is shaping its roadmap this quarter.';
const NOW = new Date('2026-10-14T10:00:00Z');
const FAST = { composeClearTimeoutMs: 1, composeClearPollMs: 1, stepTimeoutMs: 1, networkConfirmationTimeoutMs: 1 };
let dir: string;
const runtimes: Runtime[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'li-'));
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(STATE), { mode: 0o600 });
  chmodSync(path.join(dir, 'state.json'), 0o600);
});
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Opts {
  header?: string | null;      // overlay header after clicking Message
  echo?: boolean;              // me message appears in overlay after Send
  stuck?: boolean;             // compose box never clears
  noCompose?: boolean;
  twoOverlays?: boolean;
  hiddenJane?: boolean;
  composeElsewhere?: boolean;
  pageSend?: boolean;
  noBubble?: boolean;
  noSend?: boolean;
  echoText?: string;
  noNetwork?: boolean;
  notConnected?: boolean;
  ariaLabel?: string;
  noNamePoint?: boolean;
  blockAfterSend?: boolean;
  bodyText?: string;
  env?: NodeJS.ProcessEnv;
  site?: Partial<FakeSite>;
}

function setup(o: Opts = {}) {
  const log: string[] = [];
  const db = openDb(':memory:');
  upsertPerson(db, { platform: 'linkedin', profileKey: profileKeyOf(URL_), name: 'Jane Example', headline: 'Technical Recruiter at Acme', company: 'Acme', category: 'recruiter' });
  const base = buildSnapshotFromHtml(fx(o.notConnected ? 'profile-not-connected.html' : 'profile-connected.html'), URL_);
  const els: Record<string, FakeElement[]> = {};
  if (!o.noNamePoint) els[SELECTORS.nameHeadings] = [{ text: 'Jane Example', box: { x: 100, y: 100, height: 30 } }];
  let eventsAtSend = -1;
  const state: { msgs: FakeElement[] } = { msgs: [] };
  const def: any = { ...base, ...(o.bodyText ? { bodyText: o.bodyText } : {}), elements: els };
  els[SELECTORS.messageButton] = [{
    text: 'Message', box: { x: 100, y: 240, height: 40 }, ...(o.ariaLabel ? { attrs: { 'aria-label': o.ariaLabel } } : {}),
    onClick: () => {
      const msgs: FakeElement[] = [{ text: 'Hi, thanks for connecting.', attrs: { class: 'them' } }];
      state.msgs = msgs;
      const sendEl: FakeElement = {
        text: 'Send',
        onClick: () => {
          eventsAtSend = (db.prepare("SELECT COUNT(*) c FROM rate_events WHERE key='linkedin_message'").get() as { c: number }).c;
          if (o.echo !== false) msgs.push({ text: o.echoText ?? MSG, attrs: { class: 'me' } });
        },
        ...(o.blockAfterSend ? { navigateTo: 'https://www.linkedin.com/checkpoint/challenge/abc' } : {}),
      };
      const children = (name: string | null, withCompose: boolean): Record<string, FakeElement[]> => ({
        ...(name ? { [SELECTORS.conversationBubbleHeader]: [{ text: name }] } : {}),
        ...(withCompose ? { [SELECTORS.messageComposeTextarea]: [{ text: o.stuck ? 'stuck text' : '' }] } : {}),
        ...(!o.noSend ? { [SELECTORS.messageSendButton]: [sendEl] } : {}),
        [SELECTORS.conversationBubbleMessages]: msgs,
      });
      const header = o.header === undefined ? 'Jane Example' : o.header;
      els['.msg-overlay-list-bubble'] = [{ text: 'Messaging' }];
      if (o.pageSend) els[SELECTORS.messageSendButton] = [{ text: 'PageSend' }];
      if (o.twoOverlays) {
        els[SELECTORS.conversationBubble] = [
          { text: 'jane', children: children('Jane Example', true) },
          { text: 'bob', children: children('Bob Other', true) },
        ];
      } else if (o.hiddenJane) {
        els[SELECTORS.conversationBubble] = [
          { text: 'jane', visible: false, children: children('Jane Example', true) },
          { text: 'bob', children: children('Bob Other', true) },
        ];
      } else if (o.composeElsewhere) {
        els[SELECTORS.conversationBubble] = [
          { text: 'jane', children: children('Jane Example', false) },
          { text: 'bob', visible: false, children: children('Bob Other', true) },
        ];
      } else if (!o.noBubble) {
        els[SELECTORS.conversationBubble] = [{ text: 'bubble', children: children(header, !o.noCompose) }];
      }
    },
  }];
  const site: FakeSite = { pages: { [P]: def }, noResponse: o.noNetwork ?? false, ...o.site };
  if (o.blockAfterSend) {
    site.pages['/checkpoint/challenge/abc'] = buildSnapshotFromHtml(fx('checkpoint.html'), 'https://www.linkedin.com/checkpoint/challenge/abc');
  }
  const launcher = makeFakeLauncher(site, log);
  const rt = createRuntime({
    db, launcher, sessionPath: path.join(dir, 'state.json'), lockPath: path.join(dir, 'l.lock'), settleMs: 0, env: {},
  });
  runtimes.push(rt);
  const env = { LINKEDIN_DRY_RUN: 'false', SCHEDULER_DRY_RUN: 'false', ...o.env };
  const deps: ToolDeps = {
    rt, db, now: () => NOW, cfg: loadLinkedinConfig(env), env,
    factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG, screen: async (t) => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' as const }),
  };
  return { deps, log, db, els, def, state, eventsAtSend: () => eventsAtSend };
}

const send = (deps: ToolDeps, over: Partial<Parameters<typeof sendMessage>[0]> = {}) =>
  sendMessage({ profile_url: URL_, text: MSG, kind: 'rapport', job_id: 'job-1', company: 'Acme', ...over }, deps, FAST);
const sendClicks = (log: string[]) => log.filter((l) => l.startsWith(`click:${SELECTORS.messageSendButton}`));
const msgClicks = (log: string[]) => log.filter((l) => l.startsWith(`click:${SELECTORS.messageButton}`));
const events = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT COUNT(*) c FROM rate_events WHERE key='linkedin_message'").get() as { c: number }).c;
const touchStatus = (db: ReturnType<typeof openDb>) =>
  (db.prepare('SELECT status FROM touches ORDER BY id DESC LIMIT 1').get() as { status: string } | undefined)?.status;

describe('sendMessage', () => {
  it('happy path: sent, one event before click, messaged connection row', async () => {
    const t = setup();
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'sent', code: 'sent' });
    expect(t.eventsAtSend()).toBe(1);
    expect(events(t.db)).toBe(1);
    expect(touchStatus(t.db)).toBe('sent');
    expect(t.db.prepare('SELECT status, note, profile_url FROM connections').get()).toMatchObject({ status: 'messaged', note: MSG, profile_url: URL_ });
  });

  it('confirms by network when there is no echo', async () => {
    const t = setup({ echo: false });
    expect((await send(t.deps)).status).toBe('sent');
  });

  it('cleared but no echo and no network -> unconfirmed', async () => {
    const t = setup({ echo: false, noNetwork: true });
    const r = await send(t.deps);
    expect(r.status).toBe('unconfirmed');
    expect(touchStatus(t.db)).toBe('unconfirmed');
    expect(t.db.prepare('SELECT COUNT(*) c FROM connections').get()).toMatchObject({ c: 0 });
  });

  it('not 1st-degree (no bell) -> not_connected, no click', async () => {
    const t = setup({ notConnected: true });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'not_connected' });
    expect(t.log.filter((l) => l.startsWith('click:'))).toEqual([]);
    expect(events(t.db)).toBe(0);
  });

  it('a followed 3rd-degree profile (bell present, Connect shown) is still not connected: refused, no click', async () => {
    const t = setup({ notConnected: true });
    t.def.profile = { ...t.def.profile, hasBell: true, degree: '3rd', actions: ['Message', 'Connect', 'More', 'Follow'] };
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'not_connected' });
    expect(t.log.filter((l) => l.startsWith('click:'))).toEqual([]);
    expect(events(t.db)).toBe(0);
  });

  it('overlay header names someone else -> refused, Escape, no Send click', async () => {
    const t = setup({ header: 'Other Person' });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'recipient_mismatch' });
    expect(sendClicks(t.log)).toEqual([]);
    expect(t.log).toContain('press:Escape');
    expect(events(t.db)).toBe(0);
  });

  it('empty overlay header -> overlay_name_unverified', async () => {
    const t = setup({ header: null });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'overlay_name_unverified' });
    expect(sendClicks(t.log)).toEqual([]);
    expect(t.log).toContain('press:Escape');
  });

  it('compose box never appears -> failed, no Send click', async () => {
    const t = setup({ noCompose: true });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'failed', code: 'compose_missing' });
    expect(sendClicks(t.log)).toEqual([]);
    expect(events(t.db)).toBe(0);
  });

  it('compose never clears -> unconfirmed', async () => {
    const t = setup({ stuck: true });
    const r = await send(t.deps);
    expect(r.status).toBe('unconfirmed');
    expect(t.db.prepare('SELECT COUNT(*) c FROM connections').get()).toMatchObject({ c: 0 });
  });

  it('default config is dry run: no click, no event', async () => {
    const t = setup({ env: { LINKEDIN_DRY_RUN: undefined } });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'dry_run', would_send: { kind: 'rapport', chars: MSG.length, recipient: profileKeyOf(URL_) } });
    expect(t.log.filter((l) => l.startsWith('click:') || l.startsWith('fill:'))).toEqual([]);
    expect(events(t.db)).toBe(0);
    expect(touchStatus(t.db)).toBe('dry_run');
  });

  it('12 consecutive words copied from the page -> output_gate_page', async () => {
    const t = setup({ bodyText: 'Headline: Curious how the platform team is shaping its roadmap this quarter and more.' });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'output_gate_page' });
    expect(t.log.filter((l) => l.startsWith('click:'))).toEqual([]);
  });

  it('weekly ceiling reached -> rate_limited, no Send click', async () => {
    const t = setup({ env: { LINKEDIN_MAX_MESSAGES_PER_WEEK: '1' } });
    recordEvent(t.db, 'linkedin_message', NOW);
    const r = await send(t.deps);
    expect(r.status).toBe('rate_limited');
    expect(sendClicks(t.log)).toEqual([]);
    expect(events(t.db)).toBe(1);
  });

  it('followup with em dash -> style_gate', async () => {
    const t = setup();
    const r = await send(t.deps, { kind: 'followup', text: 'Hi Jane — just checking in on this.' });
    expect(r).toMatchObject({ status: 'refused', code: 'style_gate' });
    expect(t.log.filter((l) => l.startsWith('click:'))).toEqual([]);
  });

  it('block page after Send -> unconfirmed and halt flag set', async () => {
    const t = setup({ blockAfterSend: true });
    const r = await send(t.deps);
    expect(r.status).toBe('unconfirmed');
    expect(haltReason(t.db, 'linkedin')).not.toBeNull();
    expect(touchStatus(t.db)).toBe('unconfirmed');
  });

  it('unknown name position -> failed, Message never clicked', async () => {
    const t = setup({ noNamePoint: true });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'failed', code: 'name_position_unknown' });
    expect(msgClicks(t.log)).toEqual([]);
  });

  it('Message control labelled for another person -> failed, never clicked', async () => {
    const t = setup({ ariaLabel: 'Message Someone Else' });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'failed', code: 'message_target_mismatch' });
    expect(msgClicks(t.log)).toEqual([]);
  });

  it('Message control labelled with first name only is accepted', async () => {
    const t = setup({ ariaLabel: 'Message Jane' });
    expect((await send(t.deps)).status).toBe('sent');
  });

  it('two overlays (Jane collapsed first, Bob expanded) -> overlay_ambiguous, nothing typed or sent', async () => {
    const t = setup({ twoOverlays: true });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'overlay_ambiguous' });
    expect(t.log.filter((l) => l.startsWith('fill:'))).toEqual([]);
    expect(sendClicks(t.log)).toEqual([]);
    expect(t.log).toContain('press:Escape');
    expect(events(t.db)).toBe(0);
  });

  it('bad kind (connect, unknown) -> refused/bad_kind, no touch row, no page access', async () => {
    const t = setup();
    for (const kind of ['connect', 'bogus']) {
      const r = await send(t.deps, { kind: kind as any });
      expect(r).toMatchObject({ status: 'refused', code: 'bad_kind' });
    }
    expect(t.db.prepare('SELECT COUNT(*) c FROM touches').get()).toMatchObject({ c: 0 });
    expect(t.log).toEqual([]);
  });

  it('rate_limited after fill clears the compose box and escapes', async () => {
    const t = setup({ env: { LINKEDIN_MAX_MESSAGES_PER_WEEK: '1' } });
    recordEvent(t.db, 'linkedin_message', NOW);
    const r = await send(t.deps);
    expect(r.status).toBe('rate_limited');
    expect(t.log.filter((l) => l.startsWith('fill:'))).toHaveLength(2);
    expect(t.log).toContain('press:Escape');
    expect(sendClicks(t.log)).toEqual([]);
  });

  it('missing Send control clears the compose box, escapes, burns no quota', async () => {
    const t = setup({ noSend: true });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'failed', code: 'send_button_missing' });
    expect(t.log.filter((l) => l.startsWith('fill:'))).toHaveLength(2);
    expect(t.log).toContain('press:Escape');
    expect(events(t.db)).toBe(0);
  });

  it('cleared with a short (<40 char) truncated echo and no network -> unconfirmed', async () => {
    const t = setup({ echoText: 'Hi Jane, thanks for connecting.', noNetwork: true });
    expect((await send(t.deps)).status).toBe('unconfirmed');
  });

  it('echo identical to the pre-send last me message is not a confirmation', async () => {
    const t = setup({ noNetwork: true });
    const orig = t.els[SELECTORS.messageButton][0].onClick!;
    t.els[SELECTORS.messageButton][0].onClick = () => { orig(); t.state.msgs.push({ text: MSG, attrs: { class: 'me' } }); };
    expect((await send(t.deps)).status).toBe('unconfirmed');
  });

  it('dock present plus one conversation bubble: happy path works', async () => {
    const t = setup();
    expect((await send(t.deps)).status).toBe('sent');
    expect(t.els['.msg-overlay-list-bubble']).toBeDefined();
  });

  it('Jane bubble hidden, only Bob visible -> refused recipient_mismatch, nothing typed', async () => {
    const t = setup({ hiddenJane: true });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'recipient_mismatch' });
    expect(t.log.filter((l) => l.startsWith('fill:'))).toEqual([]);
  });

  it('compose exists only in a different bubble -> failed/compose_missing, no fill', async () => {
    const t = setup({ composeElsewhere: true });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'failed', code: 'compose_missing' });
    expect(t.log.filter((l) => l.startsWith('fill:'))).toEqual([]);
    expect(events(t.db)).toBe(0);
  });

  it('no conversation bubble opens -> failed/overlay_not_open', async () => {
    const t = setup({ noBubble: true });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'failed', code: 'overlay_not_open' });
  });

  it('Send is scoped to the bubble: a page-level Send outside it is never clicked', async () => {
    const t = setup({ pageSend: true });
    expect((await send(t.deps)).status).toBe('sent');
    expect(t.log.some((l) => l.includes(':PageSend'))).toBe(false);
  });

  it('page-level Send exists but the bubble has none -> send_button_missing, PageSend not clicked', async () => {
    const t = setup({ pageSend: true, noSend: true });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'failed', code: 'send_button_missing' });
    expect(t.log.some((l) => l.includes(':PageSend'))).toBe(false);
  });
});
