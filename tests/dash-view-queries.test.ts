import { beforeEach, describe, expect, it } from 'vitest';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { migrateOutreachTables } from '../src/outreach/schema.js';
import { migrateSchedulerTables } from '../src/scheduler/runLog.js';
import { jobDetail, jobFacets, listJobs } from '../src/dash/queries/jobs.js';
import { listPeople, personStages, personThread, profileUrl } from '../src/dash/queries/people.js';
import { listSchedulerRuns, operatorLines } from '../src/dash/runlog.js';
import { buildConfigView } from '../src/dash/configView.js';
import type { EnvSpec } from '../src/settings/types.js';
import { ENV_CATALOG } from '../src/settings/envCatalog.js';
import { makeHarness, type Harness } from './helpers/webHarness.js';
import {
  escalationTitle, formatDuration, frameToTerminal, groupEscalations, inventoryMetrics, reconnectDelay, safeExternalUrl, statusTone, type EscLike,
} from '../apps/dashboard/src/lib/view-models.js';

let db: BetterSqlite3.Database;
beforeEach(() => { db = openDb(':memory:'); migrateOutreachTables(db); migrateSchedulerTables(db); });

function job(id: string, source: string, o: { score?: number | null; excluded?: string | null; status?: string | null } = {}) {
  db.prepare('INSERT INTO jobs (id, source, title, company, score, excluded_reason, status) VALUES (?,?,?,?,?,?,?)')
    .run(id, source, `Title ${id}`, `Co ${id}`, o.score === undefined ? 80 : o.score, o.excluded ?? null, o.status ?? null);
}

