// tests/stack-summary.test.ts
import { describe, expect, it } from 'vitest';
import type { CheckOutcome } from '../src/platform/doctor.js';
import { attentionLine, attentionLines, formatCompact, type UpSummary } from '../src/stack/summary.js';

const base = (over: Partial<UpSummary> = {}): UpSummary => ({
  components: [
    { name: 'bridge', ok: true, state: 'running' },
    { name: 'web', ok: true, state: 'running' },
  ],
  dashboardUrl: 'http://127.0.0.1:8787',
  modeLine: 'MODE: LIVE (real email)',
  modeNeedsAttention: false,
  modeWarnings: [],
  problems: [],
  ...over,
});
const warn = (id: string, detail: string, fix?: string): CheckOutcome => ({ id, title: id, result: { status: 'warn', detail, fix } });

describe('formatCompact', () => {
  it('all running: one status line and the dashboard URL, nothing else', () => {
    expect(formatCompact(base())).toEqual(['Jobber: all 2 components running', 'dashboard: http://127.0.0.1:8787']);
  });
  it('names the components that are down', () => {
    const l = formatCompact(base({ components: [{ name: 'bridge', ok: false, state: 'not running' }, { name: 'web', ok: true, state: 'running' }] }));
    expect(l[0]).toBe('Jobber: 1 of 2 running, down: bridge (not running)');
  });
  it('shows the MODE line only when it needs attention', () => {
    expect(formatCompact(base()).join('\n')).not.toContain('MODE');
    expect(formatCompact(base({ modeLine: 'MODE: DRY RUN (nothing is sent)', modeNeedsAttention: true })).join('\n')).toContain('MODE: DRY RUN');
  });
  it('prints problems and no dashboard line when there is none', () => {
    const l = formatCompact(base({ problems: ['linkedin session expired. Fix: npm run linkedin:login'], dashboardUrl: null }));
    expect(l).toEqual(['Jobber: all 2 components running', 'NEEDS YOU: linkedin session expired. Fix: npm run linkedin:login']);
  });
});

describe('attention filter', () => {
  it('keeps login, session and discovery-parse warnings', () => {
    expect(attentionLine(warn('sessions', 'linkedin session expired', 'npm run linkedin:login'))).toBe('linkedin session expired. Fix: npm run linkedin:login');
    expect(attentionLine(warn('discover_parse', 'linkedin_search_jobs "x" 3 in a row'))).toContain('3 in a row');
  });
  it('drops routine warnings (backup, drill, unknown keys, layout age, drift streak 2, recipes, web flags, permission set)', () => {
    for (const id of ['backup-config', 'backup-drill', 'settings_files', 'layout_age', 'layout_drift', 'apply_recipes', 'web_flags', 'permission-set']) {
      expect(attentionLine(warn(id, 'routine note'))).toBeNull();
    }
    expect(attentionLine(warn('layout_drift', 'drift streak: linkedin/profile streak 2'))).toBeNull();
  });
  it('window-foundation: the always-on unverified note is dropped, stale env is kept in plain words', () => {
    expect(attentionLine(warn('window-foundation', 'all work goes through the worker windows. UNVERIFIED with the installed claude'))).toBeNull();
    const l = attentionLine(warn('window-foundation', 'the mail window is running with an old daily email limit (it started with 5)', 'restart it so it picks up .env: npx tsx scripts/manager.ts restart mail'));
    expect(l).toContain('running with an old daily email limit');
    expect(l).toContain('Fix: restart it so it picks up .env');
  });
  it('ignores pass and fail outcomes here', () => {
    expect(attentionLines([{ id: 'sessions', title: 't', result: { status: 'pass', detail: 'ok' } }])).toEqual([]);
  });
});
