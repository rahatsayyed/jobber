import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { TUNING_DEFAULTS } from '../src/outreach/tuning.js';
import { setState } from '../src/scheduler/runLog.js';
import { countDue, type DueCounts } from '../src/scheduler/due.js';
import { planWake, loadPlanKnobs, type PlanKnobs } from '../src/scheduler/plan.js';
import type { PacingConfig } from '../src/outreach/pacing.js';
import type { ControlState } from '../src/scheduler/control.js';
import type { CeilingStatus, LimitKey } from '../src/outreach/limits.js';

const NOW = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST
const QUIET = new Date('2026-10-14T21:00:00.000Z'); // 02:30 IST

const pacing: PacingConfig = {
  quietStartHour: 23, quietEndHour: 7, tzOffsetMinutes: 330,
  minBurst: 1, maxBurst: 4, minActionGapSec: 120, maxActionGapSec: 360,
  minWaitMin: 8, maxWaitMin: 40, jitter: 0.25,
};
const knobs: PlanKnobs = { inboxEveryMin: 60, naukriSearchEveryHours: 6 };
const ctl = (o: Partial<ControlState> = {}): ControlState => ({
  killed: false, killReason: null, halted: { linkedin: null, naukri: null },
  allowed: ['linkedin', 'naukri'], readError: null, ...o,
});
const ceil = (bad: LimitKey[] = []): Record<LimitKey, CeilingStatus> => {
  const keys: LimitKey[] = ['linkedin_invite', 'linkedin_message', 'naukri_apply', 'naukri_message'];
  return Object.fromEntries(
    keys.map((k) => [k, bad.includes(k) ? { used: 5, limit: 5, ok: false } : { used: 0, limit: 5, ok: true }]),
  ) as Record<LimitKey, CeilingStatus>;
};
const due = (o: Partial<DueCounts> = {}): DueCounts => ({
  followupsDue: 0, newOutreachReady: 0, inboxLastCheckedMinAgo: 5, naukriSearchLastHoursAgo: 1, ...o,
});
function counted(value: number) {
  let n = 0;
  const rng = () => { n++; return value; };
  return { rng, calls: () => n };
}
const plan = (o: Partial<Parameters<typeof planWake>[0]> = {}, rngValue = 0.99) => {
  const r = counted(rngValue);
  const d = planWake({ now: NOW, rng: r.rng, pacing, control: ctl(), ceilings: ceil(), due: due(), knobs, ...o });
  return { d, calls: r.calls() };
};

