// tests/settings-policy.test.ts
// Friction policy by tier x direction, remote exposure, phrase rules and preflight (plan 8H, Task 6). Hermetic.
import { describe, expect, it } from 'vitest';
import { etagOf } from '../src/settings/atomic.js';
import { type EnvState, type ResolvedChange, planEnvChange } from '../src/settings/envEdit.js';
import { frictionFor, phraseFor, phraseMatches, preflight, requiredFriction } from '../src/settings/policy.js';
import type { ChangeOp, EnvSpec, PolicyCtx } from '../src/settings/types.js';
import { FIXTURE_CATALOG } from './fixtures/settings/catalog.fixture.js';

const CTX: PolicyCtx = { editEnabled: true, remoteExposure: false, remoteSafetyAllowed: false, sessionFresh: false };
const spec = (key: string): EnvSpec => {
  const s = FIXTURE_CATALOG.find((x) => x.key === key);
  if (!s) throw new Error(`no fixture ${key}`);
  return s;
};
const ch = (key: string, before: string | null, after: string | null): ResolvedChange => ({
  op: after === null ? { key, op: 'clear' } : { key, op: 'set', value: after },
  spec: spec(key),
  before,
  after,
});
const D = 'DRY RUN' as const;
const L = 'LIVE' as const;

// safety weakening: FX_DRY_RUN true -> false ; safety strengthening: false -> true
const safetyWeak = () => ch('FX_DRY_RUN', 'true', 'false');
const safetyStrong = () => ch('FX_DRY_RUN', 'false', 'true');
// guarded: FX_MAX_PER_DAY increase weakens
const guardedWeak = () => ch('FX_MAX_PER_DAY', '5', '9');
const guardedStrong = () => ch('FX_MAX_PER_DAY', '9', '5');
const normal = () => ch('FX_PORT', '8787', '9000');

describe('requiredFriction table', () => {
  it('edit disabled refuses settings_disabled for any tier', () => {
    for (const c of [safetyWeak(), guardedWeak(), normal(), ch('FX_KILL', 'false', 'true')]) {
      expect(requiredFriction([c], { ...CTX, editEnabled: false }).refuse).toBe('settings_disabled');
    }
    expect(requiredFriction([], { ...CTX, editEnabled: false }).refuse).toBe('settings_disabled');
  });
  it('disabled wins over never and remote exposure', () => {
    const f = requiredFriction([ch('FX_KILL', 'false', 'true'), safetyWeak()], { ...CTX, editEnabled: false, remoteExposure: true });
    expect(f.refuse).toBe('settings_disabled');
  });
  it('never tier refuses tier_never', () => {
    expect(requiredFriction([ch('FX_KILL', 'false', 'true')], CTX).refuse).toBe('tier_never');
  });
  it('safety weakening with remote exposure and no override refuses remote_exposure', () => {
    expect(requiredFriction([safetyWeak()], { ...CTX, remoteExposure: true }).refuse).toBe('remote_exposure');
  });
  it('safety weakening with remote exposure and the override needs reauth and phrase', () => {
    const f = requiredFriction([safetyWeak()], { ...CTX, remoteExposure: true, remoteSafetyAllowed: true });
    expect(f).toEqual({ reauth: true, phrase: 'CHANGE FX_DRY_RUN' });
  });
  it('safety weakening locally needs reauth and phrase', () => {
    expect(requiredFriction([safetyWeak()], CTX)).toEqual({ reauth: true, phrase: 'CHANGE FX_DRY_RUN' });
  });
  it('safety strengthening needs nothing, even when exposed', () => {
    expect(requiredFriction([safetyStrong()], CTX)).toEqual({ reauth: false, phrase: null });
    expect(requiredFriction([safetyStrong()], { ...CTX, remoteExposure: true })).toEqual({ reauth: false, phrase: null });
  });
  it('guarded weakening needs reauth only, also when exposed', () => {
    expect(requiredFriction([guardedWeak()], CTX)).toEqual({ reauth: true, phrase: null });
    expect(requiredFriction([guardedWeak()], { ...CTX, remoteExposure: true })).toEqual({ reauth: true, phrase: null });
  });
  it('guarded strengthening and normal need nothing', () => {
    expect(requiredFriction([guardedStrong()], CTX)).toEqual({ reauth: false, phrase: null });
    expect(requiredFriction([normal()], CTX)).toEqual({ reauth: false, phrase: null });
  });
  it('secrets take the tier of the key: normal needs nothing, guarded clear needs reauth', () => {
    expect(requiredFriction([ch('FX_API_KEY', null, 'FIXTURE-SECRET-1')], CTX)).toEqual({ reauth: false, phrase: null });
    expect(requiredFriction([ch('FX_API_KEY', 'FIXTURE-SECRET-1', null)], CTX)).toEqual({ reauth: false, phrase: null });
    expect(requiredFriction([ch('FX_BOT_TOKEN', 'FIXTURE-SECRET-2', 'FIXTURE-SECRET-3')], CTX)).toEqual({ reauth: false, phrase: null });
    expect(requiredFriction([ch('FX_BOT_TOKEN', 'FIXTURE-SECRET-2', null)], CTX)).toEqual({ reauth: true, phrase: null });
  });
  it('a key with weakens null never reaches reauth', () => {
    const s: EnvSpec = { ...spec('FX_MAX_PER_DAY'), weakens: null };
    const f = requiredFriction([{ op: { key: s.key, op: 'set', value: '99' }, spec: s, before: '5', after: '99' }], CTX);
    expect(f).toEqual({ reauth: false, phrase: null });
  });
  it('the result has no session field', () => {
    expect(Object.keys(requiredFriction([safetyWeak()], { ...CTX, sessionFresh: true })).sort()).toEqual(['phrase', 'reauth']);
    expect(requiredFriction([guardedWeak()], { ...CTX, sessionFresh: true })).toEqual(requiredFriction([guardedWeak()], { ...CTX, sessionFresh: false }));
  });
});

