// tests/settings-env-edit.test.ts
// planEnvChange: ops, refusals, byte-for-byte preservation, diffs, cross-key checks, mode, friction seam.
import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { installNoRealEnv } from './helpers/noRealEnv.js';
import { memFs } from './helpers/memFs.js';
import { FIXTURE_CATALOG, specOf } from './fixtures/settings/catalog.fixture.js';
import { ENV_MARKER, MAX_OPS, planEnvChange, readEnvState, type EnvState, type FrictionFn } from '../src/settings/envEdit.js';
import { etagOf } from '../src/settings/atomic.js';
import type { ChangeOp, EnvSpec, PolicyCtx } from '../src/settings/types.js';

const guard = installNoRealEnv();
afterAll(() => guard.restore());

const FIXTURE = readFileSync(new URL('./fixtures/settings/env.fixture', import.meta.url), 'utf8');
const CTX: PolicyCtx = { editEnabled: true, remoteExposure: false, remoteSafetyAllowed: false, sessionFresh: true };
const stateOf = (text: string): EnvState => ({ text, etag: etagOf(text), exists: true });
const plan = (changes: ChangeOp[], text = FIXTURE, catalog: readonly EnvSpec[] = FIXTURE_CATALOG) => planEnvChange(stateOf(text), changes, catalog, CTX);
const set = (key: string, value: string): ChangeOp => ({ key, op: 'set', value });

function lineDelta(before: string, after: string): { removed: string[]; added: string[] } {
  const b = before.split('\n');
  const a = after.split('\n');
  return { removed: b.filter((l) => !a.includes(l)), added: a.filter((l) => !b.includes(l)) };
}

describe('readEnvState', () => {
  it('etag is the first 32 hex of the sha256 of the text; a missing file reads as empty', () => {
    const fs = memFs({ '/p/.env': 'A=1\n' });
    const s = readEnvState(fs, '/p/.env');
    expect(s).toEqual({ text: 'A=1\n', etag: etagOf('A=1\n'), exists: true });
    expect(s.etag).toMatch(/^[0-9a-f]{32}$/);
    const m = readEnvState(fs, '/p/missing');
    expect(m.exists).toBe(false);
    expect(m.text).toBe('');
    expect(m.etag).toBe(etagOf(''));
  });
});

