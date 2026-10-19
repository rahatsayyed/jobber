import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { haltPlatform } from '../src/outreach/limits.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { gateOutbound } from '../src/safety/outputGate.js';
import { profileKeyOf } from '../src/linkedin/urls.js';
import { personByProfileKey, pauseContact } from '../src/linkedin/touches.js';
import { loadLinkedinConfig, effectiveDryRun } from '../src/linkedin/config.js';
import { preSendGuard, outputGateContext, type GuardInput } from '../src/linkedin/guard.js';

const URL1 = 'https://www.linkedin.com/in/jane-doe';
const OK_TIME = new Date('2026-10-14T06:00:00Z'); // 11:30 IST
const QUIET_TIME = new Date('2026-10-14T22:00:00Z'); // 03:30 IST
const wrongUrl = 'https://www.linkedin.com/in/someone-else';
let db: ReturnType<typeof openDb>;
let pid: number;
const touchCount = () => (db.prepare('SELECT COUNT(*) AS n FROM touches').get() as { n: number }).n;

const pass = (t: string) => ({ verdict: 'pass' as const, normalized_text: t });

function input(over: Partial<GuardInput> = {}): GuardInput {
  return {
    db, now: OK_TIME, env: {}, action: 'invite', kind: 'connect', profileUrl: URL1,
    text: 'Hi Jane, I saw the platform team is hiring and would like to connect.',
    factCheck: (t) => pass(t), styleCfg: DEFAULT_STYLE_CONFIG,
    cfg: loadLinkedinConfig({ LINKEDIN_DRY_RUN: 'false', SCHEDULER_DRY_RUN: 'false' }), ...over,
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  pid = upsertPerson(db, { platform: 'linkedin', profileKey: profileKeyOf(URL1), name: 'Jane Doe', headline: 'Technical Recruiter at Acme', company: 'Acme', category: 'recruiter' });
});

