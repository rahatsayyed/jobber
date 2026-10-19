import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { createRuntime, type Runtime } from '../src/linkedin/runtime.js';
import { buildSnapshotFromHtml } from '../src/linkedin/snapshot.js';
import { loadLinkedinConfig } from '../src/linkedin/config.js';
import { SELECTORS } from '../src/linkedin/selectors.js';
import { profileKeyOf } from '../src/linkedin/urls.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { personByProfileKey } from '../src/linkedin/touches.js';
import { connectSend } from '../src/linkedin/connectSend.js';
import { layoutPrecondition } from '../src/linkedin/layoutGuard.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import type { LayoutObserver } from '../src/layout/runtime.js';
import type { Verdict } from '../src/layout/types.js';
import type { ToolDeps } from '../src/linkedin/toolDeps.js';
import { makeFakeLauncher, type FakeElement, type FakeSite } from './helpers/fakeLinkedin.js';

const cfgOf = (enforce: string) => loadLayoutConfig({ LAYOUT_ENFORCE: enforce });
const V = (class_: 'match' | 'partial' | 'drift' | 'unknown', missing: string[] = []): Verdict =>
  ({ class: class_, score: 0.5, missing, variant: 'abc' });

describe('layoutPrecondition', () => {
  const tools = ['connect_send', 'send_message', 'accept_invite'] as const;

  it('off and warn never refuse; warn notes a non-match', () => {
    for (const mode of ['off', 'warn']) {
      for (const t of tools) {
        for (const v of [V('match'), V('partial', ['action:connect']), V('drift'), V('unknown'), { class: 'unloaded' } as Verdict, null]) {
          expect(layoutPrecondition(t, v, cfgOf(mode)).ok).toBe(true);
        }
      }
    }
    expect(layoutPrecondition('connect_send', V('match'), cfgOf('warn'))).toEqual({ ok: true });
    expect(layoutPrecondition('connect_send', V('drift'), cfgOf('warn'))).toEqual({ ok: true, note: 'layout=drift' });
    expect(layoutPrecondition('connect_send', V('drift'), cfgOf('off'))).toEqual({ ok: true, note: 'layout=drift' });
  });

  it('enforce: match ok, drift and unknown refuse with their codes', () => {
    const c = cfgOf('enforce');
    for (const t of tools) {
      expect(layoutPrecondition(t, V('match'), c).ok).toBe(true);
      expect(layoutPrecondition(t, V('drift'), c)).toMatchObject({ ok: false, status: 'refused', code: 'layout_drift' });
      expect(layoutPrecondition(t, V('unknown'), c)).toMatchObject({ ok: false, status: 'refused', code: 'layout_unverified' });
      expect(layoutPrecondition(t, null, c)).toMatchObject({ ok: false, code: 'layout_unverified' });
    }
  });

  it('enforce: partial passes only when every needed landmark is present in the observation', () => {
    const c = cfgOf('enforce');
    // connect_send needs profile.name and action:connect
    const all = ['profile.name', 'profile.headline', 'action:connect'];
    expect(layoutPrecondition('connect_send', V('partial', ['profile.about', 'action:more']), c, all).ok).toBe(true);
    // learned and now gone: drift
    expect(layoutPrecondition('connect_send', V('partial', ['action:connect']), c, ['profile.name']))
      .toMatchObject({ ok: false, code: 'layout_drift' });
    // never learned in the variant (not in verdict.missing) and absent now: unverified
    expect(layoutPrecondition('connect_send', V('partial', ['profile.about']), c, ['profile.name']))
      .toMatchObject({ ok: false, code: 'layout_unverified' });
    // no observation landmarks to show presence: refuses
    expect(layoutPrecondition('connect_send', V('partial'), c).ok).toBe(false);
    // send_message needs profile.name and profile.message_button
    expect(layoutPrecondition('send_message', V('partial', ['action:connect']), c, ['profile.name', 'profile.message_button']).ok).toBe(true);
    expect(layoutPrecondition('send_message', V('partial', ['profile.message_button']), c, ['profile.name']).ok).toBe(false);
    expect(layoutPrecondition('accept_invite', V('partial', ['invitations.rows']), c, []).ok).toBe(false);
  });

  it('enforce: unloaded asks for a retry, blocked and logged_out are not layout refusals', () => {
    const c = cfgOf('enforce');
    const r = layoutPrecondition('connect_send', { class: 'unloaded' }, c);
    expect(r).toMatchObject({ ok: false, code: 'layout_unverified' });
    expect((r as { reason: string }).reason).toMatch(/retry/);
    expect(layoutPrecondition('connect_send', { class: 'blocked' }, c).ok).toBe(true);
    expect(layoutPrecondition('connect_send', { class: 'logged_out' }, c).ok).toBe(true);
  });

  it('check_connection_status never refuses', () => {
    const c = cfgOf('enforce');
    for (const v of [V('drift'), V('unknown'), { class: 'unloaded' } as Verdict, null]) {
      expect(layoutPrecondition('check_connection_status', v, c).ok).toBe(true);
    }
  });
});

