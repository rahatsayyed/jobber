// Plan 8G task 3: Serper and Hunter are labelled contact finding everywhere (docs are relabelled in Task 25).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apikeysStep } from '../src/setup/steps/apikeys.js';
import { SKIP_SPECS } from '../src/setup/skips.js';
import { COACH_TEXT } from '../src/setup/coach.js';
import { apiKeysChecks } from '../src/platform/checksApiKeys.js';
import { LIMITS, specFor, validateLimit } from '../src/setup/limitsCatalog.js';
import { openDb } from '../src/db.js';

const TITLE = 'Optional API keys (Serper and Hunter for contact finding)';

describe('contact finding relabel', () => {
  it('.env.example groups Serper and Hunter under a Contact finding heading', () => {
    const t = readFileSync('.env.example', 'utf8');
    const heading = (name: string) => t.indexOf(`# Credentials: ${name}`);
    const contact = heading('contact finding');
    expect(contact).toBeGreaterThan(-1);
    expect(heading('job sources')).toBe(-1);
    const at = (k: string) => t.search(new RegExp(`^${k}=`, 'm'));
    expect(at('SERPER_API_KEY')).toBeGreaterThan(contact);
    expect(at('HUNTER_API_KEY')).toBeGreaterThan(contact);
    expect(t).not.toMatch(/job sources and contact lookup/);
  });

  it('.env.example ships the search keys with their defaults', () => {
    const t = readFileSync('.env.example', 'utf8');
    for (const [k, v] of [
      ['DORK_ENABLED', 'true'], ['DORK_BLOCK_COOLDOWN_HOURS', '24'], ['SEARCH_CACHE_TTL_DAYS', '14'],
      ['SERPER_DAILY_BUDGET', '20'], ['SERPER_MONTHLY_BUDGET', '200'], ['DORK_DAILY_BUDGET', '30'],
    ]) expect(t, k).toMatch(new RegExp(`^${k}=${v}$`, 'm'));
  });

  it('limits catalog carries the three budgets with the plan defaults', () => {
    for (const [k, d] of [['SERPER_DAILY_BUDGET', 20], ['SERPER_MONTHLY_BUDGET', 200], ['DORK_DAILY_BUDGET', 30]] as const) {
      const s = specFor(k);
      expect(s?.default, k).toBe(d);
      expect(validateLimit(s!, '0')).toBeNull();
    }
    expect(LIMITS.length).toBeGreaterThan(0);
  });

  it('apikeys step title, setup-guide title and skip text say contact finding', () => {
    expect(apikeysStep.title).toBe(TITLE);
    const guide = JSON.parse(readFileSync('config/setup-guide.json', 'utf8'));
    const step = guide.steps.find((s: { id: string }) => s.id === 'apikeys');
    expect(step.title).toBe(TITLE);
    expect(step.explain).toContain('Serper (contact finding)');
    expect(step.skip).toContain('Serper off: fewer verified contacts');
    expect(step.keys.find((k: { name: string }) => k.name === 'SERPER_API_KEY').purpose).toContain('contact finding');
    const skip = SKIP_SPECS.find((s) => s.id === 'apikeys')!;
    expect(skip.lose.join(' ')).toContain('Serper and Hunter: contact finding');
  });

  it('coach text and doctor api-keys label say contact finding', async () => {
    expect(COACH_TEXT['apikeys.serper'].join(' ')).toContain('contact finding');
    expect(COACH_TEXT['apikeys.hunter'].join(' ')).toContain('contact finding');
    const ctx = { root: '/x', env: { SERPER_API_KEY: 'c', HUNTER_API_KEY: 'd' }, fs: { exists: () => false, read: () => '' } } as never;
    const r = await apiKeysChecks[0].run(ctx);
    expect(r.detail).toBe('Serper and Hunter (contact finding) keys are set');
  });
});

describe('search tables', () => {
  it('db creates search_usage and search_cache', () => {
    const db = openDb(':memory:');
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('search_usage')).toEqual(['day', 'provider', 'count']);
    expect(cols('search_cache')).toEqual(['qhash', 'provider', 'kind', 'result', 'at']);
  });
});
