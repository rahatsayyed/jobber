// JOBBER_PLATFORMS: parsing, plan filtering per platform, the mail/sources/apply switches, manual requests held, and unset == today.
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { describePlatformSwitch, readPlatformSwitch, switchOn, type SwitchName } from '../src/scheduler/platformSwitch.js';
import { planWake } from '../src/scheduler/plan.js';
import { TUNING_DEFAULTS } from '../src/outreach/tuning.js';
import { countDue, type DueCounts } from '../src/scheduler/due.js';
import { createManualRequest, manualRequestsHeld, manualRequestsPending, manualPlatformTasks } from '../src/manual/requests.js';
import { ingestManualRequests } from '../src/manual/ingest.js';
import { finalizeManualRequests } from '../src/manual/report.js';
import { gate } from '../src/scheduler/mailDrip.js';
import { replyGate } from '../src/scheduler/replyCheck.js';
import { schedulerChecks } from '../src/platform/checksScheduler.js';
import { ENV_CATALOG } from '../src/settings/envCatalog.js';
import type { QuietConfig } from '../src/outreach/quiet.js';
import type { ControlState } from '../src/scheduler/control.js';
import type { CeilingStatus, LimitKey } from '../src/outreach/limits.js';

const NOW = new Date('2026-10-15T08:00:00.000Z'); // 13:30 IST
const quiet: QuietConfig = { quietStartHour: 23, quietEndHour: 7, tzOffsetMinutes: 330 };
const knobs = { inboxEveryMin: 60, naukriDiscoverEveryHours: 6 };
const control = (allowed: ControlState['allowed'] = ['linkedin', 'naukri', 'wellfound']): ControlState => ({
  killed: false, killReason: null, halted: { linkedin: null, naukri: null, wellfound: null }, allowed, readError: null,
});
const ceilings = Object.fromEntries(
  (['linkedin_invite', 'linkedin_message', 'naukri_apply', 'naukri_message', 'apply_attempt', 'linkedin_discover', 'naukri_jd_fetch', 'wellfound_discover'] as LimitKey[])
    .map((k) => [k, { used: 0, limit: 10, ok: true }]),
) as Record<LimitKey, CeilingStatus>;
const due = (o: Partial<DueCounts> = {}): DueCounts => ({
  followupsDue: 4, newOutreachReady: 4,
  followupsDueByPlatform: { linkedin: 2, naukri: 2 }, newOutreachReadyByPlatform: { linkedin: 2, naukri: 2 },
  inboxLastCheckedMinAgo: 500, naukriSearchLastHoursAgo: null, wellfoundDiscoverLastHoursAgo: null,
  scriptDiscoverLastHoursAgo: null, sourceTasksQueued: 2, applyQueued: 3, appliesLeftToday: 5, unmatchedJobs: 2, emailFollowupsReady: 1,
  ...o,
});
const names = { jobs: [], posts: [], naukri: ['react-india'], wellfound: ['wf'] };
const plan = (platforms?: ReadonlySet<SwitchName> | null, over: Partial<Parameters<typeof planWake>[0]> = {}) =>
  planWake({ now: NOW, quiet, control: control(), ceilings, due: due(), knobs, discoverSearches: names, codePassEnabled: true, platforms, ...over });
const sw = (v: string) => readPlatformSwitch({ JOBBER_PLATFORMS: v });
const set = (v: string) => sw(v).active;

function summary(d: ReturnType<typeof planWake>) {
  if (d.kind !== 'run') return d;
  return { tasks: d.tasks.map((a) => [a.platform, a.tasks.map((t) => `${t.kind}:${t.quota}`)]), stages: (d.stages ?? []).map((s) => `${s.kind}:${s.quota}`) };
}

