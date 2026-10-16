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
  const keys: LimitKey[] = ['linkedin_invite', 'linkedin_message', 'naukri_apply', 'naukri_message', 'apply_attempt'];
  return Object.fromEntries(
    keys.map((k) => [k, bad.includes(k) ? { used: 5, limit: 5, ok: false } : { used: 0, limit: 5, ok: true }]),
  ) as Record<LimitKey, CeilingStatus>;
};
const due = (o: Partial<DueCounts> = {}): DueCounts => {
  const f = o.followupsDue ?? 0;
  const n = o.newOutreachReady ?? 0;
  return {
    followupsDue: f * 2, newOutreachReady: n * 2,
    followupsDueByPlatform: { linkedin: f, naukri: f },
    newOutreachReadyByPlatform: { linkedin: n, naukri: n },
    inboxLastCheckedMinAgo: 5, naukriSearchLastHoursAgo: 1,
    ...o,
  };
};
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
        .flatMap((a) => a.tasks)
        .filter((t) => t.kind === 'followups' || t.kind === 'new_outreach')
        .reduce((s, t) => s + t.quota, 0);
      expect(spent).toBeLessThanOrEqual(d.burst);
      expect(spent).toBe(d.burst);
    }
  });
  it('emits linkedin before naukri, one assignment per platform, tasks ordered inbox, followups, new_outreach, search', () => {
    const { d } = plan({
      due: due({ followupsDue: 1, newOutreachReady: 1, inboxLastCheckedMinAgo: null, naukriSearchLastHoursAgo: null }),
    });
    if (d.kind !== 'run') throw new Error('expected run');
    expect(d.tasks.map((a) => [a.operator, a.platform])).toEqual([
      ['linkedin-operator', 'linkedin'], ['naukri-operator', 'naukri'],
    ]);
    expect(d.tasks[0].tasks.map((t) => t.kind)).toEqual(['inbox', 'followups', 'new_outreach']);
    expect(d.tasks[1].tasks.map((t) => t.kind)).toEqual(['inbox', 'followups', 'new_outreach', 'search']);
  });
  it('splits quotas per platform in stable order from the remaining burst', () => {
    // rng 0.99 -> burst 4: linkedin takes 3 of its 3 followups, naukri gets the 1 left
    const { d } = plan({ due: due({ followupsDueByPlatform: { linkedin: 3, naukri: 3 }, followupsDue: 6 }) }, 0.99);
    if (d.kind !== 'run') throw new Error('expected run');
    const q = (p: string, k: string) =>
      d.tasks.find((a) => a.platform === p)?.tasks.find((t) => t.kind === k)?.quota;
    expect(d.burst).toBe(4);
    expect(q('linkedin', 'followups')).toBe(3);
    expect(q('naukri', 'followups')).toBe(1);
    expect(q('linkedin', 'new_outreach')).toBeUndefined();
  });
  it('search belongs to naukri only', () => {
    const { d } = plan({ due: due({ followupsDue: 1, naukriSearchLastHoursAgo: null }) });
    if (d.kind !== 'run') throw new Error('expected run');
    const withSearch = d.tasks.filter((a) => a.tasks.some((t) => t.kind === 'search'));
    expect(withSearch.map((a) => a.platform)).toEqual(['naukri']);
  });
  it('assigns inbox when never checked or 61 min ago, not at 30', () => {
    const has = (v: number | null) => {
      const { d } = plan({ due: due({ inboxLastCheckedMinAgo: v, followupsDue: 1 }) });
      return d.kind === 'run' && d.tasks.some((a) => a.tasks.some((t) => t.kind === 'inbox'));
    };
    expect(has(null)).toBe(true);
    expect(has(61)).toBe(true);
    expect(has(30)).toBe(false);
  });
  it('inbox is assigned per allowed platform', () => {
    const { d } = plan({
      control: ctl({ allowed: ['naukri'], halted: { linkedin: 'x', naukri: null } }),
      due: due({ inboxLastCheckedMinAgo: null }),
    });
    if (d.kind !== 'run') throw new Error('expected run');
    expect(d.tasks.map((a) => a.platform)).toEqual(['naukri']);
    expect(d.tasks[0].tasks).toEqual([{ kind: 'inbox', quota: 5 }]);
  });
  it('linkedin halted leaves only the naukri assignment', () => {
    const { d } = plan({
      control: ctl({ allowed: ['naukri'], halted: { linkedin: 'x', naukri: null } }),
      due: due({ followupsDue: 2, newOutreachReady: 2, naukriSearchLastHoursAgo: null }),
    });
    if (d.kind !== 'run') throw new Error('expected run');
    for (const a of d.tasks) {
      expect(a.platform).toBe('naukri');
      expect(a.operator).toBe('naukri-operator');
    }
  });
  it('linkedin_message exhausted removes the linkedin followups task only', () => {
    const { d } = plan({
      ceilings: ceil(['linkedin_message']),
      due: due({ followupsDue: 2, newOutreachReady: 2 }),
    });
    if (d.kind !== 'run') throw new Error('expected run');
    const kinds = (p: string) => d.tasks.find((a) => a.platform === p)!.tasks.map((t) => t.kind);
    expect(kinds('linkedin')).not.toContain('followups');
    expect(kinds('naukri')).toContain('followups');
    // burst 4: naukri followups take 2, linkedin new_outreach the other 2, naukri new_outreach gets none
    expect(kinds('linkedin')).toContain('new_outreach');
  });
  it('does not emit an assignment with zero tasks', () => {
    const { d } = plan({ due: due({ followupsDueByPlatform: { linkedin: 0, naukri: 2 }, followupsDue: 2 }) });
    if (d.kind !== 'run') throw new Error('expected run');
    for (const a of d.tasks) expect(a.tasks.length).toBeGreaterThan(0);
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
      return d.kind === 'run' && d.tasks.some((a) => a.tasks.some((t) => t.kind === 'search'));
    };
    expect(run({ due: due({ followupsDue: 1, naukriSearchLastHoursAgo: 7 }) })).toBe(true);
    expect(run({ due: due({ followupsDue: 1, naukriSearchLastHoursAgo: 2 }) })).toBe(false);
    expect(run({ due: due({ followupsDue: 1, naukriSearchLastHoursAgo: 7 }), ceilings: ceil(['naukri_apply']) })).toBe(false);
  });
  it('plans nothing when only a halted platform has work (I4, M1)', () => {
    const { d } = plan({
      control: ctl({ allowed: ['linkedin'], halted: { linkedin: null, naukri: 'x' } }),
      due: due({ followupsDueByPlatform: { linkedin: 0, naukri: 5 }, followupsDue: 5 }),
      ceilings: ceil(['linkedin_message', 'linkedin_invite']),
    });
    expect(d).toMatchObject({ kind: 'skip', reason: 'nothing_due' });
  });
  it('quota is sized only from the kept platform (I4)', () => {
    const { d } = plan(
      {
        control: ctl({ allowed: ['linkedin'], halted: { linkedin: null, naukri: 'x' } }),
        due: due({ followupsDueByPlatform: { linkedin: 1, naukri: 9 }, followupsDue: 10 }),
      },
      0.99,
    );
    if (d.kind !== 'run') throw new Error('expected run');
    expect(d.tasks).toHaveLength(1);
    expect(d.tasks[0]).toMatchObject({ operator: 'linkedin-operator', platform: 'linkedin' });
    expect(d.tasks[0].tasks.find((t) => t.kind === 'followups')).toEqual({ kind: 'followups', quota: 1 });
  });
  it('loadPlanKnobs defaults and overrides', () => {
    expect(loadPlanKnobs({})).toEqual({ inboxEveryMin: 60, naukriSearchEveryHours: 6 });
    expect(loadPlanKnobs({ INBOX_EVERY_MIN: '15', NAUKRI_SEARCH_EVERY_HOURS: 'x' } as NodeJS.ProcessEnv))
      .toEqual({ inboxEveryMin: 15, naukriSearchEveryHours: 6 });
  });
});

