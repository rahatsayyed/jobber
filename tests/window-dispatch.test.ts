import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { acquireLock } from '../src/platform/lock.js';
import type { Run } from '../src/platform/tmux.js';
import { projectTranscriptDir, readWindowSession, transcriptFile, writeWindowSession } from '../src/platform/windowSession.js';
import { setState } from '../src/scheduler/runLog.js';
import {
  cleanupWorkFiles, WindowDispatcher, workFile, workItemLine, type DispatchInput, type DispatchResult,
} from '../src/scheduler/windowDispatch.js';

const SID = '11111111-2222-4333-8444-555555555555';
const SID2 = '99999999-2222-4333-8444-555555555555';
const T0 = 1_700_000_000_000;

const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
const asst = (text: string, stop: string, extra: Record<string, unknown> = {}): string =>
  line({ type: 'assistant', ...extra, message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: stop } });
const toolUse = (): string =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/p/a.ts' } }], stop_reason: 'tool_use' } });
const toolResult = (): string => line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] } });

class Harness {
  root = mkdtempSync(path.join(tmpdir(), 'wd-root-'));
  home = mkdtempSync(path.join(tmpdir(), 'wd-home-'));
  dir = projectTranscriptDir(this.root, this.home);
  db = openDb(':memory:');
  clock = T0;
  tick = 0;
  killedFlag = false;
  windows: { name: string; command: string }[] = [{ name: 'mail', command: 'claude' }];
  pane = '';
  failSend = false;
  calls: string[][] = [];
  steps: Record<number, () => void> = {};
  file = transcriptFile(this.dir, SID);

  run: Run = async (_c, args) => {
    this.calls.push(args);
    if (args[0] === 'list-windows') return { stdout: this.windows.map((w, i) => `${i}|${w.name}|0|${w.command}`).join('\n'), code: 0 };
    if (args[0] === 'capture-pane') return { stdout: this.pane, code: 0 };
    if (args[0] === 'send-keys' && this.failSend && args.includes('-l')) return { stdout: '', code: 1 };
    return { stdout: '', code: 0 };
  };
  typed = (): string[] => this.calls.filter((c) => c[0] === 'send-keys' && c.includes('-l')).map((c) => c[c.length - 1] as string);
  escapes = (): number => this.calls.filter((c) => c[0] === 'send-keys' && c[c.length - 1] === 'Escape').length;

  disp = new WindowDispatcher({
    root: this.root,
    session: 'Jobber',
    run: this.run,
    db: this.db,
    killed: () => this.killedFlag,
    now: () => this.clock,
    sleep: async (ms) => {
      this.clock += ms;
      this.tick++;
      this.steps[this.tick]?.();
    },
    claudeHome: this.home,
    pollMs: 1000,
    stallMs: 60_000,
    paneEveryMs: 10_000,
    settleMs: 10,
  });

  constructor() {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, '');
    writeWindowSession(this.root, 'mail', SID);
  }

  input(over: Partial<DispatchInput> = {}): DispatchInput {
    return { window: 'mail', lane: 'mail_drip', trigger: 'mail_drip', item: { id: 1 }, promptText: 'Send the email for item 1.', deadlineMs: 600_000, ...over };
  }
  append(text: string): void { appendFileSync(this.file, text); }
  runRow(id: string): Record<string, unknown> {
    return this.db.prepare('SELECT * FROM scheduler_runs WHERE id = ?').get(id) as Record<string, unknown>;
  }
  done(): void { rmSync(this.root, { recursive: true, force: true }); rmSync(this.home, { recursive: true, force: true }); }
}

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(() => { h.done(); });

