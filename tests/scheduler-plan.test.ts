import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { TUNING_DEFAULTS } from '../src/outreach/tuning.js';
import { setState } from '../src/scheduler/runLog.js';
import { countDue, type DueCounts } from '../src/scheduler/due.js';
import { planWake, stepOrder, loadPlanKnobs, chunkQuota, CHUNK_SIZE, type PlanKnobs } from '../src/scheduler/plan.js';
import type { QuietConfig } from '../src/outreach/quiet.js';
import type { ControlState } from '../src/scheduler/control.js';
import type { CeilingStatus, LimitKey } from '../src/outreach/limits.js';

const NOW = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST
const QUIET = new Date('2026-10-14T21:00:00.000Z'); // 02:30 IST

const quiet: QuietConfig = { quietStartHour: 23, quietEndHour: 7, tzOffsetMinutes: 330 };
const knobs: PlanKnobs = { inboxEveryMin: 60, naukriDiscoverEveryHours: 6 };
const NAUKRI_NAMES = { jobs: [], posts: [], naukri: ['react-india'] };
const ctl = (o: Partial<ControlState> = {}): ControlState => ({
  killed: false, killReason: null, halted: { linkedin: null, naukri: null, wellfound: null },
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
const plan = (o: Partial<Parameters<typeof planWake>[0]> = {}) => {
  const d = planWake({ now: NOW, quiet, control: ctl(), ceilings: ceil(), due: due(), knobs, discoverSearches: NAUKRI_NAMES, ...o });
  return { d };
};

describe('planWake', () => {
  it('skips killed', () => {
    const { d } = plan({ control: ctl({ killed: true, killReason: 'STOP' }) });
    expect(d).toMatchObject({ kind: 'skip', reason: 'killed' });
  });
  it('skips halted when both platforms halted', () => {
    const { d } = plan({
      control: ctl({ allowed: [], halted: { linkedin: 'a', naukri: 'b', wellfound: null } }),
    });
    expect(d).toMatchObject({ kind: 'skip', reason: 'halted' });
  });
  it('skips quiet hours (02:30 IST)', () => {
    const { d } = plan({ now: QUIET });
    expect(d).toMatchObject({ kind: 'skip', reason: 'quiet_hours' });
  });
  it('plans every due task with no random total: the run decision has no burst', () => {
    const { d } = plan({ due: due({ followupsDue: 3, newOutreachReady: 2 }) });
    if (d.kind !== 'run') throw new Error('expected run');
    expect('burst' in d).toBe(false);
    const q = (p: string, k: string) => d.tasks.find((a) => a.platform === p)?.tasks.find((t) => t.kind === k)?.quota;
    expect(q('linkedin', 'followups')).toBe(3);
    expect(q('naukri', 'followups')).toBe(3);
    expect(q('linkedin', 'new_outreach')).toBe(2);
    expect(q('naukri', 'new_outreach')).toBe(2);
  });
  it('bounds each quota by the room left under its ceiling, not by a draw', () => {
    const c = ceil();
    c.linkedin_message = { used: 3, limit: 5, ok: true };
    c.linkedin_invite = { used: 4, limit: 5, ok: true };
    const { d } = plan({ ceilings: c, due: due({ followupsDue: 10, newOutreachReady: 10 }) });
    if (d.kind !== 'run') throw new Error('expected run');
    const q = (p: string, k: string) => d.tasks.find((a) => a.platform === p)?.tasks.find((t) => t.kind === k)?.quota;
    expect(q('linkedin', 'followups')).toBe(2);
    expect(q('linkedin', 'new_outreach')).toBe(1);
  });
  it('naukri follow-ups and new outreach share the naukri_message room, spent in order', () => {
    const { d } = plan({ due: due({ followupsDue: 4, newOutreachReady: 4 }) }); // naukri_message room is 5
    if (d.kind !== 'run') throw new Error('expected run');
    const q = (p: string, k: string) => d.tasks.find((a) => a.platform === p)?.tasks.find((t) => t.kind === k)?.quota;
    expect(q('naukri', 'followups')).toBe(4);
    expect(q('naukri', 'new_outreach')).toBe(1);
  });
  it('emits linkedin before naukri, one assignment per platform, tasks ordered inbox, followups, new_outreach, discover', () => {
    const { d } = plan({
      due: due({ followupsDue: 1, newOutreachReady: 1, inboxLastCheckedMinAgo: null, naukriSearchLastHoursAgo: null }),
    });
    if (d.kind !== 'run') throw new Error('expected run');
    expect(d.tasks.map((a) => [a.operator, a.platform])).toEqual([
      ['linkedin-operator', 'linkedin'], ['naukri-operator', 'naukri'],
    ]);
    expect(d.tasks[0].tasks.map((t) => t.kind)).toEqual(['inbox', 'followups', 'new_outreach']);
    expect(d.tasks[1].tasks.map((t) => t.kind)).toEqual(['inbox', 'followups', 'new_outreach', 'discover']);
  });
  it('splits quotas per platform in stable order, each at its own due count', () => {
    const { d } = plan({ due: due({ followupsDueByPlatform: { linkedin: 3, naukri: 3 }, followupsDue: 6 }) });
    if (d.kind !== 'run') throw new Error('expected run');
    const q = (p: string, k: string) =>
      d.tasks.find((a) => a.platform === p)?.tasks.find((t) => t.kind === k)?.quota;
    expect(q('linkedin', 'followups')).toBe(3);
    expect(q('naukri', 'followups')).toBe(3);
    expect(q('linkedin', 'new_outreach')).toBeUndefined();
  });
  it('the naukri discover task carries the named searches and the detail-page quota', () => {
    const { d } = plan({ due: due({ followupsDue: 1, naukriSearchLastHoursAgo: null }) });
    if (d.kind !== 'run') throw new Error('expected run');
    const t = d.tasks.find((a) => a.platform === 'naukri')!.tasks.find((x) => x.kind === 'discover');
    expect(t).toEqual({ kind: 'discover', quota: 5, searches: { jobs: ['react-india'], posts: [] } });
  });
  it('discover belongs to naukri only (linkedin has its own, named separately)', () => {
    const { d } = plan({ due: due({ followupsDue: 1, naukriSearchLastHoursAgo: null }) });
    if (d.kind !== 'run') throw new Error('expected run');
    const withSearch = d.tasks.filter((a) => a.tasks.some((t) => t.kind === 'discover'));
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
      control: ctl({ allowed: ['naukri'], halted: { linkedin: 'x', naukri: null, wellfound: null } }),
      due: due({ inboxLastCheckedMinAgo: null }),
    });
    if (d.kind !== 'run') throw new Error('expected run');
    expect(d.tasks.map((a) => a.platform)).toEqual(['naukri']);
    expect(d.tasks[0].tasks).toEqual([{ kind: 'inbox', quota: 5 }]);
  });
  it('linkedin halted leaves only the naukri assignment', () => {
    const { d } = plan({
      control: ctl({ allowed: ['naukri'], halted: { linkedin: 'x', naukri: null, wellfound: null } }),
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
  it('naukri discover needs a named search, naukri_apply ok and an old enough last run', () => {
    const run = (o: Partial<Parameters<typeof planWake>[0]>) => {
      const { d } = plan({ due: due({ followupsDue: 1 }), ...o });
      return d.kind === 'run' && d.tasks.some((a) => a.tasks.some((t) => t.kind === 'discover'));
    };
    expect(run({ due: due({ followupsDue: 1, naukriSearchLastHoursAgo: 7 }) })).toBe(true);
    expect(run({ due: due({ followupsDue: 1, naukriSearchLastHoursAgo: 2 }) })).toBe(false);
    expect(run({ due: due({ followupsDue: 1, naukriSearchLastHoursAgo: 7 }), ceilings: ceil(['naukri_apply']) })).toBe(false);
    expect(run({ due: due({ followupsDue: 1, naukriSearchLastHoursAgo: 7 }), discoverSearches: { jobs: [], posts: [], naukri: [] } })).toBe(false);
  });
  it('plans nothing when only a halted platform has work (I4, M1)', () => {
    const { d } = plan({
      control: ctl({ allowed: ['linkedin'], halted: { linkedin: null, naukri: 'x', wellfound: null } }),
      due: due({ followupsDueByPlatform: { linkedin: 0, naukri: 5 }, followupsDue: 5 }),
      ceilings: ceil(['linkedin_message', 'linkedin_invite']),
    });
    expect(d).toMatchObject({ kind: 'skip', reason: 'nothing_due' });
  });
  it('quota is sized only from the kept platform (I4)', () => {
    const { d } = plan(
      {
        control: ctl({ allowed: ['linkedin'], halted: { linkedin: null, naukri: 'x', wellfound: null } }),
        due: due({ followupsDueByPlatform: { linkedin: 1, naukri: 9 }, followupsDue: 10 }),
      },
    );
    if (d.kind !== 'run') throw new Error('expected run');
    expect(d.tasks).toHaveLength(1);
    expect(d.tasks[0]).toMatchObject({ operator: 'linkedin-operator', platform: 'linkedin' });
    expect(d.tasks[0].tasks.find((t) => t.kind === 'followups')).toEqual({ kind: 'followups', quota: 1 });
  });
  it('loadPlanKnobs defaults and overrides', () => {
    expect(loadPlanKnobs({})).toEqual({ inboxEveryMin: 60, naukriDiscoverEveryHours: 6 });
    expect(loadPlanKnobs({ INBOX_EVERY_MIN: '15', NAUKRI_DISCOVER_EVERY_HOURS: 'x' } as NodeJS.ProcessEnv))
      .toEqual({ inboxEveryMin: 15, naukriDiscoverEveryHours: 6 });
    expect(loadPlanKnobs({ NAUKRI_DISCOVER_EVERY_HOURS: '3', NAUKRI_SEARCH_EVERY_HOURS: '9' } as NodeJS.ProcessEnv).naukriDiscoverEveryHours).toBe(3);
    expect(loadPlanKnobs({ NAUKRI_SEARCH_EVERY_HOURS: '9' } as NodeJS.ProcessEnv).naukriDiscoverEveryHours).toBe(6);
  });
});

describe('apply task (8G-2 task 21)', () => {
  const asg = (d: ReturnType<typeof plan>['d']) =>
    d.kind === 'run' ? d.stages?.find((a) => a.operator === 'apply-operator') : undefined;
  const ceilApply = (used: number, limit: number): Record<LimitKey, CeilingStatus> => ({
    ...ceil(), apply_attempt: { used, limit, ok: used < limit },
  });

  it('apply task emitted only when rows exist and quota remains', () => {
    expect(asg(plan({ due: due({ applyQueued: 0, appliesLeftToday: 5 }) }).d)).toBeUndefined();
    expect(asg(plan({ due: due() }).d)).toBeUndefined(); // fields absent: nothing queued
    const a = asg(plan({ due: due({ applyQueued: 3, appliesLeftToday: 5 }), ceilings: ceilApply(0, 30) }).d);
    expect(a).toEqual({ operator: 'apply-operator', kind: 'apply', quota: 5 });
    expect(asg(plan({ due: due({ applyQueued: 3, appliesLeftToday: 0 }) }).d)).toBeUndefined();
    expect(asg(plan({ due: due({ applyQueued: 3, appliesLeftToday: 5 }), ceilings: ceilApply(30, 30) }).d)).toBeUndefined();
    // apply is listed after linkedin and naukri
    const d = plan({ due: due({ followupsDue: 1, applyQueued: 1, appliesLeftToday: 2 }), ceilings: ceilApply(0, 30) }).d;
    expect(d.kind === 'run' && d.tasks.map((t) => t.operator)).not.toContain('apply-operator');
    expect(d.kind === 'run' && stepOrder(d).map((t) => t.operator).slice(-1)).toEqual(['apply-operator']);
  });

  it('apply quota is the smaller of remaining MAX_APPLIES_PER_DAY and remaining APPLY_MAX_ATTEMPTS_PER_DAY', () => {
    expect(asg(plan({ due: due({ applyQueued: 9, appliesLeftToday: 4 }), ceilings: ceilApply(20, 30) }).d)!.quota).toBe(4);
    expect(asg(plan({ due: due({ applyQueued: 9, appliesLeftToday: 8 }), ceilings: ceilApply(28, 30) }).d)!.quota).toBe(2);
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
    const stmt = db.prepare('INSERT INTO outreach_queue (job_id, apply_platform, apply_status, status, connect_profile_url) VALUES (?, ?, ?, ?, ?)');
    let n = 0; // one queue row per job and connect profile, so each row gets its own profile
    const ins = { run: (...a: unknown[]) => stmt.run(...a, `https://linkedin.com/in/p${n++}`) };
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

describe('planWake: linkedin discover task', () => {
  const names = { jobs: ['react-india'], posts: ['default'] };
  const withDiscover = (keys: LimitKey[] = [], used = 0) => {
    const c = ceil();
    for (const k of keys) c[k] = { used: 5, limit: 5, ok: false };
    c.linkedin_discover = keys.includes('linkedin_discover') ? { used: 12, limit: 12, ok: false } : { used, limit: 12, ok: true };
    return c;
  };
  const discover = (o: Partial<Parameters<typeof planWake>[0]>) => {
    const { d } = plan({ due: due({ linkedinDiscoverLastHoursAgo: null }), ceilings: withDiscover(), discoverSearches: names, ...o });
    return d.kind === 'run' ? d.tasks.flatMap((a) => a.tasks.map((t) => ({ ...t, platform: a.platform }))).find((t) => t.kind === 'discover') : undefined;
  };
  it('is planned for linkedin when named searches exist and it never ran', () => {
    expect(discover({})).toMatchObject({ kind: 'discover', platform: 'linkedin', quota: 2, searches: names });
  });
  it('quota is capped by what is left of the daily discover ceiling', () => {
    expect(discover({ ceilings: withDiscover([], 11) })?.quota).toBe(1);
  });
  it('waits for the interval, needs names, an open ceiling and an unhalted platform', () => {
    expect(discover({ due: due({ linkedinDiscoverLastHoursAgo: 2 }) })).toBeUndefined();
    expect(discover({ due: due({ linkedinDiscoverLastHoursAgo: 7 }) })).toBeDefined();
    expect(discover({ discoverSearches: { jobs: [], posts: [] } })).toBeUndefined();
    expect(discover({ discoverSearches: undefined })).toBeUndefined();
    expect(discover({ ceilings: withDiscover(['linkedin_discover']) })).toBeUndefined();
    expect(discover({ control: ctl({ allowed: ['naukri'], halted: { linkedin: 'x', naukri: null, wellfound: null } }) })).toBeUndefined();
  });
  it('an untracked last-run age (field absent) never plans discover', () => {
    expect(discover({ due: due() })).toBeUndefined();
  });
  it('countDue reads the last-run state key written by the discovery tools', () => {
    const db = openDb(':memory:');
    expect(countDue(db, NOW, TUNING_DEFAULTS).linkedinDiscoverLastHoursAgo).toBeNull();
    setState(db, 'linkedin_discover_last_at', new Date(NOW.getTime() - 3 * 3600_000).toISOString(), NOW);
    expect(countDue(db, NOW, TUNING_DEFAULTS).linkedinDiscoverLastHoursAgo).toBeCloseTo(3);
  });
});

describe('planWake: the pipeline pulls linkedin new_outreach and apply into the same wake', () => {
  const fresh = (o: Partial<DueCounts> = {}) => due({ unmatchedJobs: 6, appliesLeftToday: 5, ...o });
  const run = (o: Partial<Parameters<typeof planWake>[0]> = {}) => {
    const { d } = plan({ due: fresh(), discoverSearches: undefined, ...o });
    if (d.kind !== 'run') return { d, li: [] as string[], nk: [] as string[], apply: false };
    const kinds = (p: string) => d.tasks.filter((a) => a.platform === p).flatMap((a) => a.tasks.map((t) => t.kind));
    return { d, li: kinds('linkedin'), nk: kinds('naukri'), apply: !!d.stages?.some((s) => s.kind === 'apply') };
  };
  it('plans linkedin new_outreach and apply with zero due counts', () => {
    const r = run();
    expect(r.li).toContain('new_outreach');
    expect(r.nk).not.toContain('new_outreach');
    expect(r.apply).toBe(true);
    if (r.d.kind === 'run') {
      const q = r.d.tasks.flatMap((a) => a.tasks).find((t) => t.kind === 'new_outreach')!.quota;
      expect(q).toBeGreaterThan(0);
      expect(q).toBeLessThanOrEqual(5); // the linkedin_invite room in this fixture
    }
  });
  it('keeps the wake order: pipeline, linkedin tasks, apply (no mail step)', () => {
    const { d } = run();
    if (d.kind !== 'run') throw new Error('expected run');
    const ks = stepOrder(d).map((s) => s.kind);
    expect(ks).not.toContain('mail');
    expect(ks.indexOf('pipeline')).toBeLessThan(ks.indexOf('new_outreach'));
    expect(ks.indexOf('new_outreach')).toBeLessThan(ks.indexOf('apply'));
  });
  it('no linkedin new_outreach when the linkedin_invite ceiling is exhausted', () => {
    expect(run({ ceilings: ceil(['linkedin_invite']) }).li).not.toContain('new_outreach');
  });
  it('no apply when apply_attempt is exhausted or no applies are left today', () => {
    expect(run({ ceilings: ceil(['apply_attempt']) }).apply).toBe(false);
    expect(run({ due: fresh({ appliesLeftToday: 0 }) }).apply).toBe(false);
  });
  it('no linkedin task when linkedin is halted or not allowed', () => {
    const c = ctl({ allowed: ['naukri'], halted: { linkedin: 'x', naukri: null, wellfound: null } });
    expect(run({ control: c }).li).toEqual([]);
  });
  it('pulled-in linkedin new_outreach gets the whole linkedin_invite room left', () => {
    const c = ceil();
    c.linkedin_invite = { used: 2, limit: 5, ok: true };
    const { d } = run({ ceilings: c });
    if (d.kind !== 'run') throw new Error('expected run');
    const q = d.tasks.flatMap((a) => a.tasks).find((t) => t.kind === 'new_outreach')!.quota;
    expect(q).toBe(3);
  });
  it('plans all due follow-ups together with the pipeline, bounded by ceilings only', () => {
    const { d } = run({ due: fresh({ followupsDue: 5 }) });
    if (d.kind !== 'run') throw new Error('expected run');
    const spent = d.tasks.flatMap((a) => a.tasks).filter((t) => t.kind === 'followups').reduce((n, t) => n + t.quota, 0);
    expect(spent).toBe(10); // 5 on linkedin and 5 on naukri, each within its room of 5
  });
  it('splits a quota into calls of at most CHUNK_SIZE', () => {
    expect(CHUNK_SIZE).toBe(5);
    expect(chunkQuota(12)).toEqual([5, 5, 2]);
    expect(chunkQuota(5)).toEqual([5]);
    expect(chunkQuota(1)).toEqual([1]);
    expect(chunkQuota(100)).toHaveLength(20);
  });
  it('plans chunks for the sending steps only: followups, new_outreach and apply', () => {
    const c = ceil();
    c.linkedin_invite = { used: 0, limit: 12, ok: true };
    const { d } = run({ ceilings: c, due: fresh({ followupsDue: 3 }) });
    if (d.kind !== 'run') throw new Error('expected run');
    const steps = stepOrder(d);
    const by = (k: string) => steps.filter((s) => s.kind === k);
    expect(by('new_outreach').find((s) => s.platform === 'linkedin')).toMatchObject({ quota: 12, chunks: [5, 5, 2] });
    expect(by('followups').map((s) => s.chunks)).toEqual([[3], [3]]);
    expect(by('apply')[0].chunks).toEqual([5]);
    for (const k of ['inbox', 'discover', 'pipeline']) for (const s of by(k)) expect(s.chunks).toBeUndefined();
  });
  it('invents no work when the pipeline is not due and nothing is queued', () => {
    const { d } = plan({ due: due({ unmatchedJobs: 0, appliesLeftToday: 5 }), discoverSearches: undefined });
    expect(d).toMatchObject({ kind: 'skip', reason: 'nothing_due' });
  });
});