describe('apply task (8G-2 task 21)', () => {
  const asg = (d: ReturnType<typeof plan>['d']) =>
    d.kind === 'run' ? d.tasks.find((a) => a.operator === 'apply-operator') : undefined;
  const ceilApply = (used: number, limit: number): Record<LimitKey, CeilingStatus> => ({
    ...ceil(), apply_attempt: { used, limit, ok: used < limit },
  });

  it('apply task emitted only when rows exist and quota remains', () => {
    expect(asg(plan({ due: due({ applyQueued: 0, appliesLeftToday: 5 }) }).d)).toBeUndefined();
    expect(asg(plan({ due: due() }).d)).toBeUndefined(); // fields absent: nothing queued
    const a = asg(plan({ due: due({ applyQueued: 3, appliesLeftToday: 5 }), ceilings: ceilApply(0, 30) }).d);
    expect(a).toMatchObject({ operator: 'apply-operator', platform: 'apply', tasks: [{ kind: 'apply', quota: 5 }] });
    expect(asg(plan({ due: due({ applyQueued: 3, appliesLeftToday: 0 }) }).d)).toBeUndefined();
    expect(asg(plan({ due: due({ applyQueued: 3, appliesLeftToday: 5 }), ceilings: ceilApply(30, 30) }).d)).toBeUndefined();
    // apply is listed after linkedin and naukri
    const d = plan({ due: due({ followupsDue: 1, applyQueued: 1, appliesLeftToday: 2 }), ceilings: ceilApply(0, 30) }).d;
    expect(d.kind === 'run' && d.tasks.map((t) => t.operator)).toEqual(['linkedin-operator', 'naukri-operator', 'apply-operator']);
  });

  it('apply quota is the smaller of remaining MAX_APPLIES_PER_DAY and remaining APPLY_MAX_ATTEMPTS_PER_DAY', () => {
    expect(asg(plan({ due: due({ applyQueued: 9, appliesLeftToday: 4 }), ceilings: ceilApply(20, 30) }).d)!.tasks[0].quota).toBe(4);
    expect(asg(plan({ due: due({ applyQueued: 9, appliesLeftToday: 8 }), ceilings: ceilApply(28, 30) }).d)!.tasks[0].quota).toBe(2);
  });

  it('apply alone yields a run; exhausted quota with rows is ceilings_exhausted', () => {
    const only = plan({ due: due({ applyQueued: 2, appliesLeftToday: 3 }), ceilings: ceilApply(0, 30) }).d;
    expect(only.kind).toBe('run');
    const none = plan({ due: due({ applyQueued: 2, appliesLeftToday: 0 }) }).d;
    expect(none).toMatchObject({ kind: 'skip', reason: 'ceilings_exhausted' });
  });

  it('countDue counts queued apply rows and the remaining daily apply budget', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES ('j1','t','T','C','u')").run();
    db.prepare("INSERT INTO jobs (id, source, title, company, url, excluded_reason) VALUES ('j2','t','T','C','u','x')").run();
    db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES ('j3','t','T','C','u')").run();
    const ins = db.prepare('INSERT INTO outreach_queue (job_id, apply_platform, apply_status, status) VALUES (?, ?, ?, ?)');
    ins.run('j1', 'greenhouse', null, 'queued'); // counted
    ins.run('j3', 'browser', 'queued', 'queued'); // counted (one per job)
    ins.run('j1', 'none', null, 'queued'); // not an apply row
    ins.run('j1', null, null, 'queued'); // not an apply row
    ins.run('j1', 'lever', 'submitted', 'queued'); // already done
    ins.run('j2', 'ashby', null, 'queued'); // excluded job
    ins.run('j1', 'lever', null, 'done'); // not queued
    db.prepare("INSERT INTO daily_counters (day, key, count) VALUES (date('now'), 'easy_apply', 2)").run();
    const c = countDue(db, NOW, TUNING_DEFAULTS, { MAX_APPLIES_PER_DAY: '7' });
    expect(c.applyQueued).toBe(2);
    expect(c.appliesLeftToday).toBe(5);
    expect(countDue(db, NOW, TUNING_DEFAULTS, {}).appliesLeftToday).toBe(3); // default 5
    expect(countDue(openDb(':memory:'), NOW, TUNING_DEFAULTS, {}).applyQueued).toBe(0);
  });

  it('linkedin_easy rows and already-actioned rows are not queued apply work', () => {
    const db = openDb(':memory:');
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      db.prepare('INSERT INTO jobs (id, source, title, company, url) VALUES (?,?,?,?,?)').run(id, 't', 'T', 'C', 'u');
    }
    const ins = db.prepare('INSERT INTO outreach_queue (job_id, apply_platform, apply_status, status) VALUES (?, ?, ?, ?)');
    ins.run('a', 'linkedin_easy', null, 'queued');
    ins.run('b', 'naukri', null, 'queued');
    ins.run('c', 'greenhouse', 'needs_owner', 'queued');
    ins.run('d', 'greenhouse', 'held', 'queued');
    ins.run('e', 'greenhouse', 'manual_review', 'queued');
    expect(countDue(db, NOW, TUNING_DEFAULTS, {}).applyQueued).toBe(1);
    expect(countDue(db, NOW, TUNING_DEFAULTS, { APPLY_LINKEDIN_EASY: 'yes' }).applyQueued).toBe(1);
    expect(countDue(db, NOW, TUNING_DEFAULTS, { APPLY_LINKEDIN_EASY: 'true' }).applyQueued).toBe(2);
  });
});

