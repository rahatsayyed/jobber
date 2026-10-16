// scripts/settings.ts
// Read-only settings CLI (plan 8H, Task 9): list | get <KEY> | check | backups | diff <backupId>.
// It never changes anything: the filesystem it is given has its mutating methods replaced by throwing stubs, and a
// secret value is never printed (secret keys, and every key the catalog does not know, show words only).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from '../src/platform/envFile.js';
import { nodeAtomicFs, type AtomicFs } from '../src/settings/atomic.js';
import { listBackups, readBackup } from '../src/settings/backups.js';
import { lineDiff } from '../src/settings/diff.js';
import { validateCross, validateEnvValue } from '../src/settings/valueCheck.js';
import { isSecret, type EnvSpec } from '../src/settings/types.js';

export interface CliDeps {
  catalog: readonly EnvSpec[];
  fs: AtomicFs;
  envPath: string;
  backupDir: string;
}
export interface CliResult {
  code: number;
  out: string;
}

const USAGE = 'usage: npm run settings -- <list|get KEY|check|backups|diff BACKUP_ID>';

/** Wrap a filesystem so any mutation throws. The CLI only ever needs read, exists, list. */
export function readOnlyFs(base: AtomicFs): AtomicFs {
  const no = (): never => {
    throw new Error('read-only settings CLI');
  };
  return { ...base, write: no, rename: no, chmod: no, remove: no, mkdir: no };
}

function envText(d: CliDeps): string {
  return d.fs.exists(d.envPath) ? d.fs.read(d.envPath) : '';
}

const isSet = (v: string | undefined): boolean => v !== undefined && v.trim() !== '';

export function runCli(argv: readonly string[], d: CliDeps): CliResult {
  const [cmd, arg] = argv;
  const by = new Map(d.catalog.map((s) => [s.key, s]));
  const lines: string[] = [];
  const out = (code: number): CliResult => ({ code, out: lines.join('\n') + (lines.length ? '\n' : '') });

  if (cmd === 'list') {
    const env = parseEnv(envText(d));
    for (const s of d.catalog) lines.push(`${s.key}  ${isSet(env[s.key]) ? 'set' : 'unset'}`);
    const unknown = Object.keys(env).filter((k) => !by.has(k));
    if (unknown.length) lines.push(`not in catalog (names only): ${unknown.join(', ')}`);
    return out(0);
  }

  if (cmd === 'get') {
    const spec = arg ? by.get(arg) : undefined;
    if (!arg || !spec) {
      lines.push(arg ? 'unknown key (not in the catalog)' : USAGE);
      return out(1);
    }
    const v = parseEnv(envText(d))[arg];
    if (isSecret(spec)) lines.push(`secret: ${isSet(v) ? 'set' : 'not set'}`);
    else lines.push(isSet(v) ? `${arg}=${v}` : `${arg}: unset${spec.default !== null ? ` (default ${spec.default})` : ''}`);
    return out(0);
  }

  if (cmd === 'check') {
    if (d.catalog.length === 0) {
      lines.push('check: no catalog loaded (the settings catalog is absent or empty); nothing was checked');
      return out(1);
    }
    const env = parseEnv(envText(d));
    let problems = 0;
    for (const s of d.catalog) {
      const v = env[s.key];
      if (!isSet(v)) {
        if (s.required === 'required') {
          lines.push(`${s.key}: required but not set`);
          problems++;
        }
        continue;
      }
      const why = validateEnvValue(s, v as string);
      if (why) {
        lines.push(`${s.key}: ${why}`);
        problems++;
      }
    }
    for (const msg of validateCross(env, d.catalog)) {
      lines.push(msg);
      problems++;
    }
    const unknown = Object.keys(env).filter((k) => !by.has(k));
    if (unknown.length) lines.push(`note: not in catalog (kept, names only): ${unknown.join(', ')}`);
    lines.push(problems ? `check: ${problems} problem(s)` : 'check: ok');
    return out(problems ? 1 : 0);
  }

  if (cmd === 'backups') {
    const list = listBackups({ fs: d.fs, backupDir: d.backupDir }, 'env');
    if (!list.length) lines.push('no env backups');
    for (const b of list) lines.push(`${b.id}  ${b.at}  ${b.bytes} bytes`);
    return out(0);
  }

  if (cmd === 'diff') {
    if (!arg) {
      lines.push(USAGE);
      return out(1);
    }
    let old: string;
    try {
      old = readBackup({ fs: d.fs, backupDir: d.backupDir }, 'env', arg);
    } catch (e) {
      lines.push(e instanceof Error ? e.message : 'could not read the backup');
      return out(1);
    }
    const mask = (line: string): string => {
      const m = /^(\s*(?:#\s*)?(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!m) return line;
      const spec = by.get(m[2]);
      if (spec && !isSecret(spec)) return line;
      return `${m[1]}${m[2]}=<hidden>`;
    };
    const diff = lineDiff(old, envText(d));
    if (diff.truncated) lines.push('diff too large to show');
    else if (diff.unchanged) lines.push('no differences');
    else {
      for (const l of diff.lines) if (l.op !== 'eq') lines.push(`${l.op === 'add' ? '+' : '-'} ${mask(l.text)}`);
      lines.push(`added ${diff.added}, removed ${diff.removed}, formatting only ${diff.formattingOnly}`);
    }
    return out(0);
  }

  lines.push(USAGE);
  return out(1);
}

async function loadCatalog(): Promise<readonly EnvSpec[]> {
  try {
    const catalogPath = '../src/settings/envCatalog.js';
    const mod = (await import(catalogPath)) as { ENV_CATALOG?: readonly EnvSpec[] };
    if (Array.isArray(mod.ENV_CATALOG)) return mod.ENV_CATALOG;
  } catch {
    /* no catalog yet */
  }
  return [];
}

async function main(): Promise<number> {
  const root = process.cwd();
  const envPath = join(root, '.env');
  const r = runCli(process.argv.slice(2), {
    catalog: await loadCatalog(),
    fs: readOnlyFs(nodeAtomicFs),
    envPath,
    backupDir: join(root, '.jobber', 'settings-backups'),
  });
  process.stdout.write(r.out);
  return r.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((c) => process.exit(c));
}
