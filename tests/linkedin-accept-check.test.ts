import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertPerson, normalizeProfileKey } from '../src/outreach/people.js';
import { dueTouchesFor } from '../src/outreach/dueTouches.js';
import { TUNING_DEFAULTS } from '../src/outreach/tuning.js';
import { haltPlatform } from '../src/outreach/limits.js';
import {
  ACCEPT_CHECK_MAX_PER_WAKE, checkNextAccepted, countAcceptCandidates, decideAccepted, listAcceptCandidates,
  markConnectionAccepted, stampAcceptChecked, type AcceptDeps, type AcceptIo,
} from '../src/linkedin/acceptCheck.js';
import { countDue } from '../src/scheduler/due.js';
import { planWake, stepOrder, type PlanKnobs } from '../src/scheduler/plan.js';
import type { CeilingStatus, LimitKey } from '../src/outreach/limits.js';
import type { ControlState } from '../src/scheduler/control.js';
import type { QuietConfig } from '../src/outreach/quiet.js';
import { buildHandlers } from '../src/mcp/linkedin.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import type { Runtime } from '../src/linkedin/runtime.js';
import type { RawProfile, RawSnapshot } from '../src/linkedin/types.js';

const NOW = new Date('2026-10-15T08:00:00.000Z');
const DAY = 24 * 3600 * 1000;
const iso = (agoDays: number): string => new Date(NOW.getTime() - agoDays * DAY).toISOString();
const LIVE = { JOBBER_DRY_RUN: 'false' } as NodeJS.ProcessEnv;
const DRY = { JOBBER_DRY_RUN: 'true' } as NodeJS.ProcessEnv;
const url = (slug: string): string => `https://www.linkedin.com/in/${slug}/`;

type Db = ReturnType<typeof openDb>;
const sent = (db: Db, slug: string, agoDays = 2, checked: string | null = null, profileUrl = url(slug)): void => {
  db.prepare("INSERT INTO connections (profile_url, status, sent_at, accept_checked_at) VALUES (?, 'sent', ?, ?)").run(profileUrl, iso(agoDays), checked);
};
const statusOf = (db: Db, slug: string): string[] =>
  (db.prepare('SELECT status FROM connections WHERE profile_url = ? ORDER BY id').all(url(slug)) as { status: string }[]).map((r) => r.status);

const profile = (o: Partial<RawProfile> = {}): RawProfile => ({
  name: 'Jane Example', headline: 'Recruiter', degree: '1st', location: 'Pune', about: null,
  actions: ['Message', 'More'], pending: false, hasBell: false, hasMessageButton: true, ...o,
});
const snap = (slug: string, p: RawProfile | null): RawSnapshot => ({ url: url(slug), title: 'x', profile: p } as unknown as RawSnapshot);

function world(env: NodeJS.ProcessEnv = LIVE, pages: Record<string, RawProfile | null> = {}) {
  const db = openDb(':memory:');
  const opened: string[] = [];
  const sleeps: number[] = [];
  const io: AcceptIo = {
    open: async (u) => {
      opened.push(u);
      const slug = /\/in\/([^/]+)/.exec(u)![1]!;
      return slug in pages ? { ok: true, snapshot: snap(slug, pages[slug]!) } : { ok: false, code: 'navigation' };
    },
  };
  const state = { tried: new Set<string>(), checked: 0 };
  const deps: AcceptDeps = { db, env, now: () => NOW, state, sleep: async (ms) => { sleeps.push(ms); }, random: () => 0.5 };
  return { db, io, deps, opened, sleeps, state };
}

describe('decideAccepted (fail closed)', () => {
  it('first degree with Message and no Connect is accepted', () => {
    expect(decideAccepted(profile())).toMatchObject({ status: 'accepted' });
  });
  it('Pending or Withdraw is still pending', () => {
    expect(decideAccepted(profile({ degree: '2nd', pending: true, actions: ['Pending', 'More'], hasMessageButton: false }))).toMatchObject({ status: 'pending' });
  });
  it('Connect available again means not accepted, even with a bell', () => {
    expect(decideAccepted(profile({ degree: '3rd', actions: ['Connect', 'Follow'], hasBell: true, hasMessageButton: false }))).toMatchObject({ status: 'not_accepted', code: 'connect_available' });
  });
  it('1st degree without a Message button or an unreadable degree is unclear', () => {
    expect(decideAccepted(profile({ actions: ['More'], hasMessageButton: false })).status).toBe('unclear');
    expect(decideAccepted(profile({ degree: null, actions: ['Message'], hasBell: true })).status).toBe('unclear');
    expect(decideAccepted(profile({ actions: [], hasMessageButton: true })).status).toBe('unclear');
  });
});

