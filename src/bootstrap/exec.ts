// src/bootstrap/exec.ts
// Consent-gated executor: detection first, then actions under the consent table, then a result table.
import { redactPane } from '../platform/redact.js';
import { UV_INSTALLER_ACTION } from './catalog.js';
import type { Action, BootstrapDeps, Detection, Item, ItemId } from './types.js';

export type Reason = 'needs_yes' | 'needs_sudo' | 'needs_tty' | 'declined' | 'waiting';
export type Outcome = 'ok' | 'installed' | 'skipped' | 'needs_owner' | 'failed' | 'unsupported';
export interface ItemResult {
  id: ItemId;
  title: string;
  required: boolean;
  outcome: Outcome;
  /** Why an item was not acted on; the CLI derives exit code 3 from this, never from the note text. */
  reason?: Reason;
  version?: string;
  note: string;
}
export interface ExecOptions {
  yes: boolean;
  allowSudo: boolean;
  checkOnly: boolean;
  planOnly: boolean;
  only?: ItemId[];
  withOptional: boolean;
  skipModel: boolean;
  interactive: boolean; // stdin and stdout are TTYs
}
export interface ExecDeps extends BootstrapDeps {
  ask(prompt: string): Promise<boolean>;
  say(line: string): void;
  download(url: string, destDir: string): Promise<{ path: string; bytes: number; sha256: string }>;
  mkTempDir(): string;
  /**
   * Runs a real install action with inherited stdio, no short timeout (the caller caps it) and no shell.
   * `run` (inherited from BootstrapDeps) is for detection only: it has a short timeout and a small buffer.
   */
  exec(cmd: string, args: string[], opts: { cwd?: string }): Promise<{ code: number }>;
}

const DEPENDS: Partial<Record<ItemId, ItemId>> = { ccgram: 'uv', 'npm-deps': 'node', 'renderer-deps': 'npm-deps' };

/**
 * 1 when a required item is failed, needs the owner, or was skipped (declined, needs --yes, waiting on a
 * dependency). With planOnly nothing is run, so a skipped item is the expected state and does not count.
 */
export function exitCodeFor(results: ItemResult[], opts: { planOnly?: boolean } = {}): 0 | 1 {
  return results.some(
    (r) => r.required && (r.outcome === 'failed' || r.outcome === 'needs_owner' || (r.outcome === 'skipped' && !opts.planOnly)),
  )
    ? 1
    : 0;
}

export function renderTable(results: ItemResult[]): string {
  const rows = [['item', 'required', 'result', 'version', 'note']].concat(
    results.map((r) => [r.id, r.required ? 'yes' : 'no', r.outcome, r.version ?? '-', r.note.replace(/\s+/g, ' ')]),
  );
  const w = [0, 1, 2, 3].map((c) => Math.max(...rows.map((r) => r[c]!.length)));
  return rows.map((r) => [...w.map((n, c) => r[c]!.padEnd(n)), r[4]!].join('  ').trimEnd()).join('\n');
}

function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return redactPane(lines[lines.length - 1] ?? 'no output');
}

type Step = { kind: 'done' } | { kind: 'stop'; outcome: Outcome; note: string; reason?: Reason };