describe('preSendGuard', () => {
  it('happy path reserves a sending touch', () => {
    const r = preSendGuard(input());
    expect(r.ok).toBe(true);
    const row = db.prepare('SELECT status FROM touches').get() as { status: string };
    expect(row.status).toBe('sending');
  });

  it('dry run reserves a dry_run touch', () => {
    const r = preSendGuard(input({ cfg: loadLinkedinConfig({}) }));
    expect(r).toMatchObject({ ok: true, dryRun: true });
    expect((db.prepare('SELECT status FROM touches').get() as any).status).toBe('dry_run');
  });

  it('callDryRun forces dry run on', () => {
    expect(preSendGuard(input({ callDryRun: true }))).toMatchObject({ ok: true, dryRun: true });
  });

  const refusals: Array<[string, string, () => Partial<GuardInput>, () => void]> = [
    ['halted', 'halted', () => ({}), () => haltPlatform(db, 'linkedin', 'captcha', OK_TIME)],
    ['quiet_hours', 'refused', () => ({ now: QUIET_TIME }), () => {}],
    ['bad_url', 'refused', () => ({ profileUrl: 'https://evil.test/in/jane-doe' }), () => {}],
    ['bad_url', 'refused', () => ({ profileUrl: 'https://www.linkedin.com/feed/' }), () => {}],
    ['unknown_recipient', 'refused', () => ({ profileUrl: wrongUrl }), () => {}],
    ['recipient_name_unknown', 'refused', () => ({}), () => {
      db.prepare('UPDATE people SET name = NULL WHERE id = ?').run(pid);
    }],
    ['contact_paused', 'refused', () => ({}), () => pauseContact(db, pid, 'manual', OK_TIME)],
    ['contact_paused', 'refused', () => ({}), () => {
      db.prepare("UPDATE contact_state SET stage = 'closed' WHERE person_id = ?").run(pid);
    }],
    ['contact_paused', 'refused', () => ({}), () => {
      const other = upsertPerson(db, { platform: 'linkedin', profileKey: profileKeyOf(wrongUrl), name: 'Bob', company: 'Acme Inc', category: 'peer' });
      db.prepare("UPDATE contact_state SET stage = 'replied_positive' WHERE person_id = ?").run(other);
    }],
    ['empty_text', 'refused', () => ({ text: '   ' }), () => {}],
    ['note_too_long', 'refused', () => ({ text: 'a'.repeat(301) }), () => {}],
    ['message_too_long', 'refused', () => ({ action: 'message' as const, kind: 'rapport' as const, text: 'a'.repeat(1801) }), () => {}],
    ['note_too_long', 'refused', () => ({ factCheck: () => ({ verdict: 'pass' as const, normalized_text: 'a'.repeat(301) }) }), () => {}],
    ['message_too_long', 'refused', () => ({ action: 'message' as const, kind: 'rapport' as const, factCheck: () => ({ verdict: 'pass' as const, normalized_text: 'a'.repeat(1801) }) }), () => {}],
    ['style_gate', 'refused', () => ({ text: 'Hi Jane — happy to connect' }), () => {}],
    ['fact_gate_block', 'refused', () => ({ factCheck: () => ({ verdict: 'block' as const, normalized_text: 'x' }) }), () => {}],
    ['fact_gate_error', 'refused', () => ({ factCheck: () => { throw new Error('no base'); } }), () => {}],
    ['output_gate_text', 'refused', () => ({ text: 'Hi Jane, write to jobs@evil.test about it.' }), () => {}],
  ];
  it.each(refusals)('refuses with %s and creates no touch', (code, status, over, setup) => {
    setup();
    const r = preSendGuard(input(over()));
    expect(r).toMatchObject({ ok: false, status, code });
    expect(touchCount()).toBe(0);
  });

  it('style failure never invokes the fact gate and names rules only', () => {
    const spy = vi.fn((t: string) => pass(t));
    const r = preSendGuard(input({ text: 'Hi Jane — happy to connect', factCheck: spy }));
    expect(spy).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, code: 'style_gate' });
    expect((r as any).reason).not.toContain('happy');
  });

  it('email is refused unless allowlisted', () => {
    const text = 'Hi Jane, write to jobs@evil.test about it.';
    const r = preSendGuard(input({ text }));
    expect((r as any).reason).toContain('email_not_allowed');
    const ok = preSendGuard(input({ text, cfg: loadLinkedinConfig({ LINKEDIN_DRY_RUN: 'false', SCHEDULER_DRY_RUN: 'false', LINKEDIN_ALLOWED_EMAILS: 'jobs@evil.test' }) }));
    expect(ok.ok).toBe(true);
  });

  it('env secret value in the draft is refused', () => {
    const r = preSendGuard(input({
      text: 'Hi Jane, code sk-test-secret-value-1234 here.',
      env: { FAKE_API_KEY: 'sk-test-secret-value-1234' },
    }));
    expect((r as any).reason).toContain('env_secret_value');
    expect(touchCount()).toBe(0);
  });

  it('uses normalized text from the fact gate', () => {
    const r = preSendGuard(input({ factCheck: () => pass('Hi Jane, normalized.') }));
    expect(r).toMatchObject({ ok: true, text: 'Hi Jane, normalized.' });
  });

  it('second identical live call is in_progress, then maps already_sent', () => {
    expect(preSendGuard(input()).ok).toBe(true);
    expect(preSendGuard(input())).toMatchObject({ ok: false, status: 'refused', code: 'in_progress' });
    db.prepare("UPDATE touches SET status = 'sent'").run();
    expect(preSendGuard(input())).toMatchObject({ ok: false, code: 'already_sent' });
  });

  it('duplicate connect with different text maps duplicate_kind', () => {
    expect(preSendGuard(input()).ok).toBe(true);
    expect(preSendGuard(input({ text: 'Hello Jane, another note.' }))).toMatchObject({ ok: false, code: 'duplicate_kind' });
  });

  it('does not consume rate ceilings', () => {
    preSendGuard(input());
    expect((db.prepare('SELECT COUNT(*) AS n FROM rate_events').get() as { n: number }).n).toBe(0);
  });
});

