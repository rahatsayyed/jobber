// scripts/restore.ts
// Usage: restore <archive> --identity <age key file> [--drill] [--apply --confirm "RESTORE <name>"] [--with-secrets]
// Default is verify only. The identity path comes only from --identity (never .env) and its contents are never read here.
// Nothing prints file contents: only names, counts and verdicts.
import { basename, join, resolve } from 'node:path';
import {
  applyRestore, drill, nodeRestoreFs, planRestore, restoreStamp, unpackWithAge, verifyArchive, walSiblings,
  type RestoreDeps, type VerifyReport,
} from '../src/backup/restore.js';
import { nodeStateFs, readBackupState, writeBackupState } from '../src/backup/state.js';
import { defaultExec } from '../src/lib/exec.js';
import { checkSnapshot } from '../src/lib/sqliteSnapshot.js';
import { runLock } from '../src/update/lockAdapter.js';

const root = resolve(import.meta.dirname, '..');

function parseArgs(argv: string[]): { flags: Set<string>; values: Record<string, string>; positional: string[] } {
  const flags = new Set<string>();
  const values: Record<string, string> = {};
  const positional: string[] = [];
  const withValue = new Set(['--identity', '--confirm']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (withValue.has(a)) values[a] = argv[++i] ?? '';
    else if (a.startsWith('--')) flags.add(a);
    else positional.push(a);
  }
  return { flags, values, positional };
}

function printSummary(r: VerifyReport): void {
  const m = r.manifest;
  if (m) {
    console.log(`created: ${m.created_at}`);
    console.log(`commit: ${m.commit ?? 'unknown'}`);
    console.log(`includes secrets: ${m.includes_secrets}`);
    console.log(`files: ${m.files.length}`);
    console.log('tables:');
    for (const [t, n] of Object.entries(m.db.tables)) console.log(`  ${t}: ${n}`);
  } else {
    console.log('manifest: unavailable');
  }
  console.log(`verify: ${r.ok ? 'ok' : 'FAILED'} (integrity ${r.integrity})`);
  for (const p of r.problems) console.log(`  problem: ${p}`);
  if (r.ignored.length > 0) console.log(`ignored: ${r.ignored.join(', ')}`);
}

async function main(): Promise<number> {
  const { flags, values, positional } = parseArgs(process.argv.slice(2));
  const archivePath = positional[0] ? resolve(positional[0]) : '';
  const identityPath = values['--identity'] ? resolve(values['--identity']) : '';
  if (!archivePath || !identityPath) {
    console.error('usage: restore <archive> --identity <key file> [--drill | --apply --confirm "RESTORE <name>" [--with-secrets]]');
    return 2;
  }
  const exec = defaultExec;
  const deps: RestoreDeps = {
    exec,
    fs: nodeRestoreFs,
    checkSnapshot,
    unpack: unpackWithAge(),
    lock: runLock(join(root, '.jobber')),
    state: {
      load: () => readBackupState(nodeStateFs, root),
      save: (s) => writeBackupState(nodeStateFs, root, s),
    },
    now: () => new Date(),
  };

  const ageProbe = await exec('age', ['--version']);
  if (ageProbe.code !== 0) {
    console.error('restore: age is not installed or not working (brew install age)');
    return 1;
  }

  if (flags.has('--drill')) {
    const r = await drill(deps, { archivePath, identityPath, liveDbPath: join(root, 'data.sqlite') });
    printSummary(r);
    if (r.liveTableMissingInBackup.length > 0) {
      console.log(`live tables missing in the backup: ${r.liveTableMissingInBackup.join(', ')}`);
    }
    console.log(r.ok ? 'drill: ok (last_drill_at recorded)' : 'drill: FAILED');
    return r.ok ? 0 : 1;
  }

  const report = await verifyArchive(deps, { archivePath, identityPath });
  printSummary(report);
  const head = await exec('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 10_000 });
  const headSha = head.code === 0 ? head.stdout.trim() : '';
  if (report.manifest?.commit && headSha && report.manifest.commit !== headSha) {
    console.log(`hint: this backup was taken at commit ${report.manifest.commit}; current HEAD is ${headSha}`);
  }
  if (!report.ok || report.manifest === null) return 1;
  if (!flags.has('--apply')) {
    console.log('verify only: nothing was changed. Re-run with --apply --confirm "RESTORE <archive name>" to restore.');
    return 0;
  }

  const confirm = values['--confirm'] ?? '';
  const withSecrets = flags.has('--with-secrets');
  const stamp = restoreStamp(deps.now());
  const plan = planRestore(report.manifest, root, (p) => nodeRestoreFs.exists(p), { withSecrets, stamp });
  console.log('plan:');
  if (plan.some((p) => p.archivePath === 'data.sqlite')) {
    for (const s of walSiblings(root, (p) => nodeRestoreFs.exists(p), stamp)) {
      console.log(`  move aside ${basename(s.target)} -> ${basename(s.moveAsideTo)}`);
    }
  }
  for (const p of plan) {
    if (p.action === 'skip-secret') console.log(`  skip (secret, needs --with-secrets) ${p.archivePath}`);
    else if (p.moveAsideTo) console.log(`  replace ${p.archivePath}; old copy moves to ${basename(p.moveAsideTo)}`);
    else console.log(`  create ${p.archivePath}`);
  }
  const tmux = await exec('tmux', ['list-windows', '-a', '-F', '#{session_name}:#{window_name}'], { timeoutMs: 5000 });
  if (tmux.code === 0 && tmux.stdout.trim()) console.log(`hint: tmux windows that may use the database:\n${tmux.stdout.trim()}`);
  console.log('warning: stop every session that uses the database (hunt, MCP servers, scheduler) before restoring.');

  try {
    const r = await applyRestore(deps, { archivePath, identityPath, root, withSecrets, confirm });
    console.log(`restored ${r.restored.length} file(s); ${r.moved.length} existing file(s) moved aside (kept, never deleted)`);
    console.log('next: restart sessions, run /checkreplies and check Gmail Sent before the next hunt, so nothing is sent twice.');
    return 0;
  } catch (e) {
    console.error(`restore: not applied: ${(e as Error).message}`);
    return 1;
  }
}

main().then(
  (code) => process.exit(code),
  () => {
    console.error('restore: unexpected failure');
    process.exit(1);
  },
);