describe('connections setter and candidates', () => {
  it('markConnectionAccepted flips every sent row of the normalized URL, is idempotent and never downgrades messaged', () => {
    const db = openDb(':memory:');
    sent(db, 'a');
    sent(db, 'a', 3, null, 'https://in.linkedin.com/in/A/?trk=x');
    db.prepare("INSERT INTO connections (profile_url, status, sent_at) VALUES (?, 'messaged', ?)").run(url('m'), iso(1));
    sent(db, 'b');
    expect(markConnectionAccepted(db, url('a'), NOW)).toBe(2);
    expect(markConnectionAccepted(db, url('a'), NOW)).toBe(0);
    expect(markConnectionAccepted(db, url('m'), NOW)).toBe(0);
    expect(statusOf(db, 'm')).toEqual(['messaged']);
    expect(statusOf(db, 'b')).toEqual(['sent']);
    expect((db.prepare("SELECT COUNT(*) AS n FROM connections WHERE status = 'connected'").get() as { n: number }).n).toBe(2);
  });
  it('picks never-checked first, then oldest check; honours the 20 h recheck gap and the 21 day window', () => {
    const db = openDb(':memory:');
    sent(db, 'old-check', 5, iso(3));
    sent(db, 'fresh-check', 5, new Date(NOW.getTime() - 3 * 3600 * 1000).toISOString());
    sent(db, 'never', 4);
    sent(db, 'older-check', 5, iso(6));
    sent(db, 'too-old', 22);
    expect(listAcceptCandidates(db, NOW).map((c) => c.key)).toEqual([
      'linkedin.com/in/never', 'linkedin.com/in/older-check', 'linkedin.com/in/old-check',
    ]);
    expect(countAcceptCandidates(db, NOW)).toBe(3);
  });
  it('skips a profile that already has a messaged or connected row and caps the count at 8', () => {
    const db = openDb(':memory:');
    sent(db, 'x');
    db.prepare("INSERT INTO connections (profile_url, status, sent_at) VALUES (?, 'connected', ?)").run(url('x'), iso(1));
    for (let i = 0; i < 12; i++) sent(db, `p${i}`);
    expect(listAcceptCandidates(db, NOW)).toHaveLength(12);
    expect(countAcceptCandidates(db, NOW)).toBe(ACCEPT_CHECK_MAX_PER_WAKE);
  });
  it('stampAcceptChecked only touches sent rows and the migration column exists', () => {
    const db = openDb(':memory:');
    sent(db, 'a');
    stampAcceptChecked(db, url('a'), NOW);
    expect((db.prepare('SELECT accept_checked_at AS t FROM connections').get() as { t: string }).t).toBe(NOW.toISOString());
  });
});

