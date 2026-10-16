import { describe, expect, it } from 'vitest';
import { formatJson, type CheckOutcome } from '../src/platform/doctor.js';

describe('formatJson with the 8G-2 checks', () => {
  it('lists the new check ids with a status and no fix text', async () => {
    const { runChecks } = await import('../src/platform/doctor.js');
    const { sourcesChecks } = await import('../src/platform/checksSources.js');
    const { webChecks } = await import('../src/platform/checksWeb.js');
    const { ctxFor, REPO } = await import('./helpers/doctorRoot.js');
    const out = await runChecks([...sourcesChecks({ db: () => null }), ...webChecks()], ctxFor(REPO));
    const parsed = JSON.parse(formatJson(out)) as Array<{ id: string; status: string }>;
    expect(parsed.map((p) => p.id)).toEqual([
      'source_status', 'search_providers', 'generated_providers', 'web_flags', 'site_accounts', 'web_wired',
      'apply_recipes', 'legacy_removed', 'login_commands', 'apply_limits', 'browser_launch',
    ]);
    expect(parsed.every((p) => ['pass', 'warn', 'fail', 'skip'].includes(p.status))).toBe(true);
    expect(parsed.filter((p) => p.status === 'fail')).toEqual([]);
  });
});

describe('formatJson', () => {
  it('round-trips ids and statuses without fix text', () => {
    const results: CheckOutcome[] = [
      { id: 'a', title: 'A', result: { status: 'pass', detail: 'ok' } },
      { id: 'b', title: 'B', result: { status: 'fail', detail: 'bad', fix: 'do this' } },
    ];
    const text = formatJson(results);
    expect(text).not.toContain('"fix"');
    expect(text).not.toContain('do this');
    expect(JSON.parse(text)).toEqual([
      { id: 'a', title: 'A', status: 'pass', detail: 'ok' },
      { id: 'b', title: 'B', status: 'fail', detail: 'bad' },
    ]);
  });
});
