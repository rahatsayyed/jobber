import { describe, expect, it } from 'vitest';
import { formatJson, type CheckOutcome } from '../src/platform/doctor.js';

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