describe('reading the value', () => {
  it('blank or unset is everything; names are trimmed and case-folded', () => {
    expect(readPlatformSwitch({}).active).toBeNull();
    expect(sw('   ').active).toBeNull();
    expect(sw(' , ').active).toBeNull();
    expect([...set(' LinkedIn , mail,')!]).toEqual(['linkedin', 'mail']);
    expect(describePlatformSwitch(sw('linkedin'))).toBe('linkedin only');
    expect(describePlatformSwitch(sw('mail,linkedin'))).toBe('linkedin, mail');
    expect(describePlatformSwitch(sw(''))).toBe('all platforms');
    expect(switchOn(null, 'apply')).toBe(true);
    expect(switchOn(set('linkedin'), 'apply')).toBe(false);
  });
  it('an invalid name makes the whole value read as unset (never silently restrict)', () => {
    const r = sw('linkedin,monster');
    expect(r.active).toBeNull();
    expect(r.invalid).toEqual(['monster']);
  });
  it('the doctor warns on an invalid value and passes on a valid or unset one', async () => {
    const check = schedulerChecks().find((c) => c.id === 'jobber-platforms')!;
    const run = (v?: string) => check.run({ root: '.', env: v === undefined ? {} : { JOBBER_PLATFORMS: v }, fs: { exists: () => false } } as never);
    expect((await run('linkedin,nope')).status).toBe('warn');
    expect((await run('linkedin')).status).toBe('pass');
    expect((await run()).status).toBe('pass');
  });
  it('has a catalog entry and no blankMeansDefault', () => {
    const s = ENV_CATALOG.find((x) => x.key === 'JOBBER_PLATFORMS')!;
    expect(s).toBeTruthy();
    expect(s.blankMeansDefault).toBe(false);
  });
});

describe('plan filtering', () => {
  it('unset (null, undefined, or a full list) plans exactly what it did before', () => {
    const before = summary(plan(undefined));
    expect(summary(plan(null))).toEqual(before);
    expect(summary(plan(set('linkedin,naukri,wellfound,mail,sources,apply')))).toEqual(before);
    expect(before).toMatchObject({ stages: expect.arrayContaining(['discover_scripts:1', 'discover_agent:2', 'pipeline:2', 'apply:5']) });
  });

  it('linkedin only: no Naukri or Wellfound task, no code pass, source-operator or apply', () => {
    const d = plan(set('linkedin'));
    if (d.kind !== 'run') throw new Error('expected run');
    expect(d.tasks.map((a) => a.platform)).toEqual(['linkedin']);
    const kinds = (d.stages ?? []).map((s) => s.kind);
    expect(kinds).not.toContain('discover_scripts');
    expect(kinds).not.toContain('discover_agent');
    expect(kinds).not.toContain('apply');
    expect(kinds).toContain('pipeline');
  });

  it('each platform lists only its own tasks', () => {
    for (const p of ['linkedin', 'naukri', 'wellfound'] as const) {
      const d = plan(set(p));
      if (d.kind !== 'run') throw new Error('expected run');
      expect(d.tasks.map((a) => a.platform), p).toEqual([p]);
    }
  });

  it('never widens the control state: a halted platform stays out even when listed', () => {
    const d = plan(set('linkedin,naukri'), { control: control(['linkedin']) });
    if (d.kind !== 'run') throw new Error('expected run');
    expect(d.tasks.map((a) => a.platform)).toEqual(['linkedin']);
  });

  it('the linkedin drip is unaffected by naukri and wellfound entries (still no LinkedIn wake task but the pipeline stays)', () => {
    const a = summary(plan(set('linkedin'), { linkedinDrip: true }));
    const b = summary(plan(set('linkedin,naukri,wellfound'), { linkedinDrip: true }));
    expect((a as { tasks: unknown[][] }).tasks.map((t) => t[0])).toEqual([]);
    expect((b as { tasks: unknown[][] }).tasks.map((t) => t[0])).toEqual(['naukri', 'wellfound']);
  });

  it('sources switch gates the code pass and the source-operator', () => {
    const on = (plan(set('linkedin,sources')) as { stages?: { kind: string }[] }).stages!.map((s) => s.kind);
    expect(on).toEqual(expect.arrayContaining(['discover_scripts', 'discover_agent']));
    const off = (plan(set('linkedin,apply')) as { stages?: { kind: string }[] }).stages!.map((s) => s.kind);
    expect(off).not.toContain('discover_scripts');
    expect(off).not.toContain('discover_agent');
  });

  it('apply switch gates the apply-operator step only', () => {
    expect((plan(set('linkedin,apply')) as { stages: { kind: string }[] }).stages.map((s) => s.kind)).toContain('apply');
    expect((plan(set('linkedin,sources')) as { stages: { kind: string }[] }).stages.map((s) => s.kind)).not.toContain('apply');
  });

  it('mail switch: email follow-ups pull the pipeline in only when mail is listed', () => {
    const only = { due: due({ unmatchedJobs: 0, sourceTasksQueued: 0, applyQueued: 0, followupsDueByPlatform: { linkedin: 0, naukri: 0 }, newOutreachReadyByPlatform: { linkedin: 0, naukri: 0 }, inboxLastCheckedMinAgo: 1, emailFollowupsReady: 3, scriptDiscoverLastHoursAgo: 1 }) };
    expect((plan(set('linkedin,mail'), only) as { stages?: { kind: string }[] }).stages?.map((s) => s.kind)).toContain('pipeline');
    expect(plan(set('linkedin'), only).kind).toBe('skip');
  });

  it('an empty platform set still skips as nothing_due, not as halted', () => {
    const d = plan(set('mail'), { due: due({ unmatchedJobs: 0, sourceTasksQueued: 0, applyQueued: 0, followupsDueByPlatform: { linkedin: 0, naukri: 0 }, newOutreachReadyByPlatform: { linkedin: 0, naukri: 0 }, inboxLastCheckedMinAgo: 1, emailFollowupsReady: 0 }) });
    expect(d).toMatchObject({ kind: 'skip' });
    expect((d as { reason: string }).reason).not.toBe('halted');
  });
});