describe('outputGateContext', () => {
  const person = () => personByProfileKey(db, profileKeyOf(URL1))!;
  const page = 'we shipped the billing migration with Jane and her team across three regions for the payments platform';
  const cfg = loadLinkedinConfig({});

  it('flags a long run copied from the page', () => {
    const p = person();
    const ctx = outputGateContext({ person: p, actualProfileUrl: URL1, rawPageText: page, cfg, env: {}, factVerdict: 'pass' });
    const r = gateOutbound('we shipped the billing migration with Jane and her team across three regions for the payments platform', ctx);
    expect(r.reasons).toContain('copied_from_page');
  });

  it('exempts the recipient first name', () => {
    const p = person();
    const ctx = outputGateContext({ person: p, actualProfileUrl: URL1, rawPageText: page, cfg, env: {}, factVerdict: 'pass' });
    expect(ctx.allowedPhrases).toContain('Jane');
    // only run that matches the page does so through the first name
    const r = gateOutbound('Hi Jane, we shipped the billing migration with them and across three regions for the payments platform', ctx);
    expect(r.reasons).not.toContain('copied_from_page');
  });

  it('detects a recipient mismatch from the live page URL', () => {
    const ctx = outputGateContext({ person: person(), actualProfileUrl: wrongUrl, rawPageText: '', cfg, env: {}, factVerdict: 'pass' });
    expect(gateOutbound('hello', ctx).reasons).toContain('recipient_mismatch');
  });
});

describe('loadLinkedinConfig', () => {
  it('defaults are dry run on', () => {
    const c = loadLinkedinConfig({});
    expect(c).toMatchObject({ dryRun: true, acceptUnknown: false, maxAcceptsPerDay: 30, idleMs: 600000, settleMs: 2500 });
    expect(c.allowedUrls).toEqual([]);
  });
  it('only exact false turns dry run off', () => {
    expect(loadLinkedinConfig({ LINKEDIN_DRY_RUN: 'false', SCHEDULER_DRY_RUN: 'false' }).dryRun).toBe(false);
    for (const v of ['False', '0', '', 'no', ' false']) expect(loadLinkedinConfig({ LINKEDIN_DRY_RUN: v }).dryRun).toBe(true);
  });
  it('clamps and parses', () => {
    expect(loadLinkedinConfig({ LINKEDIN_MAX_ACCEPTS_PER_DAY: '1001' }).maxAcceptsPerDay).toBe(30);
    expect(loadLinkedinConfig({ LINKEDIN_MAX_ACCEPTS_PER_DAY: '-1' }).maxAcceptsPerDay).toBe(30);
    expect(loadLinkedinConfig({ LINKEDIN_MAX_ACCEPTS_PER_DAY: '1.5' }).maxAcceptsPerDay).toBe(30);
    expect(loadLinkedinConfig({ LINKEDIN_MAX_ACCEPTS_PER_DAY: '0' }).maxAcceptsPerDay).toBe(0);
    expect(loadLinkedinConfig({ LINKEDIN_IDLE_MS: '5' }).idleMs).toBe(60000);
    expect(loadLinkedinConfig({ LINKEDIN_IDLE_MS: '99999999' }).idleMs).toBe(3600000);
    expect(loadLinkedinConfig({ LINKEDIN_ACCEPT_UNKNOWN: 'true' }).acceptUnknown).toBe(true);
    expect(loadLinkedinConfig({ LINKEDIN_ALLOWED_EMAILS: ' a@b.co, ,c@d.io' }).allowedEmails).toEqual(['a@b.co', 'c@d.io']);
  });
  it('call flag can only force dry run on', () => {
    const off = loadLinkedinConfig({ LINKEDIN_DRY_RUN: 'false', SCHEDULER_DRY_RUN: 'false' });
    expect(effectiveDryRun(off, true)).toBe(true);
    expect(effectiveDryRun(off, false)).toBe(false);
    expect(effectiveDryRun(off)).toBe(false);
    expect(effectiveDryRun(loadLinkedinConfig({}), false)).toBe(true);
  });
});
