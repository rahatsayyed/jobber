// Test helper: adapts a fake "launcher" (start/poll/kill, the shape the old headless tests used) to the WindowDispatcher surface (dispatch/finish)
// that the scheduler now needs. The fake decides the outcome through its poll result: exit 0 = ok, another exit code = failed, usage-limit text in
// its output = usage_limit. The adapter writes the same `scheduler_runs` row the real dispatcher writes (trigger from the caller). No tmux, no claude.
import type BetterSqlite3 from 'better-sqlite3';
import { LIMIT_RE } from '../../src/scheduler/budget.js';
import { finishRun, startRun } from '../../src/scheduler/runLog.js';
import type { DispatchInput, DispatchResult, WindowDispatcher } from '../../src/scheduler/windowDispatch.js';

export interface LaunchHandle { runId: string; session: string; window: string; logPath: string; exitPath: string; promptPath: string }
export interface PollResult { exited: boolean; exitCode: number | null; newOutput: string }
export interface LaunchPlan {
  runId: string; dryRun: boolean; prompt: string; session: string; runDir: string; projectRoot: string;
  noClassifier?: boolean; profile?: string; env?: Record<string, string>; resumeSessionId?: string; windowName?: string;
  /** Added by the adapter: where the item went. */
  window?: string; lane?: string; trigger?: string;
}
export interface Launcher {
  start(plan: LaunchPlan): Promise<LaunchHandle>;
  poll(h: LaunchHandle): Promise<PollResult>;
  kill(h: LaunchHandle): Promise<void>;
}

/** A WindowDispatcher stand-in over a fake launcher. `finished` lists the run ids that finish() was called for. */
export function launcherAsWindows(
  launcher: Launcher, getD: () => { db: BetterSqlite3.Database; now: () => Date },
): WindowDispatcher & { finished: string[]; inputs: DispatchInput[] } {
  let n = 0;
  const finished: string[] = [];
  const inputs: DispatchInput[] = [];
  const fake = {
    finished,
    inputs,
    async dispatch(i: DispatchInput): Promise<DispatchResult> {
      inputs.push(i);
      const runId = `w-${i.window}-${++n}`;
      const plan: LaunchPlan = {
        runId, dryRun: i.dryRun === true, prompt: i.promptText, session: 'Jobber', runDir: '', projectRoot: '',
        profile: i.trigger, windowName: i.window, window: i.window, lane: i.lane, trigger: i.trigger,
      };
      startRun(getD().db, { id: runId, at: getD().now(),trigger: i.trigger, dryRun: i.dryRun === true, tasks: [{ lane: i.lane, item: i.item }], status: 'running', window: i.window });
      const h = await launcher.start(plan);
      const r = await launcher.poll(h);
      let res: DispatchResult;
      if (LIMIT_RE.test(r.newOutput)) res = { status: 'usage_limit', stopReason: 'usage_limit', summary: '', toolCalls: 0, runId };
      else if (r.exitCode === 0) {
        let summary = r.newOutput.slice(-2000);
        // A wake item ends with the final JSON report line naming its steps; the fake model "wrote" it when the scripted output has none.
        const item = i.item as { wake_run_id?: string; steps?: string[] } | null;
        if (i.trigger === 'wake' && item?.wake_run_id && !summary.includes('"run_id"')) {
          const ops = (item.steps ?? []).map((st) => {
            const m = /^\d+\. (\S+)(?: (naukri|linkedin|wellfound))? (\S+)$/.exec(st);
            return m ? { operator: m[1], ...(m[2] ? { platform: m[2] } : {}), tasks: [{ kind: m[3], done: 1, skipped: 0, escalated: 0, stopped: 0 }] } : null;
          }).filter(Boolean);
          summary = `${summary}\n${JSON.stringify({ run_id: item.wake_run_id, operators: ops })}`;
        }
        res = { status: 'ok', stopReason: 'end_turn', summary, toolCalls: 1, runId };
      }
      else res = { status: 'failed', stopReason: `exit ${r.exitCode}`, summary: '', toolCalls: 0, runId };
      const runStatus = res.status === 'ok' ? 'ok' : res.status === 'usage_limit' ? 'usage_limit' : 'failed';
      finishRun(getD().db, runId, { at: getD().now(),status: runStatus, stopReason: res.stopReason });
      return res;
    },
    async finish(runId: string): Promise<{ cleared: boolean }> {
      finished.push(runId);
      return { cleared: true };
    },
  };
  return fake as unknown as WindowDispatcher & { finished: string[]; inputs: DispatchInput[] };
}
