import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLayoutObserver } from '../src/layout/runtime.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { ID_RE } from '../src/layout/vocab.js';
import { openDb } from '../src/db.js';
import { haltPlatform, haltReason } from '../src/outreach/limits.js';
import { listOpenEscalations } from '../src/outreach/service.js';
import type { RawSnapshot } from '../src/linkedin/types.js';
import type { Notice } from '../src/scheduler/notify.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'layout-esc-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

const cfg = () => ({ ...loadLayoutConfig({}), dir });
const NOW = new Date('2026-10-14T10:00:00.000Z');

function snap(over: Partial<RawSnapshot['profile']> = {}, top: Partial<RawSnapshot> = {}): RawSnapshot {
  return {
    url: 'https://www.linkedin.com/in/some-person/', title: 'Some Person | LinkedIn',
    profile: {
      name: 'Some Person', headline: 'Engineer', degree: '2nd', location: 'Here', about: null,
      actions: ['Connect', 'More'], pending: false, hasBell: false, hasMessageButton: false, ...over,
    },
    results: [], invitations: [], messages: [], messageHeaderName: null, notices: [], dialogText: null,
    hasPasswordInput: false, bodyText: 'x'.repeat(500), ...top,
  };
}

function setup() {
  const db = openDb(':memory:');
  const notices: Notice[] = [];
  const mk = (runId: string) => createLayoutObserver({
    platform: 'linkedin', cfg: cfg(), now: () => NOW, runId, db,
    notify: (n) => { notices.push(n); },
  });
  // promote the profile kind over two runs
  const a = mk('run-a'); const b = mk('run-b');
  a.observe(snap(), null); a.observe(snap(), null); b.observe(snap(), null);
  return { db, notices, mk };
}
const drift = () => snap({ name: '' });

describe('layout drift side effects', () => {
  it('escalates once at the threshold, with vocabulary-only detail and a fixed notice', () => {
    const { db, notices, mk } = setup();
    const o = mk('run-c');
    for (let i = 0; i < 3; i++) expect(o.observe(drift(), null).class).toBe('drift');
    const esc = listOpenEscalations(db, 20);
    expect(esc).toHaveLength(1);
    expect(esc[0]).toMatchObject({ platform: 'linkedin', reason: 'layout_drift' });
    expect(esc[0].detail).toBe('kind=profile streak=3 missing=profile.name');
    for (const tok of esc[0].detail!.split(/[ =,]/).filter(Boolean)) expect(ID_RE.test(tok) || /^\d+$/.test(tok)).toBe(true);
    expect(haltReason(db, 'linkedin')).toBeNull();
    expect(notices).toHaveLength(1);
    expect(notices[0].level).toBe('warn');
    // a 4th drift does not escalate again
    o.observe(drift(), null);
    expect(listOpenEscalations(db, 20)).toHaveLength(1);
    expect(notices).toHaveLength(1);
  });

  it('one run never halts, however many drifts; the streak reset on match clears escalation state', () => {
    const { db, mk } = setup();
    const o = mk('run-c');
    for (let i = 0; i < 8; i++) o.observe(drift(), null);
    expect(haltReason(db, 'linkedin')).toBeNull();
    expect(listOpenEscalations(db, 20).map((e) => e.reason)).toEqual(['layout_drift']);
    expect(o.observe(snap(), null).class).toBe('match'); // resets the streak
    for (let i = 0; i < 3; i++) o.observe(drift(), null);
    expect(listOpenEscalations(db, 20).map((e) => e.reason)).toEqual(['layout_drift', 'layout_drift']);
  });

  it('does not overwrite another halt reason or an all halt', () => {
    for (const [plat, reason] of [['linkedin', 'checkpoint'], ['all', 'stop: owner']] as const) {
      const { db, mk } = setup();
      haltPlatform(db, plat, reason, NOW);
      const a = mk('run-c'); const b = mk('run-d');
      for (let i = 0; i < 3; i++) a.observe(drift(), null);
      for (let i = 0; i < 3; i++) b.observe(drift(), null);
      expect(haltReason(db, plat)).toBe(reason);
      expect(listOpenEscalations(db, 20).map((e) => e.reason)).toEqual(['layout_drift']);
    }
  });

  it('halts at the halt threshold with the expected reason, once', () => {
    const { db, notices, mk } = setup();
    const o = mk('run-c');
    const o2 = mk('run-d');
    for (let i = 0; i < 3; i++) o.observe(drift(), null);
    for (let i = 0; i < 2; i++) o2.observe(drift(), null);
    expect(haltReason(db, 'linkedin')).toBe('layout_drift:profile');
    const reasons = listOpenEscalations(db, 20).map((e) => e.reason);
    expect(reasons).toEqual(['layout_drift', 'layout_drift_halt']);
    expect(notices.map((n) => n.level)).toEqual(['warn', 'halt']);
    // already halted: further drift adds nothing
    o.observe(drift(), null);
    expect(listOpenEscalations(db, 20)).toHaveLength(2);
    expect(notices).toHaveLength(2);
  });

  it('does nothing for blocked, logged out and unloaded pages', () => {
    const { db, notices, mk } = setup();
    const o = mk('run-c');
    for (let i = 0; i < 8; i++) {
      o.observe(drift(), 'checkpoint' as never);
      o.observe(snap({}, { hasPasswordInput: true, url: 'https://www.linkedin.com/login' }), null);
      o.observe(snap({ name: '' }, { bodyText: 'x' }), null);
    }
    expect(listOpenEscalations(db, 20)).toHaveLength(0);
    expect(haltReason(db, 'linkedin')).toBeNull();
    expect(notices).toHaveLength(0);
  });

  it('swallows errors from the db and notifier and still forwards onEvent', () => {
    const { db } = setup();
    const events: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const o = createLayoutObserver({
      platform: 'linkedin', cfg: cfg(), now: () => NOW, runId: 'run-c', db,
      notify: () => { throw new Error('boom'); }, onEvent: (e) => events.push(e.event),
    });
    db.exec('DROP TABLE escalations');
    for (let i = 0; i < 3; i++) o.observe(drift(), null);
    const o2 = createLayoutObserver({
      platform: 'linkedin', cfg: cfg(), now: () => NOW, runId: 'run-d', db,
      notify: () => { throw new Error('boom'); }, onEvent: (e) => events.push(e.event),
    });
    for (let i = 0; i < 2; i++) o2.observe(drift(), null);
    expect(events).toContain('drift_escalate');
    expect(events).toContain('drift_halt');
    expect(haltReason(db, 'linkedin')).toBe('layout_drift:profile');
  });

  it('records nothing without a db', () => {
    const notices: Notice[] = [];
    const o = createLayoutObserver({
      platform: 'linkedin', cfg: cfg(), now: () => NOW, runId: 'run-c',
      notify: (n) => { notices.push(n); },
    });
    for (let i = 0; i < 5; i++) o.observe(drift(), null);
    expect(notices).toHaveLength(0);
  });
});
