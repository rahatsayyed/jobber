import { describe, expect, it } from 'vitest';
import { inviteDialogName } from '../src/browserctl/commit.js';
import { namesPlausiblyMatch } from '../src/linkedin/verify.js';
import type { RawNode, RawTree } from '../src/browserctl/snapshot.js';

const node = (n: number, role: RawNode['role'], o: Partial<RawNode> = {}): RawNode => ({ n, role, name: '', text: '', disabled: false, ...o });
const tree = (inner: RawNode[]): RawTree => ({
  url: 'https://www.linkedin.com/in/someone/', title: 'x',
  nodes: [node(5, 'dialog', { name: 'Add a note to your invitation?' }), ...inner.map((x) => ({ ...x, dialog: 5 }))],
});

describe('inviteDialogName on the live invite dialog', () => {
  it('reads the name that sits in its own text node after "invitation to ... by adding a note"', () => {
    const t = tree([
      node(6, 'text', { text: 'Dialog content start.' }),
      node(7, 'button', { name: 'Dismiss' }),
      node(8, 'heading', { name: 'Add a note to your invitation?' }),
      node(9, 'text', { text: 'Personalize your invitation to by adding a note. LinkedIn members are ' }),
      node(10, 'text', { text: 'Sumalatha G' }),
      node(11, 'button', { name: 'Add a note' }),
      node(12, 'button', { name: 'Send without a note' }),
      node(13, 'text', { text: 'Dialog content end.' }),
    ]);
    const name = inviteDialogName(t, 5);
    expect(name).toBe('Sumalatha G');
    expect(namesPlausiblyMatch('Sumalatha Gonuguntla', name)).toBe(true);
    expect(namesPlausiblyMatch('Someone Else', name)).toBe(false);
  });

  it('never takes "by adding a note" as a name', () => {
    const t = tree([node(9, 'text', { text: 'Personalize your invitation to by adding a note.' }), node(11, 'button', { name: 'Send without a note' })]);
    expect(inviteDialogName(t, 5)).toBe('');
  });

  it('still reads an inline name', () => {
    const t = tree([node(9, 'text', { text: 'Personalize your invitation to Jane Example by adding a note.' })]);
    expect(inviteDialogName(t, 5)).toBe('Jane Example');
  });
});