describe('multi-change sets', () => {
  it('strictest wins', () => {
    expect(requiredFriction([normal(), guardedWeak()], CTX)).toEqual({ reauth: true, phrase: null });
    expect(requiredFriction([guardedWeak(), safetyWeak()], CTX)).toEqual({ reauth: true, phrase: 'CHANGE FX_DRY_RUN' });
    expect(requiredFriction([safetyStrong(), normal()], CTX)).toEqual({ reauth: false, phrase: null });
  });
  it('a refusal anywhere refuses the whole set', () => {
    expect(requiredFriction([normal(), safetyWeak()], { ...CTX, remoteExposure: true }).refuse).toBe('remote_exposure');
    expect(requiredFriction([normal(), guardedWeak(), ch('FX_KILL', 'false', 'true')], CTX).refuse).toBe('tier_never');
  });
  it('remote exposure does not refuse a set that only strengthens safety keys', () => {
    expect(requiredFriction([safetyStrong(), guardedWeak()], { ...CTX, remoteExposure: true })).toEqual({ reauth: true, phrase: null });
  });
});

describe('direction', () => {
  it('1 to 0 weakens, 0 to 1 strengthens', () => {
    const s: EnvSpec = { ...spec('FX_ZERO_ONE'), tier: 'safety', weakens: 'true', default: '1' };
    const mk = (b: string, a: string): ResolvedChange => ({ op: { key: s.key, op: 'set', value: a }, spec: s, before: b, after: a });
    // weakens 'true': value turning on is the loosening direction
    expect(requiredFriction([mk('0', '1')], CTX).reauth).toBe(true);
    expect(requiredFriction([mk('1', '0')], CTX).reauth).toBe(false);
    const dry: EnvSpec = { ...s, weakens: 'false' };
    const mk2 = (b: string, a: string): ResolvedChange => ({ op: { key: dry.key, op: 'set', value: a }, spec: dry, before: b, after: a });
    expect(requiredFriction([mk2('1', '0')], CTX).reauth).toBe(true);
    expect(requiredFriction([mk2('0', '1')], CTX).reauth).toBe(false);
  });
  it('layout enforce to warn weakens (any change on the guarded key)', () => {
    expect(requiredFriction([ch('FX_LAYOUT_ENFORCE', 'enforce', 'warn')], CTX).reauth).toBe(true);
  });
  it('MATCH_THRESHOLD style decrease: 60 to 50 weakens, 60 to 70 does not', () => {
    const s: EnvSpec = { ...spec('FX_MIN_GAP'), key: 'MATCH_THRESHOLD', tier: 'guarded', weakens: 'decrease' };
    const mk = (b: string, a: string): ResolvedChange => ({ op: { key: s.key, op: 'set', value: a }, spec: s, before: b, after: a });
    expect(requiredFriction([mk('60', '50')], CTX).reauth).toBe(true);
    expect(requiredFriction([mk('60', '70')], CTX).reauth).toBe(false);
  });
});

