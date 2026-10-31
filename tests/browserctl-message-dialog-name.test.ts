import { describe, expect, it } from 'vitest';
import { messageDialogName } from '../src/browserctl/commit.js';
import { namesPlausiblyMatch } from '../src/linkedin/verify.js';
import type { RawNode, RawTree } from '../src/browserctl/snapshot.js';

const node = (n: number, role: RawNode['role'], name: string, dialog?: number): RawNode => ({
  n, role, name, text: '', disabled: false, ...(dialog === undefined ? {} : { dialog }),
});
const tree = (nodes: RawNode[]): RawTree => ({ url: 'https://www.linkedin.com/in/x/', title: 't', nodes });

describe('messageDialogName', () => {
  it('reads the recipient from the live "Messaging" overlay chip (heading is generic)', () => {
    const t = tree([
      node(399, 'dialog', 'Messaging'),
      node(400, 'heading', 'New message', 399),
      node(404, 'button', 'Remove Rinki Kumari', 399),
      node(407, 'link', 'Rinki Kumari Profile', 399),
      node(408, 'link', 'Rinki Kumari', 399),
      node(411, 'textbox', 'Write a message…', 399),
    ]);
    expect(messageDialogName(t, 399)).toBe('Rinki Kumari');
  });

  it('the armed short name matches the full chip name (Aafreen D. / Aafreen Danish)', () => {
    const t = tree([node(1, 'dialog', 'Messaging'), node(4, 'button', 'Remove Aafreen Danish', 1)]);
    expect(namesPlausiblyMatch('Aafreen D.', messageDialogName(t, 1))).toBe(true);
    expect(namesPlausiblyMatch('Rinki Kumari', messageDialogName(t, 1))).toBe(false);
  });

  it('still prefers a non-generic heading', () => {
    const t = tree([node(1, 'dialog', 'Messaging'), node(2, 'heading', 'Message to Sam Lee', 1)]);
    expect(messageDialogName(t, 1)).toBe('Sam Lee');
  });

  it('two recipients name nobody (a group message is never sent)', () => {
    const t = tree([
      node(1, 'dialog', 'Messaging'),
      node(2, 'heading', 'New message', 1),
      node(3, 'button', 'Remove Ann Lee', 1),
      node(4, 'button', 'Remove Bo Chen', 1),
    ]);
    expect(messageDialogName(t, 1)).toBe('');
  });

  it('no chip and a generic heading gives an empty name', () => {
    const t = tree([node(1, 'dialog', 'Messaging'), node(2, 'heading', 'New message', 1)]);
    expect(messageDialogName(t, 1)).toBe('');
  });

  it('ignores controls outside the dialog', () => {
    const t = tree([node(1, 'dialog', 'Messaging'), node(2, 'heading', 'New message', 1), node(9, 'button', 'Remove Someone Else')]);
    expect(messageDialogName(t, 1)).toBe('');
  });
});