describe('workItemLine', () => {
  it('is one short line without a leading ! # &', () => {
    const l = workItemLine('w-mail-abc-1234');
    expect(l).toBe('Work item w-mail-abc-1234: read .jobber/work/w-mail-abc-1234.md and do exactly what it says; do not do anything else');
    expect(l).not.toMatch(/[\r\n]/);
    expect(l.length).toBeLessThan(2000);
    expect(/^[!#&]/.test(l)).toBe(false);
  });
});

describe('happy path', () => {
  it('writes the work file, types one line, tails to end_turn, records the run, then finish clears', async () => {
    h.steps[1] = () => h.append(toolUse());
    h.steps[2] = () => h.append(toolResult());
    h.steps[3] = () => h.append(asst('Sent. key sk-abcdefghijklmnopqrstuvwxyz1234 done', 'end_turn'));
    const p = h.disp.dispatch(h.input());
    // the work file exists with mode 0600 as soon as the line is typed
    const r = await p;
    expect(r.status).toBe('ok');
    expect(r.stopReason).toBe('end_turn');
    expect(r.toolCalls).toBe(1);
    expect(r.summary).toContain('Sent.');
    expect(r.summary).not.toContain('sk-abcdefghijklmnopqrstuvwxyz1234');
    expect(r.tokensApprox).toBeGreaterThan(0);
    const id = r.runId as string;
    expect(h.typed()).toEqual([workItemLine(id)]);
    const wf = workFile(h.root, id);
    expect(existsSync(wf)).toBe(true);
    expect(statSync(wf).mode & 0o777).toBe(0o600);
    expect(readFileSync(wf, 'utf8')).toContain('Send the email for item 1.');
    const row = h.runRow(id);
    expect(row.status).toBe('ok');
    expect(row.trigger).toBe('mail_drip');
    expect(row.window).toBe('mail');
    expect(row.log_path).toBe(h.file);
    expect(row.tool_calls).toBe(1);
    expect(JSON.parse(row.tasks as string)).toEqual([{ lane: 'mail_drip', item: { id: 1 } }]);

    // the lock stays held until finish()
    expect((await h.disp.dispatch(h.input())).stopReason).toBe('window_busy');
    const f = await h.disp.finish(id);
    expect(f).toEqual({ cleared: true });
    expect(existsSync(wf)).toBe(false);
    expect(h.typed()).toEqual([workItemLine(id), '/clear']);
    expect(await h.disp.finish(id)).toEqual({ cleared: false, reason: 'unknown_run' });
  });

  it('ignores subagent (sidechain) lines and the model text about limits', async () => {
    h.steps[1] = () => h.append(asst('side done', 'end_turn', { isSidechain: true }));
    h.steps[2] = () => h.append(asst('We hit the rate limit reached on the site, retrying', 'tool_use'));
    h.steps[3] = () => h.append(asst('Final answer', 'end_turn'));
    const r = await h.disp.dispatch(h.input());
    expect(h.tick).toBe(3);
    expect(r.status).toBe('ok');
    expect(r.summary).toBe('We hit the rate limit reached on the site, retrying\nFinal answer');
  });

  it('a "waiting for the background agent" end_turn is not the end: the item ends at the turn after the completion notice', async () => {
    const launched = line({
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_AAA', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] },
    });
    const notice = line({ type: 'user', message: { role: 'user', content: '<task-notification>\n<tool-use-id>toolu_AAA</tool-use-id>\n<status>completed</status>\n</task-notification>' } });
    h.steps[1] = () => h.append(toolUse());
    h.steps[2] = () => h.append(launched);
    h.steps[3] = () => h.append(asst('Waiting for the agent notice.', 'end_turn'));
    // real order: the model's final turn first, the completion notice after it
    h.steps[8] = () => h.append(asst('{"run_id":"r1","operators":[]}', 'end_turn'));
    h.steps[9] = () => h.append(notice);
    const r = await h.disp.dispatch(h.input());
    expect(h.tick).toBe(13); // notice at 9, then 4 s of settle with no new turn
    expect(r.status).toBe('ok');
    expect(r.summary).toBe('{"run_id":"r1","operators":[]}');
  });

  it('max_tokens and an API error entry end the item as failed', async () => {
    h.steps[1] = () => h.append(asst('cut', 'max_tokens'));
    const a = await h.disp.dispatch(h.input());
    expect(a.status).toBe('failed');
    expect(a.stopReason).toBe('max_tokens');
    await h.disp.finish(a.runId as string);
    // after /clear the typed line is found by its text (Claude writes the user entry first)
    h.steps = {
      [h.tick + 1]: () => h.append(line({ type: 'user', message: { role: 'user', content: h.typed().at(-1) } }) + asst('Something broke', 'stop_sequence', { isApiErrorMessage: true })),
    };
    const b = await h.disp.dispatch(h.input());
    expect(b.status).toBe('failed');
    expect(b.stopReason).toBe('api_error');
  });
});

describe('stall, timeout, limits, kill switch', () => {
  it('reports stalled when a tool call is pending and the transcript is quiet for 60 s', async () => {
    h.steps[1] = () => h.append(toolUse());
    const r = await h.disp.dispatch(h.input());
    expect(r.status).toBe('stalled');
    expect(r.stopReason).toBe('stalled');
    expect(h.runRow(r.runId as string).status).toBe('incomplete');
    await h.disp.finish(r.runId as string);
    expect(h.escapes()).toBe(1); // a turn that did not end gets an Escape before /clear
    expect(h.typed().at(-1)).toBe('/clear');
  });

  it('a quiet transcript with a busy pane is a slow tool, not a stall (the deadline still ends it)', async () => {
    h.pane = 'running...\n  esc to interrupt';
    h.steps[1] = () => h.append(toolUse());
    const r = await h.disp.dispatch(h.input({ deadlineMs: 200_000 }));
    expect(r.status).toBe('timeout');
    expect(r.stopReason).toBe('wall_clock');
    expect(h.runRow(r.runId as string).status).toBe('budget_exceeded');
  });

  it('times out at the per-item deadline', async () => {
    const r = await h.disp.dispatch(h.input({ deadlineMs: 5000 }));
    expect(r.status).toBe('timeout');
    expect(h.tick).toBe(5);
  });

  it('stalls with no_transcript when no transcript ever shows the typed line', async () => {
    rmSync(path.join(h.root, '.jobber', 'sessions'), { recursive: true, force: true });
    const r = await h.disp.dispatch(h.input());
    expect(r.status).toBe('stalled');
    expect(r.stopReason).toBe('no_transcript');
  });

  it('usage limit from an API error entry in the transcript', async () => {
    h.steps[2] = () => h.append(asst('Claude usage limit reached|1760000000', 'stop_sequence', { isApiErrorMessage: true }));
    const r = await h.disp.dispatch(h.input());
    expect(r.status).toBe('usage_limit');
    expect(h.runRow(r.runId as string).status).toBe('usage_limit');
  });

  it('usage limit from the pane text', async () => {
    h.steps[3] = () => { h.pane = '\n\nClaude usage limit reached. Your limit will reset at 5pm.\n'; };
    const r = await h.disp.dispatch(h.input());
    expect(r.status).toBe('usage_limit');
    expect(r.stopReason).toBe('usage_limit');
    expect(h.tick).toBeLessThan(20);
  });

  it('the kill switch sends Escape once, stops, and finish types nothing', async () => {
    h.steps[2] = () => { h.killedFlag = true; };
    const r = await h.disp.dispatch(h.input());
    expect(r.status).toBe('killed');
    expect(h.escapes()).toBe(1);
    const f = await h.disp.finish(r.runId as string);
    expect(f).toEqual({ cleared: false, reason: 'killed' });
    expect(h.escapes()).toBe(1);
    expect(h.typed()).toEqual([workItemLine(r.runId as string)]);
    expect(h.runRow(r.runId as string).status).toBe('killed');
  });
});

describe('/clear and transcript rediscovery', () => {
  it('finds the new transcript file by the typed line after /clear and updates the record', async () => {
    h.steps[1] = () => h.append(asst('first', 'end_turn'));
    const a = await h.disp.dispatch(h.input());
    await h.disp.finish(a.runId as string);
    const second = transcriptFile(h.dir, SID2);
    h.steps = {
      [h.tick + 1]: () => {
        const typedLine = h.typed().at(-1) as string;
        writeFileSync(second, line({ type: 'user', message: { role: 'user', content: typedLine } }) + asst('second answer', 'end_turn'));
      },
    };
    const b = await h.disp.dispatch(h.input());
    expect(b.status).toBe('ok');
    expect(b.summary).toBe('second answer');
    expect(b.transcript).toBe(second);
    expect(h.runRow(b.runId as string).log_path).toBe(second);
    expect(h.runRow(b.runId as string).session_id).toBe(SID2);
    expect(readWindowSession(h.root, 'mail')?.session_id).toBe(SID2);
  });
});

describe('refusals', () => {
  const none = (r: DispatchResult, why: string): void => {
    expect(r.status).toBe('unavailable');
    expect(r.stopReason).toBe(why);
    expect(r.runId).toBeUndefined();
  };

  it('kill switch, usage backoff, missing window, window not running claude', async () => {
    h.killedFlag = true;
    none(await h.disp.dispatch(h.input()), 'killed');
    h.killedFlag = false;
    setState(h.db, 'usage_backoff_until', new Date(h.clock + 3600_000).toISOString(), new Date(h.clock));
    none(await h.disp.dispatch(h.input()), 'usage_backoff');
    setState(h.db, 'usage_backoff_until', new Date(h.clock - 1000).toISOString(), new Date(h.clock));
    h.windows = [];
    none(await h.disp.dispatch(h.input()), 'window_unavailable:window_missing');
    h.windows = [{ name: 'mail', command: 'zsh' }];
    none(await h.disp.dispatch(h.input()), 'window_unavailable:not_claude');
    expect(h.typed()).toEqual([]);
  });

  it('bad input is refused before anything is typed', async () => {
    none(await h.disp.dispatch(h.input({ window: '-x' })), 'invalid:window');
    none(await h.disp.dispatch(h.input({ lane: 'Bad Lane' })), 'invalid:lane');
    none(await h.disp.dispatch(h.input({ trigger: 'Bad' })), 'invalid:trigger');
    none(await h.disp.dispatch(h.input({ promptText: '   ' })), 'invalid:prompt');
    none(await h.disp.dispatch(h.input({ promptText: 'x'.repeat(100_001) })), 'invalid:prompt');
    none(await h.disp.dispatch(h.input({ deadlineMs: 10 })), 'invalid:deadline');
    expect(h.typed()).toEqual([]);
  });

  it('lock contention: another holder makes the window busy', async () => {
    const lock = acquireLock(path.join(h.root, '.jobber'), 'win-mail', 'other');
    expect(lock).not.toBeNull();
    none(await h.disp.dispatch(h.input()), 'window_busy');
    lock?.release();
    h.steps[1] = () => h.append(asst('ok', 'end_turn'));
    expect((await h.disp.dispatch(h.input())).status).toBe('ok');
  });

  it('a failed type removes the work file and frees the lock', async () => {
    h.failSend = true;
    none(await h.disp.dispatch(h.input()), 'send_failed');
    h.failSend = false;
    expect(existsSync(path.join(h.root, '.jobber', 'work')) ? readdirSync(path.join(h.root, '.jobber', 'work')) : []).toEqual([]);
    h.steps[h.tick + 1] = () => h.append(asst('ok', 'end_turn'));
    expect((await h.disp.dispatch(h.input())).status).toBe('ok');
  });
});

describe('work files', () => {
  it('removes work files older than 24 h on dispatch and keeps fresh ones', async () => {
    const dir = path.join(h.root, '.jobber', 'work');
    mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'old-item.md');
    const fresh = path.join(dir, 'fresh-item.md');
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'x');
    const longAgo = new Date(h.clock - 25 * 3600_000);
    utimesSync(old, longAgo, longAgo);
    utimesSync(fresh, new Date(h.clock - 3600_000), new Date(h.clock - 3600_000));
    expect(cleanupWorkFiles(h.root, h.clock)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(cleanupWorkFiles(h.root, h.clock)).toBe(0);
  });
});