describe('phraseFor', () => {
  it('GO LIVE when the file mode flips DRY RUN to LIVE, even with several flags', () => {
    const three = [ch('FX_DRY_RUN', 'true', 'false'), ch('FX_ENABLE_SEND', 'false', 'true'), ch('FX_ONE_ONLY', null, '1')];
    expect(phraseFor(three, D, L)).toBe('GO LIVE');
  });
  it('a lone flag flip that leaves the file mode dry yields CHANGE <KEY>', () => {
    expect(phraseFor([safetyWeak()], D, D)).toBe('CHANGE FX_DRY_RUN');
  });
  it('LIVE to LIVE or LIVE to DRY RUN is never GO LIVE', () => {
    expect(phraseFor([safetyWeak()], L, L)).toBe('CHANGE FX_DRY_RUN');
    expect(phraseFor([safetyStrong()], L, D)).toBeNull();
  });
  it('several safety weakenings give CHANGE <N> SAFETY SETTINGS; strengthening ones are not counted', () => {
    const cs = [safetyWeak(), ch('FX_ENABLE_SEND', 'false', 'true'), ch('FX_ALLOWED_URLS', 'a', 'b'), safetyStrong()];
    expect(phraseFor(cs, D, D)).toBe('CHANGE 3 SAFETY SETTINGS');
  });
  it('null when nothing safety weakens', () => {
    expect(phraseFor([guardedWeak(), normal()], D, D)).toBeNull();
  });
  it('frictionFor passes the modes through', () => {
    expect(frictionFor({ changes: [safetyWeak()], modeBefore: D, modeAfter: L }, CTX)).toEqual({ reauth: true, phrase: 'GO LIVE' });
    expect(frictionFor({ changes: [safetyWeak()], modeBefore: D, modeAfter: D }, CTX).phrase).toBe('CHANGE FX_DRY_RUN');
  });
});

describe('phraseMatches', () => {
  it('trimmed, case-sensitive, exact', () => {
    expect(phraseMatches('  GO LIVE \n', 'GO LIVE')).toBe(true);
    expect(phraseMatches('go live', 'GO LIVE')).toBe(false);
    expect(phraseMatches('GO LIVE NOW', 'GO LIVE')).toBe(false);
    expect(phraseMatches('GO', 'GO LIVE')).toBe(false);
    expect(phraseMatches('', null)).toBe(false);
    expect(phraseMatches(undefined, 'GO LIVE')).toBe(false);
  });
});

describe('default wiring in planEnvChange', () => {
  const dry = (key: string): EnvSpec => ({ ...spec('FX_DRY_RUN'), key, allowed: ['0', '1', 'true', 'false'] });
  const catalog = [...FIXTURE_CATALOG, dry('JOBBER_DRY_RUN'), dry('SCHEDULER_DRY_RUN'), dry('LINKEDIN_DRY_RUN')];
  const text = 'JOBBER_DRY_RUN=1\nSCHEDULER_DRY_RUN=true\nLINKEDIN_DRY_RUN=true\n';
  const st: EnvState = { text, etag: etagOf(text), exists: true };
  const set = (key: string, value: string): ChangeOp => ({ key, op: 'set', value });
  it('a three-flag flip needs GO LIVE', () => {
    const p = planEnvChange(st, [set('JOBBER_DRY_RUN', '0'), set('SCHEDULER_DRY_RUN', 'false'), set('LINKEDIN_DRY_RUN', 'false')], catalog, CTX);
    expect(p.friction).toEqual({ reauth: true, phrase: 'GO LIVE' });
  });
  it('flipping only JOBBER_DRY_RUN keeps the file mode dry and asks for CHANGE JOBBER_DRY_RUN', () => {
    const p = planEnvChange(st, [set('JOBBER_DRY_RUN', '0')], catalog, CTX);
    expect(p.modeAfter).toBe('DRY RUN');
    expect(p.friction).toEqual({ reauth: true, phrase: 'CHANGE JOBBER_DRY_RUN' });
  });
  it('edit disabled refuses through the plan', () => {
    const p = planEnvChange(st, [set('JOBBER_DRY_RUN', '0')], catalog, { ...CTX, editEnabled: false });
    expect(p.friction.refuse).toBe('settings_disabled');
  });
});

describe('preflight', () => {
  const base = { classifierReady: () => true, stopPresent: () => false, permissionSet: () => 'read_only', chatEnabled: false, sendLimitPerRun: '1' };
  it('no warnings when everything is fine', () => {
    expect(preflight(L, base)).toEqual([]);
  });
  it('classifier not ready on a live flip', () => {
    const w = preflight(L, { ...base, classifierReady: () => false });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/classifier/i);
    expect(preflight(D, { ...base, classifierReady: () => false })).toEqual([]);
  });
  it('STOP present', () => {
    expect(preflight(D, { ...base, stopPresent: () => true })[0]).toMatch(/kill switch is engaged, nothing will run/);
  });
  it('permission set not read_only while chat is enabled', () => {
    expect(preflight(D, { ...base, chatEnabled: true, permissionSet: () => 'full' })[0]).toMatch(/permission set is full/);
    expect(preflight(D, { ...base, chatEnabled: false, permissionSet: () => 'full' })).toEqual([]);
  });
  it('live flip with SEND_LIMIT_PER_RUN=0', () => {
    expect(preflight(L, { ...base, sendLimitPerRun: '0' })[0]).toMatch(/SEND_LIMIT_PER_RUN is 0/);
    expect(preflight(D, { ...base, sendLimitPerRun: '0' })).toEqual([]);
  });
  it('already live is not a flip', () => {
    expect(preflight(L, { ...base, classifierReady: () => false, sendLimitPerRun: '0' }, L)).toEqual([]);
  });
});
