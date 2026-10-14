import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const doc = readFileSync(join(__dirname, '..', 'docs', 'telegram-branding.md'), 'utf8');

function block(label: string): string {
  const m = doc.match(new RegExp('```' + label + '\\n([\\s\\S]*?)\\n```'));
  if (!m) throw new Error('missing block ' + label);
  return m[1];
}

describe('telegram branding doc', () => {
  it('about text is at most 120 chars', () => {
    expect(block('setabouttext').length).toBeLessThanOrEqual(120);
  });
  it('description is at most 512 chars', () => {
    expect(block('setdescription').length).toBeLessThanOrEqual(512);
  });
  it('contains the GitHub URL', () => {
    expect(doc).toContain('https://github.com/rahatsayyed/jobber');
    expect(block('setabouttext')).toContain('https://github.com/rahatsayyed/jobber');
  });
  it('setcommands lists limits, working and health', () => {
    const names = block('setcommands').split('\n').map((l) => l.split(' - ')[0]);
    for (const c of ['limits', 'working', 'health']) expect(names).toContain(c);
  });
  it('setname is Jobber', () => {
    expect(block('setname')).toBe('Jobber');
  });
});