describe('planEnvChange operations', () => {
  it('set replaces only the one line and keeps everything else byte for byte', () => {
    const p = plan([set('FX_MAX_PER_DAY', '7')]);
    expect(p.errors).toEqual([]);
    expect(lineDelta(FIXTURE, p.newText)).toEqual({ removed: ['FX_MAX_PER_DAY=5'], added: ['FX_MAX_PER_DAY=7'] });
    expect(p.newText.split('\n').length).toBe(FIXTURE.split('\n').length);
  });

  it('preserves CRLF endings, the export prefix, unknown keys, comments and the inline-comment line', () => {
    const p = plan([set('FX_MIN_GAP', '31'), set('FX_NAME', 'new name'), set('FX_MAX_PER_DAY', '9')]);
    expect(p.errors).toEqual([]);
    const lines = p.newText.split('\n');
    expect(lines).toContain('FX_MIN_GAP=31\r');
    expect(lines).toContain('FX_APPLY_LIMIT=5\r');
    expect(lines).toContain("export FX_NAME='new name'");
    for (const keep of [
      '# Invented .env for the settings tests. Not a real file.',
      'UNKNOWN_FIXTURE_KEY=keep-me-as-is',
      'ANOTHER_UNKNOWN=1   # trailing note on an unknown key',
      'FX_MODE=alpha # inline comment on a known key',
      '# FX_ENABLE_SEND=',
      "FX_BOT_TOKEN='FIXTURE-SECRET-2'",
    ]) {
      expect(lines).toContain(keep);
    }
    // the only differences are the three edited lines
    const d = lineDelta(FIXTURE, p.newText);
    expect(d.removed.sort()).toEqual(['FX_MAX_PER_DAY=5', 'FX_MIN_GAP=30\r', 'export FX_NAME=fixture runner'].sort());
  });

  it('quotes values with spaces and #', () => {
    expect(plan([set('FX_NAME', 'a b')]).newText).toContain("export FX_NAME='a b'");
    expect(plan([set('FX_NAME', 'a#b')]).newText).toContain("export FX_NAME='a#b'");
    expect(plan([set('FX_NAME', 'a b')]).diffs).toEqual([{ key: 'FX_NAME', secret: false, before: 'fixture runner', after: 'a b' }]);
  });

  it('activates a commented optional key by appending under one marker, never rewriting the comment', () => {
    const p1 = plan([set('FX_ENABLE_SEND', 'true')]);
    expect(p1.errors).toEqual([]);
    expect(p1.newText).toContain('# FX_ENABLE_SEND=\n');
    // the fixture ends in CRLF lines, so the appended lines follow that ending
    const lf = (t: string) => t.replace(/\r/g, '');
    expect(lf(p1.newText).split('\n').filter((l) => l === ENV_MARKER)).toHaveLength(1);
    expect(lf(p1.newText).trimEnd().endsWith(`${ENV_MARKER}\nFX_ENABLE_SEND=true`)).toBe(true);
    expect(p1.newText).toContain(`${ENV_MARKER}\r\nFX_ENABLE_SEND=true\r\n`);
    // second activation reuses the marker and lands directly under it
    const p2 = plan([set('FX_ONE_ONLY', '1')], p1.newText);
    expect(lf(p2.newText).split('\n').filter((l) => l === ENV_MARKER)).toHaveLength(1);
    expect(lf(p2.newText).trimEnd().endsWith(`${ENV_MARKER}\nFX_ENABLE_SEND=true\nFX_ONE_ONLY=1`)).toBe(true);
    expect(p1.newText.startsWith(FIXTURE.trimEnd())).toBe(true);
  });

  it('appends to an empty or newline-less file', () => {
    expect(plan([set('FX_FLAG', 'true')], '').newText).toBe(`${ENV_MARKER}\nFX_FLAG=true\n`);
    expect(plan([set('FX_FLAG', 'true')], 'A=1').newText).toBe(`A=1\n\n${ENV_MARKER}\nFX_FLAG=true\n`);
  });

  it('clear writes KEY=; reset removes the line unless blank means default', () => {
    expect(plan([{ key: 'FX_MAX_PER_DAY', op: 'clear' }]).newText).toContain('\nFX_MAX_PER_DAY=\n');
    // FX_MAX_PER_DAY blankMeansDefault true: reset acts as clear
    expect(plan([{ key: 'FX_MAX_PER_DAY', op: 'reset' }]).newText).toContain('\nFX_MAX_PER_DAY=\n');
    // FX_ALLOWED_URLS blankMeansDefault false: reset removes the active line
    const r = plan([{ key: 'FX_ALLOWED_URLS', op: 'reset' }]);
    expect(r.newText).not.toContain('FX_ALLOWED_URLS=');
    expect(lineDelta(FIXTURE, r.newText)).toEqual({ removed: ['FX_ALLOWED_URLS='], added: [] });
    // clearing a key that is absent changes nothing
    expect(plan([{ key: 'FX_ZERO_ONE', op: 'clear' }]).newText).toBe(FIXTURE);
  });

  it('an unchanged value writes the same text and no diff', () => {
    const p = plan([set('FX_MAX_PER_DAY', '5')]);
    expect(p.newText).toBe(FIXTURE);
    expect(p.diffs).toEqual([]);
  });
});

