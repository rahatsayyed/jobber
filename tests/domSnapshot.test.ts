import { describe, it, expect } from 'vitest';
import { buildSelector } from '../src/lib/domSnapshot.js';

describe('buildSelector', () => {
  it('prefers #id when an id is present, even if a name is also present', () => {
    expect(buildSelector({ tag: 'input', id: 'email_addr', name: 'email', indexAmongSameTag: 3 })).toBe(
      '#email_addr'
    );
  });

  it('falls back to tag[name="..."] when there is no id', () => {
    expect(buildSelector({ tag: 'input', name: 'phone_number', indexAmongSameTag: 2 })).toBe(
      'input[name="phone_number"]'
    );
  });

  it('falls back to a structural tag:nth-of-type selector when neither id nor name is present', () => {
    expect(buildSelector({ tag: 'button', indexAmongSameTag: 0 })).toBe('button:nth-of-type(1)');
    expect(buildSelector({ tag: 'button', indexAmongSameTag: 4 })).toBe('button:nth-of-type(5)');
  });

  it('treats an empty-string id or name as absent, falling through to the next strategy', () => {
    expect(buildSelector({ tag: 'input', id: '', name: 'resume', indexAmongSameTag: 1 })).toBe(
      'input[name="resume"]'
    );
    expect(buildSelector({ tag: 'input', id: '', name: '', indexAmongSameTag: 1 })).toBe(
      'input:nth-of-type(2)'
    );
  });
});