describe('countDue', () => {
  const day = 24 * 3600 * 1000;
  function seedPerson(db: ReturnType<typeof openDb>, key: string, o: {
    company?: string; stage?: string; paused?: string | null; cooldown?: string | null; connectAgoDays?: number | null;
    accepted?: boolean;
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
    if (o.accepted !== false && o.connectAgoDays !== null && o.connectAgoDays !== undefined) {
      db.prepare("INSERT INTO connections (profile_url, status) VALUES (?, 'messaged')").run(`linkedin.com/in/${key}`);
    }
    return id;
  }

  it('does not treat a bare sent invite as acceptance (I1)', () => {
    const db = openDb(':memory:');
    seedPerson(db, 'invited', { connectAgoDays: 10, accepted: false });
    expect(countDue(db, NOW, TUNING_DEFAULTS).followupsDue).toBe(0);
  });

  it('skips unparseable cooldown, cycle start and sent_at (I2)', () => {
    const db = openDb(':memory:');
    seedPerson(db, 'a', { connectAgoDays: 10, cooldown: 'garbage' });
    const b = seedPerson(db, 'b', { connectAgoDays: 10 });
    db.prepare("UPDATE contact_state SET cycle_started_at = 'nope' WHERE person_id = ?").run(b);
    const c = seedPerson(db, 'c', { connectAgoDays: 10 });
    db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status, sent_at) VALUES (?, 'role_ask', 'zz', 'sent', 'bad')").run(c);
    expect(countDue(db, NOW, TUNING_DEFAULTS).followupsDue).toBe(0);
  });

  it('excludes people with an in-flight touch and dedups queued work (I3, I4)', () => {
    const db = openDb(':memory:');
    const a = seedPerson(db, 'a', { connectAgoDays: 10 });
    seedPerson(db, 'b', { connectAgoDays: 10 });
    db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status) VALUES (?, 'role_ask', 'q1', 'queued')").run(a);
    db.prepare("INSERT INTO jobs (id, source, title, company, url) VALUES ('j1','t','T','C','u')").run();
    db.prepare(
      "INSERT INTO outreach_queue (job_id, connect_profile_url, connect_note, status) VALUES ('j1', 'linkedin.com/in/a', 'hi', 'queued')",
    ).run();
    const c = countDue(db, NOW, TUNING_DEFAULTS);
    expect(c.followupsDue).toBe(1);
    expect(c.followupsDueByPlatform).toEqual({ linkedin: 1, naukri: 0 });
    expect(c.newOutreachReady).toBe(1);
    expect(c.newOutreachReadyByPlatform).toEqual({ linkedin: 1, naukri: 0 });
  });

  it('treats an unparseable scheduler_state timestamp as ran just now (M4)', () => {
    const db = openDb(':memory:');
    setState(db, 'inbox_last_checked_at', 'garbage', NOW);
    setState(db, 'naukri_search_last_at', 'garbage', NOW);
    const c = countDue(db, NOW, TUNING_DEFAULTS);
    expect(c.inboxLastCheckedMinAgo).toBe(0);
    expect(c.naukriSearchLastHoursAgo).toBe(0);
  });

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
    expect(c.inboxLastCheckedMinAgo).toBeNull();
    expect(c.naukriSearchLastHoursAgo).toBeNull();
    expect(c.followupsDue + c.newOutreachReady).toBe(0);
  });
});
