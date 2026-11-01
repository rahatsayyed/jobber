import { describe, expect, it } from 'vitest';
import { messageDialogName, ownMessageShown, recipientMessageDialog } from '../src/browserctl/commit.js';
import { namesPlausiblyMatch } from '../src/linkedin/verify.js';
import type { RawNode, RawTree } from '../src/browserctl/snapshot.js';

const node = (n: number, role: RawNode['role'], name: string, dialog?: number): RawNode => ({
  n, role, name, text: '', disabled: false, ...(dialog === undefined ? {} : { dialog }),
});
const tree = (nodes: RawNode[]): RawTree => ({ url: 'https://www.linkedin.com/in/x/', title: 't', nodes });

describe('ownMessageShown', () => {
  const sent = 'Hi Rinki, I am a full stack React developer, thanks for connecting. I came across the full stack role at Xoriant.';
  const textNode = (n: number, text: string, dialog: number): RawNode => ({ ...node(n, 'text', '', dialog), text });

  it('is true when the sent text stands as a bubble in the conversation view', () => {
    const t = tree([node(1, 'dialog', 'Messaging'), textNode(2, 'Rahat Sayyed sent the following messages at 8:36 PM', 1), textNode(3, sent, 1)]);
    expect(ownMessageShown(t, 1, sent)).toBe(true);
  });

  it('is false while the text is only in the textbox (before the send)', () => {
    const box: RawNode = { ...node(2, 'textbox', 'Write a message…', 1), value: sent, composer: true };
    expect(ownMessageShown(tree([node(1, 'dialog', 'Messaging'), box]), 1, sent)).toBe(false);
  });

  it('is false for a bubble outside the dialog, other text, or a too-short text', () => {
    expect(ownMessageShown(tree([node(1, 'dialog', 'Messaging'), textNode(3, sent, 99)]), 1, sent)).toBe(false);
    expect(ownMessageShown(tree([node(1, 'dialog', 'Messaging'), textNode(3, 'Thanks for your note', 1)]), 1, sent)).toBe(false);
    expect(ownMessageShown(tree([node(1, 'dialog', 'Messaging'), textNode(3, 'Hi', 1)]), 1, 'Hi')).toBe(false);
  });
});

describe('recipientMessageDialog', () => {
  const textNode = (n: number, text: string, dialog: number): RawNode => ({ ...node(n, 'text', '', dialog), text });

  it('picks the window of the armed person, not the first "Messaging" window (stale chats stay open)', () => {
    const t = tree([
      node(10, 'dialog', 'Messaging'),
      node(11, 'heading', 'Rinki Kumari', 10),
      node(20, 'dialog', 'Messaging'),
      node(21, 'heading', 'Anusha D', 20),
      textNode(22, 'Hi Anusha, I am a full stack React developer and thanks for connecting.', 20),
    ]);
    expect(recipientMessageDialog(t, 'Messaging', 'Anusha D')?.n).toBe(20);
    expect(recipientMessageDialog(t, 'Messaging', 'Rinki Kumari')?.n).toBe(10);
    expect(recipientMessageDialog(t, 'Messaging', 'Somebody Else')).toBeUndefined();
  });

  it('works with the composer chip before the send', () => {
    const t = tree([
      node(10, 'dialog', 'Messaging'),
      node(11, 'heading', 'New message', 10),
      node(12, 'button', 'Remove Anusha D', 10),
    ]);
    expect(recipientMessageDialog(t, 'Messaging', 'Anusha D')?.n).toBe(10);
  });
});

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