describe('mail drip and reply check', () => {
  const deps = (env: NodeJS.ProcessEnv) => ({ db: openDb(':memory:'), env, cfg: {}, stopFile: '.jobber/none-STOP-test', now: () => NOW }) as never;
  it('both gates refuse with platform_off unless mail is listed; unset is not affected', () => {
    expect(gate(deps({ JOBBER_PLATFORMS: 'linkedin' }), {} as never, NOW, true)).toBe('platform_off');
    expect(replyGate(deps({ JOBBER_PLATFORMS: 'linkedin' }), NOW)).toBe('platform_off');
    expect(gate(deps({}), {} as never, NOW, true)).not.toBe('platform_off');
    expect(replyGate(deps({ JOBBER_PLATFORMS: 'linkedin,mail' }), NOW)).not.toBe('platform_off');
    expect(replyGate(deps({ JOBBER_PLATFORMS: 'bogus' }), NOW)).not.toBe('platform_off'); // invalid reads as unset
  });
});

describe('manual requests', () => {
  const LI = 'https://www.linkedin.com/jobs/view/1234567890/';
  const ATS = 'https://boards.greenhouse.io/acme/jobs/123';
  function world() {
    const db = openDb(':memory:');
    createManualRequest(db, LI, { now: NOW });
    createManualRequest(db, ATS, { now: NOW });
    return db;
  }
  it('requests that need an unlisted part stay pending and are not counted as due', () => {
    const db = world();
    expect(manualRequestsPending(db)).toBe(2);
    expect(manualRequestsPending(db, sw('linkedin'))).toBe(1); // the ATS board needs sources
    expect(manualRequestsPending(db, sw('naukri'))).toBe(0);
    expect(manualPlatformTasks(db, sw('naukri')).linkedin).toBe(0);
    expect(manualPlatformTasks(db, sw('linkedin')).linkedin).toBe(1);
    expect(manualRequestsHeld(db, sw('linkedin')).map((h) => h.needs)).toEqual(['sources']);
    expect(manualRequestsHeld(db)).toEqual([]);
    expect(countDue(db, NOW, TUNING_DEFAULTS, { JOBBER_PLATFORMS: 'naukri' }).manualRequestsPending).toBe(0);
    expect(countDue(db, NOW, TUNING_DEFAULTS, {}).manualRequestsPending).toBe(2);
  });
  it('ingest leaves a held request pending (never dropped or failed)', async () => {
    const db = world();
    const r = await ingestManualRequests(db, { runId: 'r1', now: () => NOW, platforms: sw('naukri') });
    expect(r.requests).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM manual_requests WHERE status = 'pending'").get() as { n: number }).n).toBe(2);
    const r2 = await ingestManualRequests(db, { runId: 'r2', now: () => NOW, platforms: sw('linkedin') });
    expect(r2.requests).toBe(1);
    expect((db.prepare("SELECT status FROM manual_requests WHERE url = ?").get(ATS) as { status: string }).status).toBe('pending');
  });
  it('the report says so once, and again only when the held set changes', async () => {
    const db = world();
    const sent: string[] = [];
    const d = { now: () => NOW, send: async () => undefined, platforms: sw('linkedin'), notifyHeld: async (t: string) => { sent.push(t); } };
    const r = await finalizeManualRequests(db, 'ok', d);
    expect(r.held).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('JOBBER_PLATFORMS does not list: sources');
    await finalizeManualRequests(db, 'ok', d);
    expect(sent).toHaveLength(1);
    const none = await finalizeManualRequests(db, 'ok', { ...d, platforms: null });
    expect(none.held).toEqual([]);
  });
});
