// tests/work-file-role.test.ts
// Every generated work file opens with the role pointer of its window, so a window that was cleared re-reads its role file.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { rolePointer, workFileText, workItemLine } from '../src/scheduler/windowDispatch.js';

const WINDOWS = ['mail', 'linkedin', 'boards', 'sources', 'pipeline', 'apply'];

describe('work file role pointer', () => {
  it.each(WINDOWS)('%s: the first section after the title is the role pointer, and the role file exists', (w) => {
    const text = workFileText('w-x-1-ab12', 'wake', w, 'Steps:\n1. do it');
    const lines = text.split('\n');
    expect(lines[0]).toBe('# Work item w-x-1-ab12 (lane wake)');
    expect(lines[2]).toBe(rolePointer(w));
    expect(lines[2]).toContain(`config/windows/${w}.md`);
    expect(text).toContain('Steps:\n1. do it');
    expect(existsSync(`config/windows/${w}.md`)).toBe(true);
  });

  it('the typed line keeps its exact shape', () => {
    expect(workItemLine('w-x-1-ab12')).toBe('Work item w-x-1-ab12: read .jobber/work/w-x-1-ab12.md and do exactly what it says; do not do anything else');
  });
});
