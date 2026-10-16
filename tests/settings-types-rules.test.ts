// tests/settings-types-rules.test.ts
import { describe, it, expect } from 'vitest';
import { weakens } from '../src/settings/valueCheck.js';
import { FIXTURE_CATALOG, specOf } from './fixtures/settings/catalog.fixture.js';

describe('weakens', () => {
  it("'true': after live and before not", () => {
    const s = specOf('FX_ENABLE_SEND'); // default false
    expect(weakens(s, 'false', 'true')).toBe(true);
    expect(weakens(s, undefined, 'true')).toBe(true); // missing = default false
    expect(weakens(s, 'true', 'true')).toBe(false);
    expect(weakens(s, 'true', 'false')).toBe(false);
    expect(weakens(specOf('FX_ONE_ONLY'), undefined, '1')).toBe(true); // live set includes 1
  });
  it("'false': after not live and before live", () => {
    const s = specOf('FX_DRY_RUN'); // default true
    expect(weakens(s, 'true', 'false')).toBe(true);
    expect(weakens(s, undefined, 'false')).toBe(true); // before = default true
    expect(weakens(s, 'false', 'true')).toBe(false);
    expect(weakens(s, 'true', '')).toBe(false); // blank = default true
  });
  it("'increase' and 'decrease' compare ints with default fallback", () => {
    const inc = specOf('FX_MAX_PER_DAY'); // default 20
    expect(weakens(inc, '10', '30')).toBe(true);
    expect(weakens(inc, '30', '10')).toBe(false);
    expect(weakens(inc, '20', '20')).toBe(false);
    expect(weakens(inc, undefined, '21')).toBe(true);
    expect(weakens(inc, '30', '')).toBe(false); // blank after = 20, lower
    const dec = specOf('FX_MIN_GAP'); // default 30
    expect(weakens(dec, '30', '10')).toBe(true);
    expect(weakens(dec, '10', '30')).toBe(false);
    expect(weakens(dec, undefined, '29')).toBe(true);
    expect(weakens(dec, '10', undefined)).toBe(false);
  });
  it("'cleared': non-blank to blank", () => {
    const s = specOf('FX_BOT_TOKEN');
    expect(weakens(s, 'x', '')).toBe(true);
    expect(weakens(s, 'x', undefined)).toBe(true);
    expect(weakens(s, '', 'x')).toBe(false);
    expect(weakens(s, '', '')).toBe(false);
    expect(weakens(s, 'x', 'y')).toBe(false);
  });
  it("'any': any change", () => {
    const s = specOf('FX_LAYOUT_ENFORCE');
    expect(weakens(s, 'warn', 'enforce')).toBe(true);
    expect(weakens(s, 'warn', 'warn')).toBe(false);
    expect(weakens(s, undefined, 'warn')).toBe(true);
  });
  it('null never weakens', () => {
    const s = specOf('FX_PORT');
    expect(weakens(s, '1', '2')).toBe(false);
  });
  it('blank before with no default does not weaken increase', () => {
    const s = { ...specOf('FX_MAX_PER_DAY'), default: null };
    expect(weakens(s, undefined, '5')).toBe(false);
  });
});

describe('fixture catalog', () => {
  it('covers every EnvType, tier and weakens mode with unique keys', () => {
    const types = new Set(FIXTURE_CATALOG.map((s) => s.type));
    for (const t of ['bool', 'int', 'enum', 'string', 'path', 'url', 'email', 'list', 'intList', 'secret']) {
      expect(types.has(t as never)).toBe(true);
    }
    const tiers = new Set(FIXTURE_CATALOG.map((s) => s.tier));
    for (const t of ['never', 'safety', 'guarded', 'normal']) expect(tiers.has(t as never)).toBe(true);
    const modes = new Set(FIXTURE_CATALOG.map((s) => s.weakens));
    for (const m of ['true', 'false', 'increase', 'decrease', 'cleared', 'any', null]) expect(modes.has(m as never)).toBe(true);
    expect(new Set(FIXTURE_CATALOG.map((s) => s.key)).size).toBe(FIXTURE_CATALOG.length);
    expect(FIXTURE_CATALOG.length).toBeGreaterThanOrEqual(25);
  });
  it('secrets have no default', () => {
    for (const s of FIXTURE_CATALOG.filter((x) => x.secret)) expect(s.default).toBeNull();
  });
});