describe('checkNextAccepted', () => {
  it('marks an accepted invite connected, leaves pending and not_accepted rows, stamps all of them', async () => {
    const w = world(LIVE, {
      acc: profile(),
      pen: profile({ degree: '2nd', pending: true, actions: ['Pending'], hasMessageButton: false }),
      again: profile({ degree: '3rd', actions: ['Connect'], hasMessageButton: false }),
    });
    sent(w.db, 'acc', 4); sent(w.db, 'pen', 3); sent(w.db, 'again', 2);
    const r1 = await checkNextAccepted(w.io, w.deps);
    const r2 = await checkNextAccepted(w.io, w.deps);
    const r3 = await checkNextAccepted(w.io, w.deps);
    expect([r1.status, r2.status, r3.status]).toEqual(['accepted', 'pending', 'not_accepted']);
    expect(r3.remaining).toBe(0);
    expect(statusOf(w.db, 'acc')).toEqual(['connected']);
    expect(statusOf(w.db, 'pen')).toEqual(['sent']);
    expect(statusOf(w.db, 'again')).toEqual(['sent']);
    expect((await checkNextAccepted(w.io, w.deps)).status).toBe('none');
    // paced 3 to 8 s between profiles, none before the first
    expect(w.sleeps).toHaveLength(2);
    for (const s of w.sleeps) { expect(s).toBeGreaterThanOrEqual(3000); expect(s).toBeLessThanOrEqual(8000); }
    // a second pass in the same period re-checks nothing (20 h gap)
    expect(listAcceptCandidates(w.db, NOW)).toEqual([]);
  });
  it('a failed open changes nothing but is not picked again in the same wake', async () => {
    const w = world(LIVE, {});
    sent(w.db, 'gone');
    const r = await checkNextAccepted(w.io, w.deps);
    expect(r).toMatchObject({ status: 'failed', code: 'navigation' });
    expect(statusOf(w.db, 'gone')).toEqual(['sent']);
    expect((await checkNextAccepted(w.io, w.deps)).status).toBe('none');
  });
  it('an unreadable page or a different profile URL is no change', async () => {
    const w = world(LIVE, { a: null });
    sent(w.db, 'a');
    expect((await checkNextAccepted(w.io, w.deps)).status).toBe('unclear');
    const w2 = world(LIVE, {});
    sent(w2.db, 'b');
    w2.io.open = async () => ({ ok: true, snapshot: snap('someone-else', profile()) });
    expect(await checkNextAccepted(w2.io, w2.deps)).toMatchObject({ status: 'failed', code: 'profile_url_mismatch' });
    expect(statusOf(w2.db, 'b')).toEqual(['sent']);
  });
  it('dry run opens nothing, writes nothing and records the dry-run action', async () => {
    const w = world(DRY, { a: profile() });
    sent(w.db, 'a');
    expect((await checkNextAccepted(w.io, w.deps)).status).toBe('dry_run');
    expect(w.opened).toEqual([]);
    expect(statusOf(w.db, 'a')).toEqual(['sent']);
    expect((w.db.prepare("SELECT COUNT(*) AS n FROM dry_run_actions WHERE action = 'linkedin_check_accepted'").get() as { n: number }).n).toBe(1);
  });
  it('a halt or the kill switch stops it before any page is opened', async () => {
    const w = world(LIVE, { a: profile() });
    sent(w.db, 'a');
    haltPlatform(w.db, 'linkedin', 'test', NOW);
    expect((await checkNextAccepted(w.io, w.deps)).status).toBe('halted');
    const w2 = world(LIVE, { a: profile() });
    sent(w2.db, 'a');
    expect((await checkNextAccepted(w2.io, { ...w2.deps, killed: () => 'kill switch: STOP file' })).status).toBe('halted');
    expect(w.opened.concat(w2.opened)).toEqual([]);
  });
  it('stops at 8 checks per wake', async () => {
    const pages: Record<string, RawProfile> = {};
    for (let i = 0; i < 10; i++) pages[`p${i}`] = profile({ degree: '2nd', pending: true, actions: ['Pending'], hasMessageButton: false });
    const w = world(LIVE, pages);
    for (let i = 0; i < 10; i++) sent(w.db, `p${i}`);
    for (let i = 0; i < 8; i++) expect((await checkNextAccepted(w.io, w.deps)).status).toBe('pending');
    expect((await checkNextAccepted(w.io, w.deps)).status).toBe('rate_limited');
    expect(w.opened).toHaveLength(8);
  });
});

describe('due-touch hookup', () => {
  it('a person with a sent connect touch and a sent connections row becomes due for role_ask once marked connected', () => {
    const db = openDb(':memory:');
    const slug = 'jane-example';
    // people.profile_key is the normalized key; connections.profile_url is the full URL of the invite
    const id = upsertPerson(db, { platform: 'linkedin', profileKey: normalizeProfileKey(url(slug)), company: 'Acme', category: 'recruiter' });
    db.prepare("UPDATE contact_state SET stage = 'active', cycle_started_at = ? WHERE person_id = ?").run(iso(30), id);
    db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status, sent_at) VALUES (?, 'connect', 'k1', 'sent', ?)").run(id, iso(5));
    sent(db, slug, 5);
    expect(dueTouchesFor(db, NOW, TUNING_DEFAULTS)).toHaveLength(0); // an invite alone proves nothing
    expect(markConnectionAccepted(db, url(slug), NOW)).toBe(1);
    const due = dueTouchesFor(db, NOW, TUNING_DEFAULTS);
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ person_id: id, platform: 'linkedin', kind: 'role_ask' });
  });
  it('a peer is due for rapport', () => {
    const db = openDb(':memory:');
    const id = upsertPerson(db, { platform: 'linkedin', profileKey: normalizeProfileKey('https://linkedin.com/in/Pat%2DPeer'), company: 'Acme', category: 'peer' });
    db.prepare("UPDATE contact_state SET stage = 'active', cycle_started_at = ?, variant = 'rapport_first' WHERE person_id = ?").run(iso(30), id);
    db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status, sent_at) VALUES (?, 'connect', 'k2', 'sent', ?)").run(id, iso(5));
    sent(db, 'x', 5, null, 'https://www.linkedin.com/in/pat-peer/?miniProfileUrn=abc');
    markConnectionAccepted(db, 'https://www.linkedin.com/in/pat-peer/', NOW);
    expect(dueTouchesFor(db, NOW, TUNING_DEFAULTS)[0]).toMatchObject({ person_id: id, kind: 'rapport' });
  });
});

