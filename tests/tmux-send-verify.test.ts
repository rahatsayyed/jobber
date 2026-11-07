import { describe, expect, it } from 'vitest';
import { sendText, textStillInInputBox, type Run } from '../src/platform/tmux.js';

const RULE = '─'.repeat(60);
const pane = (inBox: string): string => [
  '❯ Work item w-x-1: read it', '⏺ Working on it', '', RULE, `❯ ${inBox}`, RULE, '  ⏵⏵ auto mode on',
].join('\n');

describe('textStillInInputBox', () => {
  it('is true when the line sits in the input box, false for the echo of a submitted prompt higher up', () => {
    expect(textStillInInputBox(pane('Work item w-x-1: read it'), 'Work item w-x-1: read it')).toBe(true);
    expect(textStillInInputBox(pane(''), 'Work item w-x-1: read it')).toBe(false);
  });
  it('is false without a readable box', () => {
    expect(textStillInInputBox('', 'abc')).toBe(false);
    expect(textStillInInputBox('❯ abc', 'abc')).toBe(false);
  });
});

describe('sendText verify and retry', () => {
  const mk = (panes: string[]): { run: Run; calls: string[][] } => {
    const calls: string[][] = [];
    let i = 0;
    const run: Run = async (_c, args) => {
      calls.push(args);
      if (args[0] === 'capture-pane') return { stdout: panes[Math.min(i++, panes.length - 1)] as string, code: 0 };
      return { stdout: '', code: 0 };
    };
    return { run, calls };
  };
  const enters = (calls: string[][]): number => calls.filter((c) => c[0] === 'send-keys' && c[c.length - 1] === 'Enter').length;

  it('presses Enter once when the text left the box', async () => {
    const { run, calls } = mk([pane('')]);
    await sendText(run, 'Jobber', 'mail', 'Work item w-x-1: read it');
    expect(enters(calls)).toBe(1);
  });
  it('presses Enter again while the text is still in the box, at most 3 more times', async () => {
    const stuck = pane('Work item w-x-1: read it');
    const a = mk([stuck, pane('')]);
    await sendText(a.run, 'Jobber', 'mail', 'Work item w-x-1: read it');
    expect(enters(a.calls)).toBe(2);
    const b = mk([stuck]);
    await sendText(b.run, 'Jobber', 'mail', 'Work item w-x-1: read it');
    expect(enters(b.calls)).toBe(4);
  });
});