describe('planWake', () => {
  it('skips killed with zero rng draws', () => {
    const { d, calls } = plan({ control: ctl({ killed: true, killReason: 'STOP' }) });
    expect(d).toMatchObject({ kind: 'skip', reason: 'killed' });
    expect(calls).toBe(0);
  });
  it('skips halted when both platforms halted', () => {
    const { d, calls } = plan({
      control: ctl({ allowed: [], halted: { linkedin: 'a', naukri: 'b' } }),
    });
    expect(d).toMatchObject({ kind: 'skip', reason: 'halted' });
    expect(calls).toBe(0);
  });
  it('skips quiet hours (02:30 IST)', () => {
    const { d, calls } = plan({ now: QUIET });
    expect(d).toMatchObject({ kind: 'skip', reason: 'quiet_hours' });
    expect(calls).toBe(0);
  });
  it('never assigns more than the burst in total and draws rng once', () => {
    // rng 0.0 -> burst 1; 0.99 -> burst 4
    for (const v of [0, 0.5, 0.99]) {
      const { d, calls } = plan({ due: due({ followupsDue: 10, newOutreachReady: 10 }) }, v);
      expect(calls).toBe(1);
      if (d.kind !== 'run') throw new Error('expected run');
      const spent = d.tasks
        .filter((t) => t.worker === 'due-followups' || t.worker === 'new-outreach')
        .reduce((s, t) => s + t.quota, 0);
      expect(spent).toBeLessThanOrEqual(d.burst);
      expect(spent).toBe(d.burst);
    }
  });
  it('orders tasks inbox, followups, new-outreach, naukri-search', () => {
    const { d } = plan({
      due: due({ followupsDue: 1, newOutreachReady: 1, inboxLastCheckedMinAgo: null, naukriSearchLastHoursAgo: null }),
    });
    if (d.kind !== 'run') throw new Error('expected run');
    expect(d.tasks.map((t) => t.worker)).toEqual([
      'inbox-recruiter-replies', 'due-followups', 'new-outreach', 'naukri-search',
    ]);
  });
  it('assigns inbox when never checked or 61 min ago, not at 30', () => {
    const has = (v: number | null) => {
      const { d } = plan({ due: due({ inboxLastCheckedMinAgo: v, followupsDue: 1 }) });
      return d.kind === 'run' && d.tasks.some((t) => t.worker === 'inbox-recruiter-replies');
    };
    expect(has(null)).toBe(true);
    expect(has(61)).toBe(true);
    expect(has(30)).toBe(false);
  });
  it('linkedin halted leaves only naukri platforms', () => {
    const { d } = plan({
      control: ctl({ allowed: ['naukri'], halted: { linkedin: 'x', naukri: null } }),
      due: due({ followupsDue: 2, newOutreachReady: 2, naukriSearchLastHoursAgo: null }),
    });
    if (d.kind !== 'run') throw new Error('expected run');
    for (const t of d.tasks) expect(t.platforms).toEqual(['naukri']);
  });
  it('linkedin_message exhausted removes linkedin from due-followups only', () => {
    const { d } = plan({
      ceilings: ceil(['linkedin_message']),
      due: due({ followupsDue: 2, newOutreachReady: 2 }),
    });
    if (d.kind !== 'run') throw new Error('expected run');
    expect(d.tasks.find((t) => t.worker === 'due-followups')!.platforms).toEqual(['naukri']);
    expect(d.tasks.find((t) => t.worker === 'new-outreach')!.platforms).toEqual(['linkedin', 'naukri']);
  });
  it('all ceilings exhausted with work due gives ceilings_exhausted', () => {
    const { d } = plan({
      ceilings: ceil(['linkedin_invite', 'linkedin_message', 'naukri_apply', 'naukri_message']),
      due: due({ followupsDue: 3, newOutreachReady: 3 }),
    });
    expect(d).toMatchObject({ kind: 'skip', reason: 'ceilings_exhausted' });
  });
  it('nothing due gives nothing_due', () => {
    const { d } = plan({ due: due() });
    expect(d).toMatchObject({ kind: 'skip', reason: 'nothing_due' });
  });
  it('naukri-search needs naukri_apply ok and an old enough last search', () => {
    const run = (o: Partial<Parameters<typeof planWake>[0]>) => {
      const { d } = plan({ due: due({ followupsDue: 1 }), ...o });
      return d.kind === 'run' && d.tasks.some((t) => t.worker === 'naukri-search');
    };
    expect(run({ due: due({ followupsDue: 1, naukriSearchLastHoursAgo: 7 }) })).toBe(true);
    expect(run({ due: due({ followupsDue: 1, naukriSearchLastHoursAgo: 2 }) })).toBe(false);
    expect(run({ due: due({ followupsDue: 1, naukriSearchLastHoursAgo: 7 }), ceilings: ceil(['naukri_apply']) })).toBe(false);
  });
  it('loadPlanKnobs defaults and overrides', () => {
    expect(loadPlanKnobs({})).toEqual({ inboxEveryMin: 60, naukriSearchEveryHours: 6 });
    expect(loadPlanKnobs({ INBOX_EVERY_MIN: '15', NAUKRI_SEARCH_EVERY_HOURS: 'x' } as NodeJS.ProcessEnv))
      .toEqual({ inboxEveryMin: 15, naukriSearchEveryHours: 6 });
  });
});