const quiet: QuietConfig = { quietStartHour: 23, quietEndHour: 7, tzOffsetMinutes: 330 };
const knobs: PlanKnobs = { inboxEveryMin: 60, naukriDiscoverEveryHours: 6 };
const ctl = (): ControlState => ({ killed: false, killReason: null, halted: { linkedin: null, naukri: null, wellfound: null }, allowed: ['linkedin', 'naukri'], readError: null });
const ceil = (bad: LimitKey[] = []): Record<LimitKey, CeilingStatus> =>
  Object.fromEntries(
    (['linkedin_invite', 'linkedin_message', 'naukri_apply', 'naukri_message', 'apply_attempt'] as LimitKey[]).map((k) => [k, bad.includes(k) ? { used: 5, limit: 5, ok: false } : { used: 0, limit: 5, ok: true }]),
  ) as Record<LimitKey, CeilingStatus>;

describe('planner', () => {
  it('countDue reports the eligible invites (at most 8)', () => {
    const db = openDb(':memory:');
    for (let i = 0; i < 11; i++) sent(db, `p${i}`);
    expect(countDue(db, NOW, TUNING_DEFAULTS, {}).acceptCheckDue).toBe(8);
  });
  it('plans a LinkedIn accept_check before the followups step and pulls followups in; nothing else is due', () => {
    const db = openDb(':memory:');
    sent(db, 'a');
    const due = countDue(db, NOW, TUNING_DEFAULTS, {});
    const d = planWake({ now: NOW, quiet, control: ctl(), ceilings: ceil(), due: { ...due, inboxLastCheckedMinAgo: 5, naukriSearchLastHoursAgo: 1 }, knobs });
    expect(d.kind).toBe('run');
    if (d.kind !== 'run') return;
    const order = stepOrder(d);
    const kinds = order.map((s) => `${s.platform}:${s.kind}`);
    expect(kinds).toContain('linkedin:accept_check');
    expect(order.find((s) => s.kind === 'accept_check')).toMatchObject({ operator: 'linkedin-operator', quota: 1 });
    expect(kinds.indexOf('linkedin:accept_check')).toBeLessThan(kinds.indexOf('linkedin:followups'));
  });
  it('plans no accept_check when LinkedIn is halted or nothing is eligible', () => {
    const db = openDb(':memory:');
    sent(db, 'a');
    const due = { ...countDue(db, NOW, TUNING_DEFAULTS, {}), inboxLastCheckedMinAgo: 5, naukriSearchLastHoursAgo: 1 };
    const halted: ControlState = { ...ctl(), allowed: ['naukri'], halted: { linkedin: 'x', naukri: null, wellfound: null } };
    const d1 = planWake({ now: NOW, quiet, control: halted, ceilings: ceil(), due, knobs });
    expect(JSON.stringify(d1)).not.toContain('accept_check');
    const d2 = planWake({ now: NOW, quiet, control: ctl(), ceilings: ceil(), due: { ...due, acceptCheckDue: 0 }, knobs });
    expect(d2).toMatchObject({ kind: 'skip', reason: 'nothing_due' });
  });
});

describe('linkedin_check_accepted MCP handler', () => {
  it('takes no input, marks the accepted invite and returns no page text', async () => {
    const db = openDb(':memory:');
    sent(db, 'jane');
    const opened: string[] = [];
    const rt = {
      open: async (u: string) => { opened.push(u); return { ok: true, snapshot: snap('jane', profile()) }; },
      touch: () => undefined, page: () => null, close: async () => true, layout: undefined,
    } as unknown as Runtime;
    const h = buildHandlers({
      db, rt, env: LIVE, now: () => NOW, factCheck: (t: string) => ({ verdict: 'pass' as const, normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG,
      acceptTuning: { sleep: async () => undefined, random: () => 0 },
    });
    const out = JSON.parse((await h.linkedin_check_accepted({})) as string);
    expect(out).toEqual({ status: 'accepted', code: 'first_degree', remaining: 0 });
    expect(opened).toEqual([url('jane')]);
    expect(statusOf(db, 'jane')).toEqual(['connected']);
    expect(JSON.parse((await h.linkedin_check_accepted({})) as string).status).toBe('none');
  });
});
