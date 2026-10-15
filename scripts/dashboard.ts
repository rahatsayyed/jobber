// scripts/dashboard.ts
// Local owner CLI for the dashboard allowed account and access token. No web equivalent.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { authUrlFor, keysFailureMessage, loadDesktopKeys, redirectFor } from '../src/dash/desktopClient.js';
import { createInterface } from 'node:readline';
import { parseEnv } from '../src/platform/envFile.js';
import { authDbPathFromEnv, resolveAuthMode, validateRunnerConfig, type RunnerEnv } from '../src/web/env.js';
import { pathToFileURL } from 'node:url';
import { audit, getAllowedAccount, listAudit, openAuthStore } from '../src/dash/authStore.js';
import { accountStatus, allowAccount, normaliseEmail } from '../src/dash/account.js';
import { generateToken, setToken, tokenStatus } from '../src/dash/accessToken.js';

export type Parsed =
  | { ok: true; cmd: 'allow'; email: string }
  | { ok: true; cmd: 'status' }
  | { ok: true; cmd: 'google-url' }
  | { ok: true; cmd: 'audit'; n: number }
  | { ok: true; cmd: 'token' | 'rotate'; port: number | null; print: boolean }
  | { ok: false; error: string };

const USAGE =
  'usage: dashboard allow <email> | status | audit [n] | token [--port N] [--print] | rotate [--port N] [--print] | google-url';

export function parseArgs(argv: string[]): Parsed {
  const [cmd, ...rest] = argv;
  if (cmd === 'allow') {
    if (rest.length !== 1) return { ok: false, error: USAGE };
    return { ok: true, cmd: 'allow', email: rest[0] };
  }
  if (cmd === 'token' || cmd === 'rotate') {
    let port: number | null = null;
    let print = false;
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--print') { print = true; continue; }
      if (rest[i] === '--port') {
        const v = rest[i + 1];
        if (port !== null || v === undefined || !/^\d+$/.test(v)) return { ok: false, error: USAGE };
        const n = Number(v);
        if (n < 1024 || n > 65535) return { ok: false, error: USAGE };
        port = n;
        i++;
        continue;
      }
      return { ok: false, error: USAGE };
    }
    return { ok: true, cmd, port, print };
  }
  if (cmd === 'google-url') {
    return rest.length === 0 ? { ok: true, cmd: 'google-url' } : { ok: false, error: USAGE };
  }
  if (cmd === 'status') {
    return rest.length === 0 ? { ok: true, cmd: 'status' } : { ok: false, error: USAGE };
  }
  if (cmd === 'audit') {
    if (rest.length > 1) return { ok: false, error: USAGE };
    if (rest.length === 0) return { ok: true, cmd: 'audit', n: 50 };
    if (!/^\d+$/.test(rest[0])) return { ok: false, error: USAGE };
    const n = Number(rest[0]);
    if (n < 1) return { ok: false, error: USAGE };
    return { ok: true, cmd: 'audit', n: Math.min(200, n) };
  }
  return { ok: false, error: USAGE };
}

function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question + ' ', (a) => { rl.close(); resolve(/^y(es)?$/i.test(a.trim())); });
  });
}

export interface CliIo {
  env?: RunnerEnv;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  isTTY?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  now?: () => Date;
  random?: (n: number) => Buffer;
  readFile?: (path: string) => string;
}