describe('planEnvChange refusals', () => {
  const refused = (changes: ChangeOp[], code: string) => {
    const p = plan(changes);
    expect(p.errors.some((e) => e.startsWith(`${code}:`))).toBe(true);
    expect(p.newText).toBe(FIXTURE);
    expect(p.diffs).toEqual([]);
  };
  it('unknown key', () => refused([set('NOT_IN_CATALOG', '1')], 'unknown_key'));
  it('never tier', () => refused([set('FX_KILL', 'true')], 'tier_never'));
  it('secret reset', () => refused([{ key: 'FX_API_KEY', op: 'reset' }], 'secret_reset'));
  it('two ops on one key', () => refused([set('FX_MAX_PER_DAY', '6'), { key: 'FX_MAX_PER_DAY', op: 'clear' }], 'duplicate_key'));
  it('more than 50 ops', () => {
    const many = Array.from({ length: MAX_OPS + 1 }, () => set('FX_MAX_PER_DAY', '6'));
    refused(many, 'too_many_ops');
  });
  it('value over maxLen', () => refused([set('FX_NAME', 'x'.repeat(41))], 'value_too_long'));
  it('value with CR or LF', () => {
    refused([set('FX_NAME', 'a\nb')], 'invalid_value');
    refused([set('FX_NAME', 'a\rb')], 'invalid_value');
  });
  it('validation failure from the value check', () => refused([set('FX_MAX_PER_DAY', '9999')], 'invalid_value'));
  it('one bad op blocks the whole plan', () => {
    const p = plan([set('FX_MAX_PER_DAY', '7'), set('NOPE', '1')]);
    expect(p.newText).toBe(FIXTURE);
  });
});

describe('diffs', () => {
  it('secrets use words only', () => {
    expect(plan([set('FX_API_KEY', 'FIXTURE-SECRET-2')]).diffs).toEqual([{ key: 'FX_API_KEY', secret: true, before: 'set', after: 'replaced' }]);
    expect(plan([{ key: 'FX_API_KEY', op: 'clear' }]).diffs).toEqual([{ key: 'FX_API_KEY', secret: true, before: 'set', after: 'cleared' }]);
    const unset = FIXTURE.replace('FX_API_KEY=FIXTURE-SECRET-1\n', '');
    expect(plan([set('FX_API_KEY', 'FIXTURE-SECRET-2')], unset).diffs).toEqual([{ key: 'FX_API_KEY', secret: true, before: 'not set', after: 'set' }]);
  });
  it('non-secret diffs are cleaned and cut to 200 characters', () => {
    const p = plan([set('FX_DATA_DIR', 'd'.repeat(300))]);
    expect(p.diffs[0].before).toBe('(not set)');
    expect(p.diffs[0].after.length).toBeLessThanOrEqual(203);
    expect(p.diffs[0].after.startsWith('ddd')).toBe(true);
  });
  it('restart and unknown keys are reported by name', () => {
    const p = plan([set('FX_PORT', '9000'), set('FX_MAX_PER_DAY', '6')]);
    expect(p.restart).toEqual([
      { key: 'FX_PORT', scope: 'dashboard' },
      { key: 'FX_MAX_PER_DAY', scope: 'next_run' },
    ]);
    expect(p.unknownKeys).toEqual(['ANOTHER_UNKNOWN', 'UNKNOWN_FIXTURE_KEY']);
  });
});

describe('cross-key validation', () => {
  it('a pair that would invert is an error', () => {
    const base = 'EMAIL_DRIP_MIN_BATCH=1\nEMAIL_DRIP_MAX_BATCH=4\n';
    const p = plan([set('EMAIL_DRIP_MIN_BATCH', '9')], base);
    expect(p.errors.some((e) => e.startsWith('pair_invalid:'))).toBe(true);
    expect(p.newText).toBe(base);
    expect(plan([set('EMAIL_DRIP_MIN_BATCH', '3')], base).errors).toEqual([]);
  });
  it('a conditional requirement is a warning, not an error', () => {
    const p = plan([{ key: 'FX_NAME', op: 'clear' }]);
    expect(p.errors).toEqual([]);
    expect(p.warnings).toContain('FX_NAME is required when FX_FLAG is true');
  });
  it('a required key that would be empty warns', () => {
    const p = plan([set('FX_ALLOWED_EMAIL', 'me@example.com')], 'FX_ALLOWED_EMAIL=a@example.com\n');
    expect(p.warnings).toEqual([]);
    expect(plan([{ key: 'FX_ALLOWED_EMAIL', op: 'clear' }], 'FX_ALLOWED_EMAIL=a@example.com\n').warnings).toContain('FX_ALLOWED_EMAIL is required and would be empty');
  });
  it('the dashboard config guard runs for web keys', () => {
    const cat: EnvSpec[] = [{ ...specOf('FX_PORT'), key: 'WEB_PORT', min: undefined, max: undefined }];
    const p = plan([set('WEB_PORT', '80')], '', cat);
    expect(p.errors.some((e) => e.startsWith('dashboard_config_invalid:'))).toBe(true);
    expect(plan([set('WEB_PORT', '9001')], '', cat).errors).toEqual([]);
  });
});