describe('connectSend with a layout precondition', () => {
  const STATE = { cookies: [{ name: 'li_at', value: 'SENTINEL-NOT-REAL', domain: '.linkedin.com', path: '/' }], origins: [] };
  const fx = (n: string) => readFileSync(new URL(`./fixtures/linkedin/${n}`, import.meta.url), 'utf8');
  const URL_ = 'https://www.linkedin.com/in/jane-example/';
  const P = '/in/jane-example/';
  const NOTE = 'Hi Jane, I saw the platform team is hiring and would like to connect.';
  const FAST = { pendingConfirmationTimeoutMs: 1, pendingConfirmationPollMs: 1, stepTimeoutMs: 1 };
  let dir: string;
  const runtimes: Runtime[] = [];
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'li-lg-'));
    writeFileSync(path.join(dir, 'state.json'), JSON.stringify(STATE), { mode: 0o600 });
    chmodSync(path.join(dir, 'state.json'), 0o600);
  });
  afterEach(async () => {
    for (const r of runtimes.splice(0)) await r.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(verdict: Verdict, enforce: string, personName = 'Jane Example', injection = false) {
    const log: string[] = [];
    const db = openDb(':memory:');
    upsertPerson(db, { platform: 'linkedin', profileKey: profileKeyOf(URL_), name: personName, headline: 'Technical Recruiter at Acme', company: 'Acme', category: 'recruiter' });
    const dlg: Record<string, FakeElement[]> = {};
    const els: Record<string, FakeElement[]> = {
      [SELECTORS.nameHeadings]: [{ text: 'Jane Example', box: { x: 100, y: 100, height: 30 } }],
      [SELECTORS.directConnectButton]: [{
        text: 'Connect', box: { x: 100, y: 240, height: 40 }, attrs: { 'aria-label': 'Invite Jane Example to connect' },
        onClick: () => { els[SELECTORS.noteDialogContainer] = [{ text: 'Add a note to your invitation to Jane Example?', children: dlg }]; },
      }],
    };
    dlg[SELECTORS.addNoteButton] = [{ text: 'Add a note', onClick: () => { dlg[SELECTORS.noteTextarea] = [{ text: '' }]; } }];
    dlg[SELECTORS.sendButton] = [{ text: 'Send' }];
    const site: FakeSite = { pages: { [P]: { ...buildSnapshotFromHtml(fx('profile-not-connected.html'), URL_), elements: els } } };
    let seen: { kind: string; verdict: Verdict } | null = null;
    const layout: LayoutObserver = {
      observe: () => { seen = { kind: 'profile', verdict }; return verdict; },
      observeNaukri: () => verdict,
      last: () => seen,
      recordOutcome: () => undefined,
      render: () => '',
    };
    const rt = createRuntime({
      db, launcher: makeFakeLauncher(site, log), sessionPath: path.join(dir, 'state.json'),
      lockPath: path.join(dir, 'l.lock'), settleMs: 0, env: {}, layout,
    });
    runtimes.push(rt);
    const env = { LINKEDIN_DRY_RUN: 'false', SCHEDULER_DRY_RUN: 'false' };
    const deps: ToolDeps = {
      rt, db, now: () => new Date('2026-10-14T10:00:00Z'), cfg: loadLinkedinConfig(env), env,
      factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG,
      screen: async (t) => (injection
        ? { blocked: true, unscreened: false, text: t, flags: [], code: 'injection_suspected' as const }
        : { blocked: false, unscreened: false, text: t, flags: [], code: 'ok' as const }),
      layoutCfg: cfgOf(enforce),
    };
    return { deps, log, db };
  }
  const events = (db: ReturnType<typeof openDb>) =>
    (db.prepare("SELECT COUNT(*) c FROM rate_events WHERE key='linkedin_invite'").get() as { c: number }).c;
  const clicks = (log: string[]) => log.filter((l) => l.startsWith('click:') || l.startsWith('fill:'));
  const send = (deps: ToolDeps) => connectSend({ profile_url: URL_, note: NOTE, job_id: 'job-1', company: 'Acme' }, deps, FAST);

  it('enforce + drift: refused layout_drift, no click, no ceiling consumed', async () => {
    const t = setup(V('drift'), 'enforce');
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'layout_drift' });
    expect(clicks(t.log)).toEqual([]);
    expect(events(t.db)).toBe(0);
  });

  it('enforce + unknown: refused layout_unverified', async () => {
    const t = setup(V('unknown'), 'enforce');
    expect(await send(t.deps)).toMatchObject({ status: 'refused', code: 'layout_unverified' });
    expect(clicks(t.log)).toEqual([]);
  });

  it('enforce + match + wrong recipient: the existing recipient_mismatch still wins', async () => {
    const t = setup(V('match'), 'enforce', 'Someone Else');
    expect(await send(t.deps)).toMatchObject({ status: 'refused', code: 'recipient_mismatch' });
    expect(clicks(t.log)).toEqual([]);
  });

  it('enforce + drift + wrong recipient: recipient_mismatch is checked first too', async () => {
    const t = setup(V('drift'), 'enforce', 'Someone Else');
    expect(await send(t.deps)).toMatchObject({ code: 'recipient_mismatch' });
  });

  it('enforce + drift on an injection-suspect page still pauses the contact', async () => {
    const t = setup(V('drift'), 'enforce', 'Jane Example', true);
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'injection_suspected' });
    expect(personByProfileKey(t.db, profileKeyOf(URL_))?.paused_reason).toBe('injection_suspected');
    expect(clicks(t.log)).toEqual([]);
    expect(events(t.db)).toBe(0);
  });

  it('enforce + match sends', async () => {
    expect((await send(setup(V('match'), 'enforce').deps)).status).toBe('sent');
  });

  it('warn never refuses, even on drift', async () => {
    const w = setup(V('drift'), 'warn');
    expect((await send(w.deps)).status).toBe('sent');
    expect(events(w.db)).toBe(1);
  });
});
