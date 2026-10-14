export interface Manifest {
  version: 1;
  created_at: string;
  commit: string | null;
  includes_secrets: boolean;
  files: { path: string; sha256: string; bytes: number }[];
  db: { path: 'data.sqlite'; tables: Record<string, number> };
}

export function isSafeArchivePath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    p.length > 0 &&
    !p.startsWith('/') &&
    !/^[A-Za-z]:/.test(p) &&
    !p.includes('\\') &&
    !/[\0-\x1f\x7f]/.test(p) &&
    !p.split('/').some((s) => s === '..' || s === '' || s === '.')
  );
}

export function buildManifest(args: Omit<Manifest, 'version'>): Manifest {
  return { version: 1, ...args };
}

export function parseManifest(text: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('manifest is not valid JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('manifest is not an object');
  const m = raw as Record<string, unknown>;
  if (m.version !== 1) throw new Error('unsupported manifest version');
  if (typeof m.created_at !== 'string' || Number.isNaN(Date.parse(m.created_at))) {
    throw new Error('manifest created_at is invalid');
  }
  if (m.commit !== null && typeof m.commit !== 'string') throw new Error('manifest commit is invalid');
  if (typeof m.includes_secrets !== 'boolean') throw new Error('manifest includes_secrets is invalid');
  if (!Array.isArray(m.files)) throw new Error('manifest files is invalid');
  const files = m.files.map((f: unknown) => {
    if (!f || typeof f !== 'object') throw new Error('manifest file entry is invalid');
    const e = f as Record<string, unknown>;
    if (!isSafeArchivePath(e.path)) throw new Error('manifest file path is unsafe');
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) {
      throw new Error('manifest file sha256 is invalid');
    }
    if (typeof e.bytes !== 'number' || !Number.isInteger(e.bytes) || e.bytes < 0) {
      throw new Error('manifest file bytes is invalid');
    }
    return { path: e.path, sha256: e.sha256, bytes: e.bytes };
  });
  const db = m.db as Record<string, unknown> | null;
  if (!db || typeof db !== 'object' || db.path !== 'data.sqlite') throw new Error('manifest db is invalid');
  const tables: Record<string, number> = {};
  const rawTables = db.tables;
  if (!rawTables || typeof rawTables !== 'object' || Array.isArray(rawTables)) {
    throw new Error('manifest db tables is invalid');
  }
  for (const [k, v] of Object.entries(rawTables as Record<string, unknown>)) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error('manifest db table count is invalid');
    tables[k] = v;
  }
  return {
    version: 1,
    created_at: m.created_at,
    commit: m.commit as string | null,
    includes_secrets: m.includes_secrets,
    files,
    db: { path: 'data.sqlite', tables },
  };
}

/** `actual` optionally lists every path present, so files not in the manifest are reported as extra. */
export function verifyFiles(
  m: Manifest,
  hashOf: (p: string) => string | null,
  actual: string[] = [],
): { ok: boolean; missing: string[]; mismatched: string[]; extra: string[] } {
  const missing: string[] = [];
  const mismatched: string[] = [];
  for (const f of m.files) {
    const h = hashOf(f.path);
    if (h === null) missing.push(f.path);
    else if (h !== f.sha256) mismatched.push(f.path);
  }
  const known = new Set(m.files.map((f) => f.path));
  const extra = actual.filter((p) => !known.has(p));
  return { ok: !missing.length && !mismatched.length && !extra.length, missing, mismatched, extra };
}
