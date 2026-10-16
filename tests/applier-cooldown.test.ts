import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import {
  BOT_WALL_HALT_REASON, cooldownDays, cooledHosts, hostCooledDown, recordHostBlock,
} from '../src/applier/cooldown.js';
import { createEscalationSink } from '../src/applier/escalate.js';
import { handleOpen } from '../src/applier/tools/open.js';
import { clearApplyHalt, activeApplyHalt } from '../src/scheduler/control.js';
import { haltReason } from '../src/outreach/limits.js';
import { makeApplier, HOST, type ApplierHarness } from './helpers/applierHarness.js';

const DAY = 86_400_000;
const T0 = new Date('2026-10-10T10:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);

describe('host cooldown', () => {
  it('two blocks in 7 days start the cooldown', () => {
    const db = openDb(':memory:');
    expect(recordHostBlock(db, 'jobs.example.com', 'captcha', at(0), 'r1', {}).cooldown).toBe(false);
    expect(hostCooledDown(db, 'jobs.example.com', {}, at(1))).toBe(false);
    expect(recordHostBlock(db, 'jobs.example.com', 'mfa', at(3), 'r1', {}).cooldown).toBe(true);
    expect(hostCooledDown(db, 'jobs.example.com', {}, at(5))).toBe(true);
    expect(cooledHosts(db, {}, at(5))).toEqual(['jobs.example.com']);
    // another host is untouched
    expect(hostCooledDown(db, 'other.example.com', {}, at(5))).toBe(false);
  });

  it('blocks more than 7 days apart do not start it, and the cooldown ends after APPLY_HOST_COOLDOWN_DAYS', () => {
    const db = openDb(':memory:');
    recordHostBlock(db, 'a.example.com', 'captcha', at(0), 'r1', {});
    expect(recordHostBlock(db, 'a.example.com', 'captcha', at(8), 'r2', {}).cooldown).toBe(false);
    recordHostBlock(db, 'b.example.com', 'captcha', at(0), 'r1', {});
    recordHostBlock(db, 'b.example.com', 'captcha', at(1), 'r1', {});
    expect(hostCooledDown(db, 'b.example.com', {}, at(7.5))).toBe(true);
    expect(hostCooledDown(db, 'b.example.com', {}, at(8.5))).toBe(false);
    expect(hostCooledDown(db, 'b.example.com', { APPLY_HOST_COOLDOWN_DAYS: '2' }, at(3.5))).toBe(false);
    expect(cooldownDays({ APPLY_HOST_COOLDOWN_DAYS: '500' })).toBe(90);
    expect(cooldownDays({ APPLY_HOST_COOLDOWN_DAYS: 'x' })).toBe(7);
  });

  it('the same block reported twice in a minute counts once', () => {
    const db = openDb(':memory:');
    recordHostBlock(db, 'a.example.com', 'captcha', at(0), 'r1', {});
    const again = recordHostBlock(db, 'a.example.com', 'captcha', new Date(at(0).getTime() + 5000), 'r1', {});
    expect(again.recorded).toBe(false);
    expect(again.cooldown).toBe(false);
  });

  it('apply_open refuses a cooling host before any browser use', async () => {
    const h: ApplierHarness = makeApplier();
    try {
      recordHostBlock(h.db, HOST, 'captcha', new Date(Date.now() - 2 * DAY), 'r0', h.env);
      recordHostBlock(h.db, HOST, 'mfa', new Date(Date.now() - DAY), 'r0', h.env);
      const r = await handleOpen({ job_id: 'job-1' }, h.deps);
      expect(r).toMatchObject({ status: 'refused', code: 'host_cooldown' });
      expect(h.site.events.length).toBe(0);
    } finally { await h.close(); }
  });

  it('the escalation sink persists a block reported by a tool', () => {
    const db = openDb(':memory:');
    const notices: unknown[] = [];
    const sink = createEscalationSink({ db, env: {} }, { runId: 'r1', notify: (n) => { notices.push(n); } });
    sink('block', 'captcha on boards.example.com');
    sink('layout_drift', 'greenhouse form');
    expect(db.prepare('SELECT COUNT(*) AS n FROM apply_host_blocks WHERE host = ? AND kind = ?').get('boards.example.com', 'captcha')).toEqual({ n: 1 });
    expect(notices.length).toBe(2);
    sink('block', 'not a valid detail ../etc');
    expect(db.prepare('SELECT COUNT(*) AS n FROM apply_host_blocks').get()).toEqual({ n: 1 });
  });
});

describe('bot_wall halt', () => {
  it('bot_wall halt needs two run ids', () => {
    const db = openDb(':memory:');
    for (const [i, h] of ['a.example.com', 'b.example.com', 'c.example.com'].entries()) {
      recordHostBlock(db, h, 'bot_wall', at(i), 'same-run', {});
    }
    expect(haltReason(db, 'apply')).toBeNull();
    // a fourth in a second run: the newest three span two run ids
    expect(recordHostBlock(db, 'd.example.com', 'bot_wall', at(4), 'run-2', {}).halted).toBe(true);
    expect(haltReason(db, 'apply')).toBe(BOT_WALL_HALT_REASON);
  });

  it('a different block kind breaks the streak', () => {
    const db = openDb(':memory:');
    recordHostBlock(db, 'a.example.com', 'bot_wall', at(0), 'r1', {});
    recordHostBlock(db, 'b.example.com', 'captcha', at(1), 'r2', {});
    recordHostBlock(db, 'c.example.com', 'bot_wall', at(2), 'r3', {});
    recordHostBlock(db, 'd.example.com', 'bot_wall', at(3), 'r4', {});
    expect(haltReason(db, 'apply')).toBeNull();
  });

  it('the owner clears the apply halt through jobber:control and only that halt', () => {
    const db = openDb(':memory:');
    recordHostBlock(db, 'a.example.com', 'bot_wall', at(0), 'r1', {});
    recordHostBlock(db, 'b.example.com', 'bot_wall', at(1), 'r1', {});
    recordHostBlock(db, 'c.example.com', 'bot_wall', at(2), 'r2', {});
    expect(activeApplyHalt(db)).toBe(BOT_WALL_HALT_REASON);
    const r = clearApplyHalt(db, at(3));
    expect(r.cleared).toBe(BOT_WALL_HALT_REASON);
    expect(activeApplyHalt(db)).toBeNull();
    expect(clearApplyHalt(db, at(3)).cleared).toBeNull();
    // the streak is forgotten: one more bot_wall does not re-halt at once
    expect(recordHostBlock(db, 'd.example.com', 'bot_wall', at(4), 'r3', {}).halted).toBe(false);
  });
});

afterEach(() => undefined);