describe('job filters and facets', () => {
  it('filters by source and by excluded state, and pages with the cursor', () => {
    job('a', 'remotive'); job('b', 'remotive', { excluded: 'location FAIL' }); job('c', 'naukri'); job('d', 'naukri', { score: null });
    expect(listJobs(db, { source: 'naukri' }).items.map((j) => j.id).sort()).toEqual(['c', 'd']);
    expect(listJobs(db, { state: 'excluded' }).items.map((j) => j.id)).toEqual(['b']);
    expect(listJobs(db, { state: 'active' }).items.map((j) => j.id).sort()).toEqual(['a', 'c', 'd']);
    const p1 = listJobs(db, { limit: 2 });
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    const p2 = listJobs(db, { limit: 2, cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(2);
    expect(new Set([...p1.items, ...p2.items].map((j) => j.id)).size).toBe(4);
  });
  it('facets count scored jobs and sources', () => {
    job('a', 'remotive'); job('b', 'remotive'); job('c', 'naukri', { score: null });
    expect(jobFacets(db)).toEqual({ scored: 2, sources: [{ source: 'remotive', count: 2 }, { source: 'naukri', count: 1 }] });
  });
  it('detail carries status and the apply class of the queue row', () => {
    job('a', 'remotive', { status: 'duplicate' });
    db.prepare("INSERT INTO outreach_queue (job_id, status, apply_platform, apply_tier) VALUES ('a','queued','greenhouse','assist')").run();
    const d = jobDetail(db, 'a', 60)!;
    expect(d.status).toBe('duplicate');
    expect(d.queue[0]).toMatchObject({ apply_platform: 'greenhouse', apply_tier: 'assist' });
  });
});

describe('people detail fields', () => {
  it('builds the profile link only for the exact linkedin shape', () => {
    expect(profileUrl('linkedin', 'linkedin.com/in/jane-doe-123')).toBe('https://www.linkedin.com/in/jane-doe-123');
    expect(profileUrl('linkedin', 'evil.com/in/x')).toBeNull();
    expect(profileUrl('naukri', 'linkedin.com/in/x')).toBeNull();
    expect(profileUrl('linkedin', null)).toBeNull();
  });
  it('returns connection status, touch count and stages', () => {
    db.prepare("INSERT INTO people (id, platform, profile_key, name, company, company_key, category) VALUES (1,'linkedin','linkedin.com/in/jane','Jane','Acme','acme','recruiter')").run();
    db.prepare("INSERT INTO contact_state (person_id, stage) VALUES (1,'active')").run();
    db.prepare("INSERT INTO connections (job_id, profile_url, status) VALUES ('j','https://www.linkedin.com/in/jane/','sent')").run();
    db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status) VALUES (1,'connect','k1','sent')").run();
    const p = listPeople(db, {}).items[0];
    expect(p).toMatchObject({ name: 'Jane', connection_status: 'sent', touch_count: 1, stage: 'active', profile_url: 'https://www.linkedin.com/in/jane' });
    expect(personThread(db, 1, {})!.person.profile_url).toBe('https://www.linkedin.com/in/jane');
    expect(personStages(db)).toEqual(['active']);
    expect(Object.keys(p)).not.toContain('profile_key');
  });
});

describe('scheduler run history', () => {
  const run = (id: string, status: string, tasks: unknown, summary = 'RAW MODEL LOG SECRET') =>
    db.prepare('INSERT INTO scheduler_runs (id, planned_at, started_at, trigger, status, tasks, wall_sec, summary) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, '2026-11-01T00:00:00Z', '2026-11-01T00:00:01Z', 'scheduled', status, JSON.stringify(tasks), 90, summary);
  it('lists runs without the raw summary, hides skipped and pages', () => {
    run('r1', 'ok', [{ operator: 'linkedin-operator', platform: 'linkedin', tasks: [{ kind: 'inbox' }, { kind: 'followups' }] }]);
    run('r2', 'skipped', []); run('r3', 'ok', []);
    const all = listSchedulerRuns(db, {})!;
    expect(all.items.map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
    expect(JSON.stringify(all)).not.toContain('RAW MODEL LOG');
    expect(all.items[2].operators).toEqual(['linkedin: inbox, followups']);
    expect(all.statuses).toEqual(expect.arrayContaining([{ status: 'ok', count: 2 }, { status: 'skipped', count: 1 }]));
    expect(listSchedulerRuns(db, { hideSkipped: true })!.items.map((r) => r.id)).toEqual(['r3', 'r1']);
    expect(listSchedulerRuns(db, { status: 'skipped' })!.items.map((r) => r.id)).toEqual(['r2']);
    const p1 = listSchedulerRuns(db, { limit: 2 })!;
    expect(p1.nextCursor).not.toBeNull();
    expect(listSchedulerRuns(db, { limit: 2, cursor: p1.nextCursor })!.items.map((r) => r.id)).toEqual(['r1']);
  });
  it('tolerates a bad task plan and a missing table', () => {
    expect(operatorLines('not json')).toEqual([]);
    expect(operatorLines('{"a":1}')).toEqual([]);
    expect(listSchedulerRuns(openDb(':memory:'), {})).not.toBeNull(); // openDb creates the table
    const bare = new (db.constructor as new (p: string) => BetterSqlite3.Database)(':memory:');
    expect(listSchedulerRuns(bare, {})).toBeNull();
  });
});

describe('config view descriptions', () => {
  it('adds section and about for catalog keys and still masks secrets', () => {
    const secret = ENV_CATALOG.find((s) => s.secret || s.type === 'secret') as EnvSpec;
    const plain = ENV_CATALOG.find((s) => !s.secret && s.type !== 'secret') as EnvSpec;
    const v = buildConfigView({
      root: 'R', env: { [secret.key]: 'FIXTURE-SECRET-77', [plain.key]: '5' }, read: () => null,
      snapshot: { halts: [], ceilings: {} } as never, catalog: [secret, plain],
    });
    const s = v.env.find((e) => e.name === secret.key)!;
    expect(s).toMatchObject({ value: 'set', masked: true, default: null });
    expect(v.env.find((e) => e.name === plain.key)).toMatchObject({ section: plain.section, about: expect.any(String) });
    expect(JSON.stringify(v)).not.toContain('FIXTURE-SECRET');
  });
});

describe('api: new read endpoints', () => {
  let h: Harness | null = null;
  async function authed() {
    h = await makeHarness();
    const { cookie } = await h.login();
    return { h, cookie };
  }
  it('are 401 without a session and validate their filters', async () => {
    const x = await makeHarness(); h = x;
    for (const p of ['/api/jobs/facets', '/api/people/stages', '/api/runs?limit=1']) expect((await x.call('GET', p)).status, p).toBe(401);
    const { cookie } = await x.login();
    expect((await x.call('GET', '/api/jobs?state=bogus', { headers: { cookie } })).status).toBe(400);
    expect((await x.call('GET', '/api/jobs?source=%3Bdrop', { headers: { cookie } })).status).toBe(400);
    expect((await x.call('GET', '/api/jobs?source=remotive&state=active', { headers: { cookie } })).status).toBe(200);
    expect(JSON.parse((await x.call('GET', '/api/jobs/facets', { headers: { cookie } })).body)).toEqual({ scored: 0, sources: [] });
    await x.close(); h = null;
  });
  it('audit pages with nextCursor and returns only safe columns', async () => {
    const { h: x, cookie } = await authed();
    const body = JSON.parse((await x.call('GET', '/api/audit?limit=1', { headers: { cookie } })).body) as { items: Record<string, unknown>[]; nextCursor: number | null };
    expect(body.items).toHaveLength(1);
    expect(Object.keys(body.items[0]).sort()).toEqual(['at', 'id', 'ip', 'kind', 'note']);
    expect(body.nextCursor).toBe(body.items[0].id);
    await x.close(); h = null;
  });
});

describe('dashboard view models', () => {
  it('names every home tile unambiguously', () => {
    const m = inventoryMetrics({ discovered: 327, matched: 157, applied: 41, pending: 116, failed: 0 }, 285, 60);
    expect(m.map((x) => x.label)).toEqual(['Total jobs', 'Scored', 'Matched (score 60+)', 'Applied', 'Awaiting apply', 'Failed']);
    expect(m.find((x) => x.key === 'awaiting')!.hint).toMatch(/queued/);
    expect(new Set(m.map((x) => x.label)).size).toBe(m.length);
  });
  it('groups the inbox in priority order with a meaningful title', () => {
    const base = { id: 1, ids: [1], reason: 'r', todo: '', created_at: 't', excerpt: null, jobTitle: null, personCompany: null, senderName: null, personName: null, platform: 'linkedin' };
    const items: EscLike[] = [
      { ...base, id: 3, group: 'noise', label: 'Flagged by the injection screen' },
      { ...base, id: 2, group: 'platform', label: 'Platform problem' },
      { ...base, id: 1, group: 'human', label: 'Recruiter inquiry', senderName: 'Jane Roe', personCompany: 'Acme' },
    ];
    const g = groupEscalations(items);
    expect(g.map((x) => x.key)).toEqual(['human', 'platform', 'noise']);
    expect(escalationTitle(items[2])).toBe('Jane Roe at Acme');
    expect(escalationTitle(items[1])).toBe('Platform problem');
  });
  it('formats durations, links, tones and frames', () => {
    expect(formatDuration(45)).toBe('45s'); expect(formatDuration(125)).toBe('2m 5s'); expect(formatDuration(null)).toBe('n/a');
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull(); expect(safeExternalUrl('https://example.test/a')).toBe('https://example.test/a');
    expect(statusTone('sent')).toBe('good'); expect(statusTone('failed')).toBe('bad'); expect(statusTone('queued')).toBe('warn');
    const f = frameToTerminal({ cols: 80, rows: 24, cx: 2, cy: 1, text: 'a\nb\n' });
    expect(f.startsWith('\x1b[2J\x1b[H')).toBe(true); expect(f).toContain('a\x1b[0m\r\nb'); expect(f.endsWith('\x1b[2;3H')).toBe(true);
    expect(reconnectDelay(0)).toBe(1000); expect(reconnectDelay(10)).toBe(15000);
  });
});
