// src/bootstrap/exec.ts
// Consent-gated executor: detection first, then actions under the consent table, then a result table.
import { redactPane } from '../platform/redact.js';
import { UV_INSTALLER_ACTION } from './catalog.js';
import type { Action, BootstrapDeps, Detection, Item, ItemId } from './types.js';

export type Outcome = 'ok' | 'installed' | 'skipped' | 'needs_owner' | 'failed' | 'unsupported';
export interface ItemResult {
  id: ItemId;
  title: string;
  required: boolean;
  outcome: Outcome;
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
}

const DEPENDS: Partial<Record<ItemId, ItemId>> = { ccgram: 'uv', 'npm-deps': 'node', 'renderer-deps': 'npm-deps' };

/** 1 when a required item is failed or needs the owner. */
export function exitCodeFor(results: ItemResult[]): 0 | 1 {
  return results.some((r) => r.required && (r.outcome === 'failed' || r.outcome === 'needs_owner')) ? 1 : 0;
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

type Step = { kind: 'done' } | { kind: 'stop'; outcome: Outcome; note: string };

export async function runBootstrap(items: Item[], deps: ExecDeps, opts: ExecOptions): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  const byId = new Map<ItemId, ItemResult>();
  const selected = opts.only ? items.filter((i) => opts.only!.includes(i.id)) : items;

  const runAction = async (a: Action): Promise<Step> => {
    let argv = a.argv;
    if (a.downloadsScript) {
      // Second ask always happens, whatever --yes says; never piped to a shell.
      const dir = deps.mkTempDir();
      const dl = await deps.download(a.url ?? '', dir);
      deps.say(`downloaded ${a.url} (${dl.bytes} bytes, sha256 ${dl.sha256})`);
      deps.say(deps.fs.read(dl.path).split('\n').slice(0, 40).join('\n'));
      if (!opts.interactive) return { kind: 'stop', outcome: 'needs_owner', note: 'script review needs a terminal' };
      if (!(await deps.ask(`run the downloaded script ${dl.path}?`))) return { kind: 'stop', outcome: 'skipped', note: 'script declined' };
      argv = a.argv.map((x) => (x === '{script}' ? dl.path : x));
    } else if (a.needsSudo) {
      deps.say(`needs sudo: sudo ${argv.join(' ')}`);
      if (!opts.allowSudo) {
        if (!opts.interactive) return { kind: 'stop', outcome: 'needs_owner', note: `needs sudo: run sudo ${argv.join(' ')}` };
        if (!(await deps.ask('run with sudo?'))) return { kind: 'stop', outcome: 'skipped', note: 'sudo declined' };
      }
    } else {
      deps.say(`action: ${a.summary}`);
      if (!opts.yes) {
        if (!opts.interactive) return { kind: 'stop', outcome: 'skipped', note: 'needs --yes' };
        if (!(await deps.ask(`run: ${argv.join(' ')}?`))) return { kind: 'stop', outcome: 'skipped', note: 'declined' };
      }
    }
    const full = a.needsSudo && !a.downloadsScript ? ['sudo', ...argv] : argv;
    const [cmd, ...args] = full;
    const r = await deps.run(cmd!, args, a.cwd ? { cwd: a.cwd } : undefined);
    if (r.code !== 0) return { kind: 'stop', outcome: 'failed', note: `${a.id} failed: ${lastLine(r.stdout)}` };
    return { kind: 'done' };
  };

  for (const item of selected) {
    const res = (outcome: Outcome, note: string, version?: string): void => {
      const r: ItemResult = { id: item.id, title: item.title, required: item.required, outcome, note, ...(version ? { version } : {}) };
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
      const d = byId.get(dep);
      if (d && d.outcome !== 'ok' && d.outcome !== 'installed') {
        res('skipped', `waiting for ${dep}`);
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
      cur = await item.detect(deps);
    }
    if (stop && stop.outcome === 'failed') {
      res('failed', stop.note);
    } else if (stop) {
      const note = ownerNote ? `${ownerNote}; ${stop.note}` : stop.note;
      res(plan.kind === 'owner' && stop.outcome === 'skipped' ? 'needs_owner' : stop.outcome, note);
    } else if (ran && cur.present) {
      res('installed', cur.detail, cur.version);
    } else {
      res('failed', `still missing after install: ${cur.detail}`);
    }
  }
  return results;
}
