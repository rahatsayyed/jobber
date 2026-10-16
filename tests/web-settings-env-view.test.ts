import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The view is plain browser JS (no allowJs), so it is loaded through a variable specifier.
const file = pathToFileURL(resolve(process.cwd(), 'src', 'web', 'static', 'views', 'settings-env.js')).href;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod: any = await import(/* @vite-ignore */ file);
const { groupBySection, matchesQuery, controlKindFor, initialValueFor, buildChanges, redactStagedForRender } = mod;

const spec = (o: Record<string, unknown>) => ({
  key: 'X', about: 'about', feature: 'f', type: 'string', default: null, secret: false, tier: 'normal', tierReason: '',
  state: { set: false }, ...o,
});

const ALL_TYPES = ['bool', 'int', 'enum', 'string', 'path', 'url', 'email', 'list', 'intList', 'secret'];

describe('controlKindFor', () => {
  it('maps every EnvType to a real control', () => {
    for (const t of ALL_TYPES) {
      const k = controlKindFor(spec({ type: t }));
      expect(['switch', 'number', 'select', 'text', 'secret'], t).toContain(k);
    }
    expect(controlKindFor(spec({ type: 'bool' }))).toBe('switch');
    expect(controlKindFor(spec({ type: 'int' }))).toBe('number');
    expect(controlKindFor(spec({ type: 'enum' }))).toBe('select');
  });
  it('never tier is read-only, whatever the type', () => {
    for (const t of ALL_TYPES) expect(controlKindFor(spec({ type: t, tier: 'never' })), t).toBe('readonly');
  });
  it('secret specs get the secret control and never a value', () => {
    expect(controlKindFor(spec({ type: 'string', secret: true }))).toBe('secret');
    const s = spec({ type: 'secret', default: 'abc', state: { set: true, value: 'hunter2hunter2' } });
    expect(initialValueFor(s)).toBe('');
    expect(initialValueFor(spec({ secret: true, state: { set: true, value: 'zzz' } }))).toBe('');
    expect(initialValueFor(spec({ default: '5', state: { set: false } }))).toBe('5');
    expect(initialValueFor(spec({ default: '5', state: { set: true, value: '7' } }))).toBe('7');
  });
});

describe('search and grouping', () => {
  const sections = [
    { id: 'a', title: 'A', items: [spec({ key: 'ONE', about: 'mentions send limit' }), spec({ key: 'SEND_LIMIT', about: 'x' })] },
    { id: 'b', title: 'B', items: [spec({ key: 'OTHER', feature: 'email', about: 'y' })] },
  ];
  it('ranks key matches before about matches', () => {
    expect(matchesQuery(spec({ key: 'SEND_LIMIT' }), 'send')).toBeGreaterThan(matchesQuery(spec({ key: 'ONE', about: 'send it' }), 'send'));
    expect(matchesQuery(spec({ key: 'ONE' }), 'zzz')).toBe(0);
    const g = groupBySection(sections, 'send', '');
    expect(g).toHaveLength(1);
    expect(g[0].items.map((i: { key: string }) => i.key)).toEqual(['SEND_LIMIT', 'ONE']);
    expect(g[0].open).toBe(true);
  });
  it('matches the feature, filters by section, empty query keeps order and closed groups', () => {
    expect(groupBySection(sections, 'email', '').map((x: { id: string }) => x.id)).toEqual(['b']);
    expect(groupBySection(sections, '', 'b').map((x: { id: string }) => x.id)).toEqual(['b']);
    const all = groupBySection(sections, '', '');
    expect(all).toHaveLength(2);
    expect(all[0].open).toBe(false);
    expect(all[0].items.map((i: { key: string }) => i.key)).toEqual(['ONE', 'SEND_LIMIT']);
  });
});

describe('errorKeys', () => {
  it('links real server error strings to their key', () => {
    const m = mod.errorKeys([
      'invalid_value: SEND_LIMIT_PER_RUN: must be an integer',
      'tier_never: JOBBER_DRY_RUN cannot be changed here',
      'unknown_key: FOO_BAR',
      'value_too_long: WEB_TOKEN: too long',
      'MATCH_THRESHOLD: out of range',
      'some other message',
    ]);
    expect([...m.keys()].sort()).toEqual(['FOO_BAR', 'JOBBER_DRY_RUN', 'MATCH_THRESHOLD', 'SEND_LIMIT_PER_RUN', 'WEB_TOKEN']);
  });
});

describe('staged changes', () => {
  const staged = new Map([
    ['A', { op: 'set', value: '5', secret: false }],
    ['TOKEN', { op: 'set', value: 'sekret-value-123456', secret: true }],
    ['B', { op: 'clear', secret: false }],
    ['C', { op: 'reset', secret: false }],
  ]);
  it('buildChanges makes API ops', () => {
    expect(buildChanges(staged)).toEqual([
      { key: 'A', op: 'set', value: '5' }, { key: 'TOKEN', op: 'set', value: 'sekret-value-123456' },
      { key: 'B', op: 'clear' }, { key: 'C', op: 'reset' },
    ]);
  });
  it('redactStagedForRender never contains a secret value', () => {
    const rows = redactStagedForRender(staged);
    expect(JSON.stringify(rows)).not.toContain('sekret-value');
    expect(rows.find((r: { key: string }) => r.key === 'TOKEN').text).toBe('new value staged (hidden)');
    expect(rows.find((r: { key: string }) => r.key === 'A').text).toContain('5');
  });
});
