// src/setup/envWriter.ts
// Comment-preserving .env updates plus an atomic, mode-600 file write with a backup.
// Values are never logged and never put into an error message.
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

export interface EnvUpdateResult {
  text: string;
  changed: string[];
  unchanged: string[];
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LINE_RE = /^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

interface ParsedValue {
  value: string;
  comment: string | null;
}

/** Read the value part of a line the way the loaders do (outer quotes stripped), plus any inline comment. */
function parseValue(raw: string): ParsedValue {
  const rest = raw.replace(/^\s+/, '');
  const q = rest[0];
  if (q === '"') {
    let out = '';
    for (let i = 1; i < rest.length; i++) {
      const c = rest[i];
      if (c === '\\' && i + 1 < rest.length && (rest[i + 1] === '"' || rest[i + 1] === '\\')) {
        out += rest[i + 1];
        i++;
      } else if (c === '"') {
        const tail = rest.slice(i + 1).trim();
        return { value: out, comment: tail.startsWith('#') ? tail.slice(1).trim() : null };
      } else {
        out += c;
      }
    }
  } else if (q === "'") {
    const end = rest.indexOf("'", 1);
    if (end > 0) {
      const tail = rest.slice(end + 1).trim();
      return { value: rest.slice(1, end), comment: tail.startsWith('#') ? tail.slice(1).trim() : null };
    }
  }
  const m = /\s+#/.exec(rest);
  if (m) return { value: rest.slice(0, m.index).trim(), comment: rest.slice(m.index + m[0].length).trim() };
  return { value: rest.trim(), comment: null };
}

function formatValue(v: string): string {
  if (/[\s#"'$\\]/.test(v)) return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  return v;
}

/** Set keys in existing .env text. Preserves every other line byte for byte.
 *  - key present: replace the value on its (last) line; keep an "export " prefix;
 *    an inline " # comment" on that line is moved to its own comment line directly above.
 *  - key absent: append "KEY=value" at the end (blank line separation kept).
 *  - onlyIfMissing: skip keys whose current value is non-empty.
 *  - values containing whitespace, '#', quotes or '$' are written double-quoted with \" and \\ escaped.
 *  - throws on a key not matching ^[A-Za-z_][A-Za-z0-9_]*$ and on a value containing \n or \r. */
export function updateEnvText(
  text: string,
  updates: Record<string, string>,
  opts?: { onlyIfMissing?: boolean },
): EnvUpdateResult {
  for (const [k, v] of Object.entries(updates)) {
    if (!KEY_RE.test(k)) throw new Error('invalid env key name');
    if (/[\r\n]/.test(v)) throw new Error(`invalid value for ${k}: contains a line break`);
  }
  const lines = text === '' ? [] : text.split('\n');
  const changed: string[] = [];
  const unchanged: string[] = [];
  const toAppend: string[] = [];

  for (const [key, newValue] of Object.entries(updates)) {
    let idx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = LINE_RE.exec(lines[i].replace(/\r$/, ''));
      if (m && m[3] === key) {
        idx = i;
        break;
      }
    }
    if (idx < 0) {
      toAppend.push(`${key}=${formatValue(newValue)}`);
      changed.push(key);
      continue;
    }
    const cr = lines[idx].endsWith('\r') ? '\r' : '';
    const m = LINE_RE.exec(lines[idx].replace(/\r$/, ''))!;
    const parsed = parseValue(m[4]);
    if (opts?.onlyIfMissing && parsed.value !== '') {
      unchanged.push(key);
      continue;
    }
    if (parsed.value === newValue && parsed.comment === null) {
      unchanged.push(key);
      continue;
    }
    const indent = m[1];
    const newLine = `${indent}${m[2] ?? ''}${key}=${formatValue(newValue)}${cr}`;
    const out: string[] = [];
    if (parsed.comment !== null && parsed.comment !== '') out.push(`${indent}# ${parsed.comment}${cr}`);
    out.push(newLine);
    lines.splice(idx, 1, ...out);
    changed.push(key);
  }

  if (toAppend.length > 0) {
    // lines ends with '' when the text ended in a newline: drop it, add the new lines, restore it
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    lines.push(...toAppend, '');
  }
  return { text: lines.join('\n'), changed, unchanged };
}

export interface EnvFs {
  exists(p: string): boolean;
  read(p: string): string;
  write(p: string, data: string, mode: number): void; // writes a file with this mode
  rename(from: string, to: string): void;
  chmod(p: string, mode: number): void;
  /** Optional: used to clean up a partial temp file when the write or rename fails. */
  remove?(p: string): void;
}

/** Atomic: write `<path>.tmp-<pid>` mode 600, rename over `path`, chmod 600.
 *  Before changing an existing file, copy it to `<path>.bak-<timestamp>` mode 600 (matches .gitignore `.env.*`).
 *  Returns the backup path or null. Never logs values. */
export function writeEnvFile(path: string, text: string, fs: EnvFs, now: () => Date): string | null {
  let backup: string | null = null;
  if (fs.exists(path)) {
    const old = fs.read(path);
    if (old === text) return null;
    backup = `${path}.bak-${now().toISOString().replace(/[:.]/g, '-')}`;
    fs.write(backup, old, 0o600);
    fs.chmod(backup, 0o600);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    fs.write(tmp, text, 0o600);
    fs.chmod(tmp, 0o600);
    fs.rename(tmp, path);
  } catch (e) {
    try {
      fs.remove?.(tmp);
    } catch {
      /* best effort */
    }
    throw new Error(`could not write env file: ${(e as Error).message}`);
  }
  fs.chmod(path, 0o600);
  return backup;
}

export const nodeEnvFs: EnvFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, data, mode) => {
    writeFileSync(p, data, { mode });
    chmodSync(p, mode);
  },
  rename: (from, to) => renameSync(from, to),
  chmod: (p, mode) => chmodSync(p, mode),
  remove: (p) => rmSync(p, { force: true }),
};
