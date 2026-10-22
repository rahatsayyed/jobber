import { describe, it, expect } from 'vitest';
import { layoutPrecondition } from '../src/linkedin/layoutGuard.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { TOOL_REQUIRES } from '../src/layout/vocab.js';
import type { Verdict } from '../src/layout/types.js';

const cfgOf = (enforce: string) => loadLayoutConfig({ LAYOUT_ENFORCE: enforce });
const V = (class_: 'match' | 'partial' | 'drift' | 'unknown', missing: string[] = []): Verdict =>
  ({ class: class_, score: 0.5, missing, variant: 'abc' });

// The send tools are gone (the browserctl engine acts, layout is telemetry there); the precondition
// remains for the typed data tools that read search pages.
describe('layoutPrecondition', () => {
  const tools = ['search_jobs', 'search_posts'] as const;

  it('has no entries for the removed action tools', () => {
    for (const t of ['linkedin_connect_send', 'linkedin_send_message', 'linkedin_accept_invite', 'linkedin_check_connection_status']) {
      expect(TOOL_REQUIRES).not.toHaveProperty(t);
    }
  });

  it('off and warn never refuse; warn notes a non-match', () => {
    for (const mode of ['off', 'warn']) {
      for (const t of tools) {
        for (const v of [V('match'), V('partial', ['results.cards']), V('drift'), V('unknown'), { class: 'unloaded' } as Verdict, null]) {
          expect(layoutPrecondition(t, v, cfgOf(mode)).ok).toBe(true);
        }
      }
    }
    expect(layoutPrecondition('search_jobs', V('match'), cfgOf('warn'))).toEqual({ ok: true });
    expect(layoutPrecondition('search_jobs', V('drift'), cfgOf('warn'))).toEqual({ ok: true, note: 'layout=drift' });
    expect(layoutPrecondition('search_jobs', V('drift'), cfgOf('off'))).toEqual({ ok: true, note: 'layout=drift' });
  });

  it('enforce: match ok, drift and unknown refuse with their codes', () => {
    const c = cfgOf('enforce');
    for (const t of tools) {
      expect(layoutPrecondition(t, V('match'), c).ok).toBe(true);
      expect(layoutPrecondition(t, V('drift'), c)).toMatchObject({ ok: false, status: 'refused', code: 'layout_drift' });
      expect(layoutPrecondition(t, V('unknown'), c)).toMatchObject({ ok: false, status: 'refused', code: 'layout_unverified' });
      expect(layoutPrecondition(t, null, c)).toMatchObject({ ok: false, code: 'layout_unverified' });
    }
  });

  it('enforce: partial passes only when every needed landmark is present in the observation', () => {
    const c = cfgOf('enforce');
    // search_jobs needs results.cards
    expect(layoutPrecondition('search_jobs', V('partial', ['profile.about']), c, ['results.cards']).ok).toBe(true);
    // learned and now gone: drift
    expect(layoutPrecondition('search_jobs', V('partial', ['results.cards']), c, ['dialog.open']))
      .toMatchObject({ ok: false, code: 'layout_drift' });
    // never learned in the variant (not in verdict.missing) and absent now: unverified
    expect(layoutPrecondition('search_jobs', V('partial', ['profile.about']), c, ['dialog.open']))
      .toMatchObject({ ok: false, code: 'layout_unverified' });
    // no observation landmarks to show presence: refuses
    expect(layoutPrecondition('search_jobs', V('partial'), c).ok).toBe(false);
  });

  it('enforce: unloaded asks for a retry, blocked and logged_out are not layout refusals', () => {
    const c = cfgOf('enforce');
    const r = layoutPrecondition('search_jobs', { class: 'unloaded' }, c);
    expect(r).toMatchObject({ ok: false, code: 'layout_unverified' });
    expect((r as { reason: string }).reason).toMatch(/retry/);
    expect(layoutPrecondition('search_jobs', { class: 'blocked' }, c).ok).toBe(true);
    expect(layoutPrecondition('search_jobs', { class: 'logged_out' }, c).ok).toBe(true);
  });
});