describe('modeAfter', () => {
  // isDryRun: only JOBBER_DRY_RUN counts; dry iff its trimmed, lowercased value is 1 or true.
  const flag = (key: string, allowed: string[]): EnvSpec => ({ ...specOf('FX_FLAG'), key, allowed, tier: 'safety', weakens: 'false' });
  const cat = [flag('JOBBER_DRY_RUN', ['true', 'false', '0', '1']), flag('SCHEDULER_DRY_RUN', ['true', 'false'])];
  it('is LIVE when the flag is unset or false, DRY RUN when true or 1', () => {
    expect(plan([], '', cat).modeAfter).toBe('LIVE');
    expect(plan([set('JOBBER_DRY_RUN', 'false')], '', cat).modeAfter).toBe('LIVE');
    expect(plan([set('JOBBER_DRY_RUN', 'true')], '', cat).modeAfter).toBe('DRY RUN');
    expect(plan([set('JOBBER_DRY_RUN', '1')], '', cat).modeAfter).toBe('DRY RUN');
  });
  it('flips with the one flag and ignores the retired ones', () => {
    expect(plan([], 'JOBBER_DRY_RUN=false\n', cat).modeAfter).toBe('LIVE');
    expect(plan([set('JOBBER_DRY_RUN', 'true')], 'JOBBER_DRY_RUN=false\n', cat).modeAfter).toBe('DRY RUN');
    expect(plan([{ key: 'JOBBER_DRY_RUN', op: 'clear' }], 'JOBBER_DRY_RUN=true\n', cat).modeAfter).toBe('LIVE');
    expect(plan([set('SCHEDULER_DRY_RUN', 'true')], 'JOBBER_DRY_RUN=false\n', cat).modeAfter).toBe('LIVE');
  });
});

describe('friction seam and newText', () => {
  it('defaults to the real policy: none for a normal key, reauth for a weakened guarded key', () => {
    expect(plan([set('FX_MIN_GAP', '31')]).friction).toEqual({ reauth: false, phrase: null });
    expect(plan([set('FX_MAX_PER_DAY', '6')]).friction).toEqual({ reauth: true, phrase: null });
  });
  it('passes resolved changes and both modes to the injected function', () => {
    let seen: Parameters<FrictionFn>[0] | null = null;
    let seenCtx: PolicyCtx | null = null;
    const frictionFn: FrictionFn = (input, ctx) => {
      seen = input;
      seenCtx = ctx;
      return { reauth: true, phrase: 'CHANGE FX_MAX_PER_DAY' };
    };
    const p = planEnvChange(stateOf(FIXTURE + 'JOBBER_DRY_RUN=true\n'), [set('FX_MAX_PER_DAY', '6')], FIXTURE_CATALOG, CTX, { frictionFn });
    expect(p.friction).toEqual({ reauth: true, phrase: 'CHANGE FX_MAX_PER_DAY' });
    expect(seenCtx).toBe(CTX);
    expect(seen!.modeBefore).toBe('DRY RUN');
    expect(seen!.changes).toHaveLength(1);
    expect(seen!.changes[0]).toMatchObject({ before: '5', after: '6', spec: { key: 'FX_MAX_PER_DAY' } });
  });
  it('newText is readable by the server but not serialisable', () => {
    const p = plan([set('FX_API_KEY', 'FIXTURE-SECRET-2')]);
    expect(p.newText).toContain('FX_API_KEY=FIXTURE-SECRET-2');
    expect(Object.keys(p)).not.toContain('newText');
    expect(JSON.stringify(p)).not.toContain('FIXTURE-SECRET');
    expect(JSON.stringify({ ...p })).not.toContain('FIXTURE-SECRET');
  });
});