describe('countDue', () => {
  const day = 24 * 3600 * 1000;
  function seedPerson(db: ReturnType<typeof openDb>, key: string, o: {
    company?: string; stage?: string; paused?: string | null; cooldown?: string | null; connectAgoDays?: number | null;
  } = {}) {
    const id = upsertPerson(db, {
      platform: 'linkedin', profileKey: `linkedin.com/in/${key}`, company: o.company ?? `Co ${key}`, category: 'recruiter',
    });
    db.prepare('UPDATE contact_state SET stage = ?, paused_reason = ?, cooldown_until = ? WHERE person_id = ?')
      .run(o.stage ?? 'active', o.paused ?? null, o.cooldown ?? null, id);
    if (o.connectAgoDays !== null && o.connectAgoDays !== undefined) {
      db.prepare(
        `INSERT INTO touches (person_id, kind, idempotency_key, status, sent_at) VALUES (?, 'connect', ?, 'sent', ?)`,
      ).run(id, `k-${key}`, new Date(NOW.getTime() - o.connectAgoDays * day).toISOString());
    }
    return id;
  }

  it('counts only due, unpaused, out-of-cooldown people', () => {
    const db = openDb(':memory:');
    seedPerson(db, 'due', { connectAgoDays: 10 });
    seedPerson(db, 'notyet', { connectAgoDays: 1 });
    seedPerson(db, 'paused', { connectAgoDays: 10, paused: 'manual' });
    seedPerson(db, 'cool', { connectAgoDays: 10, cooldown: new Date(NOW.getTime() + day).toISOString() });
    seedPerson(db, 'coolover', { connectAgoDays: 10, cooldown: new Date(NOW.getTime() - day).toISOString() });
    seedPerson(db, 'new', { stage: 'new', connectAgoDays: 10 });
    seedPerson(db, 'noconnect');
    expect(countDue(db, NOW, TUNING_DEFAULTS).followupsDue).toBe(2);
  });

  it('excludes people at a company with a positive reply', () => {
    const db = openDb(':memory:');
    seedPerson(db, 'a', { company: 'Acme', connectAgoDays: 10 });
    seedPerson(db, 'b', { company: 'Acme', stage: 'replied_positive', connectAgoDays: 10 });
    expect(countDue(db, NOW, TUNING_DEFAULTS).followupsDue).toBe(0);
  });

  it('counts pending connect rows in outreach_queue and reads scheduler_state', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES ('j1','t','T','C','u')").run();
    db.prepare("INSERT INTO jobs (id, source, title, company, url, excluded_reason) VALUES ('j2','t','T','C','u','x')").run();
    const ins = db.prepare(
      `INSERT INTO outreach_queue (job_id, connect_profile_url, connect_note, connect_status, status) VALUES (?, ?, ?, ?, ?)`,
    );
    ins.run('j1', 'https://linkedin.com/in/a', 'hi', null, 'queued'); // counted
    ins.run('j1', 'https://linkedin.com/in/b', 'hi', 'sent', 'queued'); // already sent
    ins.run('j1', null, null, null, 'queued'); // email-only
    ins.run('j2', 'https://linkedin.com/in/c', 'hi', null, 'queued'); // excluded job
    setState(db, 'inbox_last_checked_at', new Date(NOW.getTime() - 30 * 60000).toISOString(), NOW);
    setState(db, 'naukri_search_last_at', new Date(NOW.getTime() - 3 * 3600000).toISOString(), NOW);
    const c = countDue(db, NOW, TUNING_DEFAULTS);
    expect(c.newOutreachReady).toBe(1);
    expect(c.inboxLastCheckedMinAgo).toBe(30);
    expect(c.naukriSearchLastHoursAgo).toBeCloseTo(3);
  });

  it('returns null ages when state is missing', () => {
    const c = countDue(openDb(':memory:'), NOW, TUNING_DEFAULTS);
    expect(c).toEqual({ followupsDue: 0, newOutreachReady: 0, inboxLastCheckedMinAgo: null, naukriSearchLastHoursAgo: null });
  });
});
