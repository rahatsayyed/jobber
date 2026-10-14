import { describe, it, expect } from 'vitest';
import { sendEmail } from '../src/email.js';

describe('sendEmail', () => {
  it('sends an email with attachment via injected transport', async () => {
    const sent: any[] = [];
    const fake = {
      sendMail: async (m: any) => {
        sent.push(m);
        return { messageId: 'test-123' };
      },
    };
    const res = await sendEmail(
      { to: 'a@b.com', subject: 'Hi', body: 'Hello', attachment_path: 'package.json' },
      fake as any
    );
    expect(res.message_id).toBe('test-123');
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('a@b.com');
    expect(sent[0].subject).toBe('Hi');
    expect(sent[0].attachments[0].path).toBe('package.json');
  });

  it('sends an email with no attachments when attachment_path is omitted', async () => {
    const sent: any[] = [];
    const fake = {
      sendMail: async (m: any) => {
        sent.push(m);
        return { messageId: 'test-456' };
      },
    };
    const res = await sendEmail({ to: 'a@b.com', subject: 'Hi', body: 'Hello' }, fake as any);
    expect(res.message_id).toBe('test-456');
    expect(sent[0].attachments).toEqual([]);
  });
});
