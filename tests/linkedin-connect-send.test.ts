import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { haltPlatform, haltReason, recordEvent } from '../src/outreach/limits.js';
import { createRuntime, type Runtime } from '../src/linkedin/runtime.js';
import { buildSnapshotFromHtml } from '../src/linkedin/snapshot.js';
import { loadLinkedinConfig } from '../src/linkedin/config.js';
import { SELECTORS } from '../src/linkedin/selectors.js';
import { profileKeyOf } from '../src/linkedin/urls.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { connectSend } from '../src/linkedin/connectSend.js';
import type { ToolDeps } from '../src/linkedin/toolDeps.js';
import { makeFakeLauncher, type FakeElement, type FakeSite } from './helpers/fakeLinkedin.js';

const STATE = { cookies: [{ name: 'li_at', value: 'SENTINEL-NOT-REAL', domain: '.linkedin.com', path: '/' }], origins: [] };
const fx = (n: string) => readFileSync(new URL(`./fixtures/linkedin/${n}`, import.meta.url), 'utf8');
const URL_ = 'https://www.linkedin.com/in/jane-example/';
const P = '/in/jane-example/';
const NOTE = 'Hi Jane, I saw the platform team is hiring and would like to connect.';
const NOW = new Date('2026-10-14T10:00:00Z'); // 15:30 IST
const FAST = { pendingConfirmationTimeoutMs: 1, pendingConfirmationPollMs: 1, stepTimeoutMs: 1 };
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

type Els = Record<string, FakeElement[]>;
const snapOf = (name = 'profile-not-connected.html') => buildSnapshotFromHtml(fx(name), URL_);

interface Opts {
  dialogText?: string;
  noNote?: boolean;
  viaMore?: boolean;
  pendingOnSend?: boolean;
  env?: NodeJS.ProcessEnv;
  snap?: ReturnType<typeof snapOf>;
  site?: Partial<FakeSite>;
  seed?: boolean;
}

function setup(o: Opts = {}) {
  const log: string[] = [];
  const db = openDb(':memory:');
  if (o.seed !== false) {
    upsertPerson(db, { platform: 'linkedin', profileKey: profileKeyOf(URL_), name: 'Jane Example', company: 'Acme', category: 'recruiter' });
  }
  const els: Els = {
    [SELECTORS.nameHeadings]: [{ text: 'Jane Example', box: { x: 100, y: 100, height: 30 } }],
  };
  let eventsAtSend = -1;
  const dlg: Els = {};
  const openDialog = () => {
    els[SELECTORS.noteDialogContainer] = [{ text: o.dialogText ?? 'Add a note to your invitation to Jane Example? Personalize it.', children: dlg }];
    dlg[SELECTORS.addNoteButton] = [{
      text: 'Add a note',
      onClick: () => { if (!o.noNote) dlg[SELECTORS.noteTextarea] = [{ text: '' }]; },
    }];
    dlg[SELECTORS.sendButton] = [{
      text: 'Send',
      onClick: () => {
        eventsAtSend = (db.prepare("SELECT COUNT(*) c FROM rate_events WHERE key='linkedin_invite'").get() as { c: number }).c;
        if (o.pendingOnSend) els[SELECTORS.pendingButton] = [{ text: 'Pending', box: { x: 100, y: 240, height: 40 } }];
      },
    }];
  };
  if (o.viaMore) {
    els[SELECTORS.moreButton] = [{ text: 'More', box: { x: 300, y: 240, height: 48 }, onClick: () => {
      els[SELECTORS.connectMenuItem] = [{ text: 'Connect', onClick: openDialog }];
    } }];
  } else {
    els[SELECTORS.directConnectButton] = [{ text: 'Connect', box: { x: 100, y: 240, height: 40 }, attrs: { 'aria-label': 'Invite Jane Example to connect' }, onClick: openDialog }];
  }
  const site: FakeSite = {
    pages: { [P]: { ...(o.snap ?? snapOf()), elements: els } },
    ...o.site,
  };
  const launcher = makeFakeLauncher(site, log);
  const rt = createRuntime({
    db, launcher, sessionPath: path.join(dir, 'state.json'), lockPath: path.join(dir, 'l.lock'), settleMs: 0, env: {},
  });
  runtimes.push(rt);
  const env = { LINKEDIN_DRY_RUN: 'false', ...o.env };
  const deps: ToolDeps = {
    rt, db, now: () => NOW, cfg: loadLinkedinConfig(env), env,
    factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG,
  };
  return { deps, log, db, els, dlg, launcher, site, eventsAtSend: () => eventsAtSend };
}