export async function main(argv: string[], io: CliIo = {}): Promise<number> {
  const out = io.stdout ?? ((l: string) => console.log(l));
  const err = io.stderr ?? ((l: string) => console.error(l));
  const ask = io.confirm ?? confirm;
  const p = parseArgs(argv);
  if (!p.ok) { err(p.error); return 1; }
  let env: RunnerEnv;
  if (io.env) env = io.env;
  else {
    const envFile = join(process.cwd(), '.env');
    const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
    env = { ...fileEnv, ...process.env };
  }
  if (p.cmd === 'google-url') {
    // Offline and read-only: no auth store, no network. The throwaway state and challenge are never stored.
    const cfgRes = validateRunnerConfig({ ...env, WEB_AUTH_MODE: 'google_desktop' }, { accountStored: true });
    if (!cfgRes.ok) {
      for (const e of cfgRes.errors) err(e.message);
      return 1;
    }
    const c = cfgRes.config;
    const read = io.readFile ?? ((f: string) => readFileSync(f, 'utf8'));
    const keysPath = isAbsolute(c.googleKeysPath) ? c.googleKeysPath : join(process.cwd(), c.googleKeysPath);
    const k = loadDesktopKeys(keysPath, read);
    if (!k.ok) { err(keysFailureMessage(k.reason)); return 1; }
    const rnd = io.random ?? ((n: number) => randomBytes(n));
    const b64u = (b: Buffer): string => b.toString('base64url');
    const challenge = b64u(createHash('sha256').update(b64u(rnd(32))).digest());
    out(authUrlFor(k.client, redirectFor(c.googleRedirectShape, c.port), b64u(rnd(24)), challenge));
    out('Open this in a browser. Google showing the account chooser means the redirect shape is accepted; redirect_uri_mismatch means it is not. Nothing is signed in by this URL.');
    return 0;
  }
  const isTTY = io.isTTY ?? process.stdout.isTTY === true;
  const db = openAuthStore(authDbPathFromEnv(env));
  try {
    const now = io.now ? io.now() : new Date();
    if (p.cmd === 'token' || p.cmd === 'rotate') {
      if (!isTTY && !p.print) { err('run this in a terminal; the token is shown once'); return 1; }
      let port = p.port;
      if (port === null) {
        const raw = (env.WEB_PORT ?? '').trim();
        if (raw === '') port = 8787;
        else if (/^\d+$/.test(raw) && Number(raw) >= 1024 && Number(raw) <= 65535) port = Number(raw);
        else { err('WEB_PORT must be an integer from 1024 to 65535'); return 1; }
      }
      const exists = tokenStatus(db).set;
      if (p.cmd === 'token' && exists) { err('an access token already exists: use rotate to replace it'); return 1; }
      if (p.cmd === 'rotate') {
        if (!exists) { err('no access token yet: use token'); return 1; }
        const yes = await ask('Replace the access token and sign out every session? (y/N)');
        if (!yes) { out('unchanged'); return 1; }
      }
      const token = generateToken(io.random);
      setToken(db, token, now);
      audit(db, p.cmd === 'token' ? 'token_created' : 'token_rotated', { note: 'owner cli' }, now);
      out('Dashboard access token (shown once, not stored anywhere readable):');
      out(`http://127.0.0.1:${port}/#token=${token}`);
      return 0;
    }
    if (p.cmd === 'allow') {
      const e = normaliseEmail(p.email);
      if (e === null) { err('invalid email address'); return 1; }
      if (getAllowedAccount(db)) {
        const yes = await ask('Replace the allowed account and clear the pinned identity? (y/N)');
        if (!yes) { out('unchanged'); return 1; }
      }
      const r = allowAccount(db, e, now);
      if (!r.ok) { err('invalid email address'); return 1; }
      audit(db, 'allow_changed', { note: 'owner cli' }, now);
      out(`allowed account set to ${e}; the next successful sign-in pins the account`);
      return 0;
    }
    if (p.cmd === 'status') {
      const m = resolveAuthMode(env);
      if ('error' in m) out('auth mode: invalid (WEB_AUTH_MODE is not a known mode)');
      else out(`auth mode: ${m.mode}${m.implicit ? ' (implicit)' : ''}`);
      const t = tokenStatus(db);
      out(`access token set: ${t.set ? 'yes' : 'no'}`);
      if (t.set) {
        out(`token created at: ${t.createdAt}`);
        out(`token rotated at: ${t.rotatedAt ?? 'never'}`);
      }
      const s = accountStatus(db, now);
      if (!s) { out('no allowed account set'); return 0; }
      out(`allowed email: ${s.email}`);
      out(`sub pinned: ${s.pinned ? 'yes' : 'no'}`);
      out(`pinned at: ${s.pinnedAt ?? 'n/a'}`);
      out(`active sessions: ${s.activeSessions}`);
      return 0;
    }
    if (p.cmd !== 'audit') return 1;
    for (const r of listAudit(db, p.n)) {
      out(`${r.at}  ${r.kind}  ${r.ip ?? '-'}  ${r.note ?? ''}`.trimEnd());
    }
    return 0;
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; });
}