export async function runBootstrap(items: Item[], deps: ExecDeps, opts: ExecOptions): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  const byId = new Map<ItemId, ItemResult>();
  const selected = opts.only ? items.filter((i) => opts.only!.includes(i.id)) : items;

  const runAction = async (a: Action): Promise<Step> => {
    try {
      let argv = a.argv;
      for (const l of a.lines ?? []) deps.say(l);
      if (a.downloadsScript) {
        if (a.needsSudo) return { kind: 'stop', outcome: 'failed', note: `${a.id}: refusing to run a downloaded script with sudo` };
        if (!a.url) return { kind: 'stop', outcome: 'failed', note: `${a.id}: downloaded script has no url` };
        if (!opts.interactive) {
          deps.say(`script install needs a terminal: ${a.url}`);
          return { kind: 'stop', outcome: 'needs_owner', note: `script review needs a terminal (${a.url})`, reason: 'needs_tty' };
        }
        // The show-and-ask flow is the consent surface; the second ask happens whatever --yes says.
        const dir = deps.mkTempDir();
        const dl = await deps.download(a.url, dir);
        deps.say(`downloaded ${a.url} (${dl.bytes} bytes, sha256 ${dl.sha256})`);
        deps.say(deps.fs.read(dl.path).split('\n').slice(0, 40).join('\n'));
        if (!(await deps.ask(`run the downloaded script ${dl.path}?`))) return { kind: 'stop', outcome: 'skipped', note: 'script declined', reason: 'declined' };
        argv = a.argv.map((x) => (x === '{script}' ? dl.path : x));
      } else if (a.needsSudo) {
        deps.say(`needs sudo: sudo ${argv.join(' ')}`);
        if (!(opts.yes && opts.allowSudo)) {
          if (!opts.interactive) return { kind: 'stop', outcome: 'needs_owner', note: `needs sudo: run sudo ${argv.join(' ')}`, reason: 'needs_sudo' };
          if (!(await deps.ask('run with sudo?'))) return { kind: 'stop', outcome: 'skipped', note: 'sudo declined', reason: 'declined' };
        }
      } else if (!opts.yes) {
        deps.say(`action: ${a.summary}`);
        if (!opts.interactive) return { kind: 'stop', outcome: 'skipped', note: 'needs --yes', reason: 'needs_yes' };
        if (!(await deps.ask(`run: ${argv.join(' ')}?`))) return { kind: 'stop', outcome: 'skipped', note: 'declined', reason: 'declined' };
      }
      if (a.fn) {
        deps.say(`running: ${argv.join(' ')} (sudo: no, network: ${a.network ? 'yes' : 'no'})`);
        const fr = await a.fn();
        return fr.ok ? { kind: 'done' } : { kind: 'stop', outcome: 'failed', note: `${a.id} failed: ${redactPane(fr.note)}` };
      }
      const full = a.needsSudo ? ['sudo', ...argv] : argv;
      deps.say(`running: ${full.join(' ')} (sudo: ${a.needsSudo ? 'yes' : 'no'}, network: ${a.network ? 'yes' : 'no'}${a.url ? `, url: ${a.url}` : ''})`);
      const [cmd, ...args] = full;
      // Output is inherited by the child, so the note carries the exit code only.
      const r = await deps.exec(cmd!, args, a.cwd ? { cwd: a.cwd } : {});
      if (r.code !== 0) return { kind: 'stop', outcome: 'failed', note: `${a.id} failed: exit ${r.code}; see output above` };
      return { kind: 'done' };
    } catch (e) {
      return { kind: 'stop', outcome: 'failed', note: `${a.id} failed: ${lastLine(String((e as Error).message ?? e))}` };
    }
  };

  const depPresent = async (id: ItemId): Promise<boolean> => {
    const d = byId.get(id);
    if (d) return d.outcome === 'ok' || d.outcome === 'installed';
    const it = items.find((i) => i.id === id);
    if (!it) return true;
    try {
      return (await it.detect(deps)).present;
    } catch {
      return false;
    }
  };

  for (const item of selected) {
    const res = (outcome: Outcome, note: string, version?: string, reason?: Reason): void => {
      const r: ItemResult = { id: item.id, title: item.title, required: item.required, outcome, note, ...(version ? { version } : {}), ...(reason ? { reason } : {}) };
      results.push(r);
      byId.set(item.id, r);
    };
    let det: Detection;
    try {
      det = await item.detect(deps);
    } catch (e) {
      res('failed', `detect failed: ${lastLine(String((e as Error).message ?? e))}`);
      continue;
    }
    if (det.present) {
      res('ok', det.detail, det.version);
      continue;
    }
    if (opts.checkOnly) {
      res(item.required ? 'needs_owner' : 'skipped', `missing: ${det.detail}`, det.version);
      continue;
    }
    const dep = DEPENDS[item.id];
    if (dep && !opts.planOnly) {
      if (!(await depPresent(dep))) {
        res('skipped', `waiting for ${dep}`, undefined, 'waiting');
        continue;
      }
    }
    if (item.id === 'classifier-model' && opts.skipModel) {
      res('skipped', '--skip-model');
      continue;
    }
    const plan = item.plan(deps, det);
    if (plan.kind === 'none') {
      res('skipped', plan.why);
      continue;
    }
    let actions: Action[] = [];
    let ownerNote = '';
    if (plan.kind === 'actions') {
      actions = plan.actions;
    } else {
      ownerNote = plan.url ? `${plan.message} (${plan.url})` : plan.message;
      deps.say(`${item.title}: ${ownerNote}`);
      if (item.offer) actions = await item.offer(deps, det);
      if (item.id === 'uv' && deps.platform === 'linux') actions = [...actions, UV_INSTALLER_ACTION];
    }
    const reportOnly = item.optionalKind === 'report_only' && !opts.withOptional;
    if (plan.kind === 'owner' && (actions.length === 0 || reportOnly)) {
      res(item.optionalKind === 'report_only' ? 'skipped' : 'needs_owner', ownerNote, det.version);
      continue;
    }
    if (reportOnly) {
      res('skipped', 'optional, report only (use --with-optional)', det.version);
      continue;
    }
    if (opts.planOnly) {
      for (const a of actions) deps.say(`would run: ${a.needsSudo ? 'sudo ' : ''}${a.argv.join(' ')}`);
      res('skipped', ownerNote ? `plan only; ${ownerNote}` : 'plan only');
      continue;
    }
    let stop: Extract<Step, { kind: 'stop' }> | null = null;
    let ran = false;
    let cur = det;
    for (const a of actions) {
      const s = await runAction(a);
      if (s.kind === 'stop') {
        stop = s;
        break;
      }
      ran = true;
      try {
        cur = await item.detect(deps);
      } catch (e) {
        stop = { kind: 'stop', outcome: 'failed', note: `re-detect failed: ${lastLine(String((e as Error).message ?? e))}` };
        break;
      }
    }
    if (stop && stop.outcome === 'failed') {
      res('failed', stop.note);
    } else if (stop) {
      const note = ownerNote ? `${ownerNote}; ${stop.note}` : stop.note;
      res(plan.kind === 'owner' && stop.outcome === 'skipped' ? 'needs_owner' : stop.outcome, note, undefined, stop.reason);
    } else if (ran && cur.present) {
      res('installed', cur.detail, cur.version);
    } else {
      res('failed', `still missing after install: ${cur.detail}`);
    }
  }
  return results;
}