const send = (deps: ToolDeps, over: Partial<Parameters<typeof connectSend>[0]> = {}) =>
  connectSend({ profile_url: URL_, note: NOTE, job_id: 'job-1', company: 'Acme', ...over }, deps, FAST);
const sendClicks = (log: string[]) => log.filter((l) => l.startsWith(`click:${SELECTORS.sendButton}`));
const events = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT COUNT(*) c FROM rate_events WHERE key='linkedin_invite'").get() as { c: number }).c;
const touchStatus = (db: ReturnType<typeof openDb>) =>
  (db.prepare('SELECT status FROM touches ORDER BY id DESC LIMIT 1').get() as { status: string } | undefined)?.status;

describe('connectSend', () => {
  it('happy path: order, one rate event, sent touch, legacy connection row', async () => {
    const t = setup();
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'sent', code: 'sent' });
    const clicks = t.log.filter((l) => l.startsWith('click:') || l.startsWith('fill:') || l.startsWith('goto:'));
    expect(clicks).toEqual([
      `goto:${P}`,
      `click:${SELECTORS.directConnectButton}:Connect`,
      `click:${SELECTORS.addNoteButton}:Add a note`,
      `fill:${SELECTORS.noteTextarea}`,
      `click:${SELECTORS.sendButton}:Send`,
    ]);
    expect(t.eventsAtSend()).toBe(1); // consumed before the Send click
    expect(events(t.db)).toBe(1);
    expect(touchStatus(t.db)).toBe('sent');
    const c = t.db.prepare('SELECT status, note, profile_url FROM connections').get() as any;
    expect(c).toMatchObject({ status: 'sent', note: NOTE, profile_url: URL_ });
  });

  it('confirms via the Pending control when no response is seen', async () => {
    const t = setup({ site: { noResponse: true }, pendingOnSend: true });
    expect((await send(t.deps)).status).toBe('sent');
  });

  it('More menu path with an exact Connect item sends', async () => {
    const t = setup({ viaMore: true });
    expect((await send(t.deps)).status).toBe('sent');
    expect(t.log.some((l) => l.startsWith(`click:${SELECTORS.moreButton}`))).toBe(true);
  });

  it('default config is dry run: no click, no rate event, dry_run touch', async () => {
    const t = setup({ env: { LINKEDIN_DRY_RUN: undefined } });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'dry_run', code: 'dry_run', would_send: { kind: 'connect', chars: NOTE.length, recipient: profileKeyOf(URL_) } });
    expect(t.log.filter((l) => l.startsWith('click:') || l.startsWith('fill:'))).toEqual([]);
    expect(events(t.db)).toBe(0);
    expect(touchStatus(t.db)).toBe('dry_run');
  });

  it('per-call dry_run with env off is also dry and never opens the menu', async () => {
    const t = setup({ viaMore: true });
    const r = await send(t.deps, { dry_run: true });
    expect(r.status).toBe('dry_run');
    expect(t.log.filter((l) => l.startsWith('click:'))).toEqual([]);
    expect(events(t.db)).toBe(0);
  });

  it('identical second call after sent -> already_sent, nothing new', async () => {
    const t = setup();
    await send(t.deps);
    const before = t.log.length;
    const r = await send(t.deps);
    expect(r.status).toBe('already_sent');
    expect(t.log.length).toBe(before);
    expect(events(t.db)).toBe(1);
  });

  it('dialog addressing someone else -> refused, Escape, no Send click, no event', async () => {
    const t = setup({ dialogText: 'Add a note to your invitation to Someone Else?' });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'dialog_recipient_mismatch' });
    expect(sendClicks(t.log)).toEqual([]);
    expect(t.log).toContain('press:Escape');
    expect(events(t.db)).toBe(0);
    expect(touchStatus(t.db)).toBe('refused');
  });

  it('dialog with no extractable name -> dialog_name_unverified', async () => {
    const t = setup({ dialogText: 'Add a note?' });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'dialog_name_unverified' });
    expect(sendClicks(t.log)).toEqual([]);
    expect(t.log).toContain('press:Escape');
    expect(events(t.db)).toBe(0);
  });

  it('page redirected to another slug -> profile_url_mismatch, no click', async () => {
    const t = setup({ site: { redirects: { [P]: 'https://www.linkedin.com/in/other-person/' } } });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'failed', code: 'profile_url_mismatch' });
    expect(t.log.filter((l) => l.startsWith('click:'))).toEqual([]);
  });

  it('Remove connection incident: no exact Connect -> failed, that item never clicked', async () => {
    const t = setup({ viaMore: true });
    // Replace the Connect item with a menu that only has "Remove connection" under another selector.
    t.els[SELECTORS.moreButton][0].onClick = () => {
      t.els['[role="menu"] [role="menuitem"]'] = [{ text: 'Remove connection', onClick: () => t.log.push('REMOVED') }];
    };
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'failed', code: 'connect_menu_item_missing' });
    expect(t.log.some((l) => /Remove/.test(l))).toBe(false);
    expect(sendClicks(t.log)).toEqual([]);
    expect(events(t.db)).toBe(0);
  });

  it('missing note field -> failed/note_field_missing, never sends', async () => {
    const t = setup({ noNote: true });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'failed', code: 'note_field_missing' });
    expect(sendClicks(t.log)).toEqual([]);
    expect(events(t.db)).toBe(0);
  });

  it('ceiling exhausted -> rate_limited with "N of M", no Send click', async () => {
    const t = setup({ env: { LINKEDIN_MAX_INVITES_PER_WEEK: '2' } });
    recordEvent(t.db, 'linkedin_invite', NOW);
    recordEvent(t.db, 'linkedin_invite', NOW);
    const r = await send(t.deps);
    expect(r.status).toBe('rate_limited');
    expect(r.reason).toBe('2 of 2 this week');
    expect(sendClicks(t.log)).toEqual([]);
    expect(t.log).toContain('press:Escape');
    expect(events(t.db)).toBe(2);
    expect(touchStatus(t.db)).toBe('refused');
  });

  it('hidden-only injection fixture does not leak: visible profile still sends in dry run', async () => {
    const t = setup({ snap: snapOf('profile-injection.html'), site: undefined });
    const r = await send(t.deps, { dry_run: true });
    expect(r.status).toBe('dry_run');
  });

  it('visible injection phrase in About (fixture) -> injection_suspected, contact paused, nothing sent', async () => {
    const t = setup({ snap: snapOf('profile-injection-visible.html') });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'injection_suspected' });
    const row = t.db.prepare('SELECT paused_reason FROM contact_state').get() as { paused_reason: string };
    expect(row.paused_reason).toBe('injection_suspected');
    expect(t.log.filter((l) => l.startsWith('click:'))).toEqual([]);
    expect(events(t.db)).toBe(0);
    expect(touchStatus(t.db)).toBe('refused');
  });

  it('non-matching heading + suggested-people Connect -> name_position_unknown, no click', async () => {
    const t = setup();
    t.els[SELECTORS.nameHeadings] = [{ text: 'Totally Different', box: { x: 100, y: 100, height: 30 } }];
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'failed', code: 'name_position_unknown' });
    expect(t.log.filter((l) => l.startsWith('click:'))).toEqual([]);
    expect(events(t.db)).toBe(0);
  });

  it('chosen Connect names someone else -> connect_target_mismatch, no click', async () => {
    const t = setup();
    t.els[SELECTORS.directConnectButton][0].attrs = { 'aria-label': 'Invite Bob Other to connect' };
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'failed', code: 'connect_target_mismatch' });
    expect(t.log.filter((l) => l.startsWith('click:'))).toEqual([]);
  });

  it('title with pronouns still works via the person-name fallback', async () => {
    const snap = snapOf();
    snap.title = 'Jane Example (She/Her) | LinkedIn';
    const t = setup({ snap });
    expect((await send(t.deps)).status).toBe('sent');
  });

  it('normalized heading with credentials and pronouns matches', async () => {
    const t = setup();
    t.els[SELECTORS.nameHeadings] = [{ text: 'Jane  Example (She/Her), MBA', box: { x: 100, y: 100, height: 30 } }];
    expect((await send(t.deps)).status).toBe('sent');
  });

  it('checkpoint on the reload after Send -> unconfirmed, halt set, no further goto', async () => {
    const t = setup({ site: { noResponse: true } });
    t.site.pages['/checkpoint/challenge/abc'] = buildSnapshotFromHtml(fx('checkpoint.html'), 'https://www.linkedin.com/checkpoint/challenge/abc');
    const open0 = t.els[SELECTORS.directConnectButton][0].onClick!;
    t.els[SELECTORS.directConnectButton][0].onClick = () => {
      open0();
      const sb = t.dlg[SELECTORS.sendButton][0];
      const orig = sb.onClick!;
      sb.onClick = () => { orig(); t.site.redirects = { [P]: 'https://www.linkedin.com/checkpoint/challenge/abc' }; };
    };
    const r = await send(t.deps);
    expect(r.status).toBe('unconfirmed');
    expect(haltReason(t.db, 'linkedin')).not.toBeNull();
    expect(t.log.filter((l) => l.startsWith('goto:')).length).toBe(2);
    expect(events(t.db)).toBe(1);
  });

  it('restriction notice in place of the dialog -> halted, no Send click', async () => {
    const t = setup();
    const open0 = t.els[SELECTORS.directConnectButton][0].onClick!;
    t.els[SELECTORS.directConnectButton][0].onClick = () => {
      open0();
      (t.site.pages[P] as any).notices = ['Your account has been temporarily restricted'];
    };
    const r = await send(t.deps);
    expect(r.status).toBe('halted');
    expect(sendClicks(t.log)).toEqual([]);
    expect(haltReason(t.db, 'linkedin')).not.toBeNull();
    expect(events(t.db)).toBe(0);
  });

  it('page changes between open() and the action block (profile becomes pending) -> refused, no click', async () => {
    const t = setup();
    const base = t.site.pages[P] as any;
    const profile = base.profile;
    let reads = 0;
    const def: any = { ...base };
    delete def.profile;
    Object.defineProperty(def, 'profile', {
      enumerable: true,
      get: () => (++reads >= 2 ? { ...profile, pending: true } : profile),
    });
    t.site.pages[P] = def;
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'already_pending' });
    expect(t.log.filter((l) => l.startsWith('click:'))).toEqual([]);
  });

  it('no name position later: confirmation only by response, never the .first() pending', async () => {
    const t = setup({ site: { noResponse: true }, pendingOnSend: true });
    const open0 = t.els[SELECTORS.directConnectButton][0].onClick!;
    t.els[SELECTORS.directConnectButton][0].onClick = () => {
      open0();
      t.els[SELECTORS.nameHeadings] = [{ text: 'Other', box: { x: 0, y: 0, height: 10 } }];
    };
    const r = await send(t.deps);
    expect(r.status).toBe('unconfirmed');
  });

  it('a page-level Send button outside the dialog is never clicked', async () => {
    const t = setup({ noNote: true });
    t.els[SELECTORS.sendButton] = [{ text: 'Send', onClick: () => t.log.push('PAGE_SEND') }];
    t.els[SELECTORS.noteTextarea] = [{ text: '' }];
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'failed', code: 'note_field_missing' });
    expect(t.log).not.toContain('PAGE_SEND');
    expect(sendClicks(t.log)).toEqual([]);
    expect(events(t.db)).toBe(0);
  });

  it('Send clicked, no confirmation -> unconfirmed, event kept, repeat is never re-sent', async () => {
    const t = setup({ site: { noResponse: true } });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'unconfirmed', code: 'unconfirmed' });
    expect(touchStatus(t.db)).toBe('unconfirmed');
    expect(events(t.db)).toBe(1);
    const again = await send(t.deps);
    expect(again).toMatchObject({ status: 'refused', code: 'in_progress' });
    expect(sendClicks(t.log).length).toBe(1);
    expect(events(t.db)).toBe(1);
  });

  it('halted flag set beforehand -> halted, no launch', async () => {
    const t = setup();
    haltPlatform(t.db, 'linkedin', 'captcha', NOW);
    const r = await send(t.deps);
    expect(r.status).toBe('halted');
    expect(t.launcher.launches).toBe(0);
    expect(t.log).toEqual([]);
  });

  it('unknown recipient -> refused before any page work', async () => {
    const t = setup({ seed: false });
    const r = await send(t.deps);
    expect(r).toMatchObject({ status: 'refused', code: 'unknown_recipient' });
    expect(t.launcher.launches).toBe(0);
  });
});
