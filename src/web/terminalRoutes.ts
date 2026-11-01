// src/web/terminalRoutes.ts
// Live terminal view of the Jobber tmux sessions for the dashboard Sessions page.
//
// How it works (no pty, no WebSocket): the page opens a Server-Sent Events stream; the server polls `tmux capture-pane -p -e` for the
// pane (SGR colours kept) and sends a frame only when the screen changed. xterm.js in the browser repaints each frame. Typing, when it is
// enabled, is a separate POST that goes through `tmux send-keys`. Both routes sit behind the same signed session cookie, Host check, rate
// limit and (for POST) CSRF and Origin checks as every other dashboard route, because they are registered through the same `add()` in
// server.ts; there is no open endpoint here. SSE is used instead of a WebSocket because the Next server in front of this API can only
// proxy plain HTTP responses (apps/dashboard/src/lib/dashboard-proxy.ts streams the body through).
//
// Safety:
// - Only sessions in the allowlist (allowedTerminalSessions) are listed, streamed or typed into. The client-supplied names are matched
//   against that list and against the live tmux window list; a name that matches neither is refused (404) before any tmux call that
//   would use it.
// - Input is OFF unless WEB_TERMINAL_INPUT=true. The permission-set rule of the chat box applies: keep the target tmux window on the
//   read_only permission set, because anything typed here runs under that window's session.
// - The kill switch (.jobber/STOP, JOBBER_KILL=1) stops the stream and refuses input, like the other irreversible paths.
// - Terminal content and typed keys are never logged or audited (only the session and window name and the open event are). Pane text is
//   passed through the configured secret redaction before it leaves the server.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { audit, type AuthDb } from '../dash/authStore.js';
import { cleanText } from '../dash/clean.js';
import { assertName, listWindows, type Run } from '../platform/tmux.js';
import { HttpError, json, readJson, type Ctx } from './router.js';

export interface TerminalDeps {
  run: Run;
  /** Session names that may be shown. Everything else is invisible and refused. */
  sessions: readonly string[];
  /** WEB_TERMINAL_INPUT=true. Default false: view only. */
  inputEnabled: boolean;
  /** True while the kill switch is on. */
  killed: () => boolean;
  /** Masks literal secret values in pane text. */
  redact: (text: string) => string;
  /** Poll interval in ms (tests lower it). */
  pollMs?: number;
  /** A stream ends after this many ms and the browser reconnects on its own. */
  maxStreamMs?: number;
}

export interface TerminalRoute { method: 'GET' | 'POST'; pattern: string; fn: (c: Ctx) => Promise<void> | void }

/** Default session names shown in the terminal: the dashboard chat target, the ccgram pair and the stack session (docs/reference/platform-and-sessions.md). */
export function allowedTerminalSessions(env: Record<string, string | undefined>, chatSession: string): string[] {
  const stack = (env.STACK_TMUX_SESSION ?? '').trim() || 'jobber-stack';
  const out: string[] = [];
  for (const name of [chatSession, 'ccgram', 'ccgram-daemon', stack]) {
    try {
      assertName(name);
    } catch {
      continue;
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** True when the kill switch is on: the STOP file in the project, or JOBBER_KILL=1. */
export function terminalKilled(root: string, env: Record<string, string | undefined>): boolean {
  return env.JOBBER_KILL === '1' || existsSync(join(root, '.jobber', 'STOP'));
}

/** Returns the pair when the session is in the allowlist and both names are valid tmux names; otherwise null. Pure. */
export function matchTerminalTarget(allow: readonly string[], session: unknown, window: unknown): { session: string; window: string } | null {
  if (typeof session !== 'string' || typeof window !== 'string') return null;
  const s = allow.find((a) => a === session);
  if (!s) return null;
  try {
    assertName(s);
    assertName(window);
  } catch {
    return null;
  }
  return { session: s, window };
}

const ARROWS: Record<string, string> = { A: 'Up', B: 'Down', C: 'Right', D: 'Left', H: 'Home', F: 'End' };
const MAX_KEYS = 256;

/**
 * Turns what xterm.js sends for keystrokes into `tmux send-keys` argument lists (each list is one call, after `-t <target>`).
 * Printable text becomes one literal `-l` call; known control keys become key names; unknown control bytes are dropped. Pure.
 */
export function keysToTmux(data: string): string[][] {
  const calls: string[][] = [];
  let lit = '';
  const flush = (): void => {
    if (lit) calls.push(['-l', '--', lit]);
    lit = '';
  };
  const chars = Array.from(data.slice(0, MAX_KEYS));
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const c = ch.codePointAt(0) as number;
    if (ch === '\x1b') {
      const m = /^\x1b\[(?:1;\d)?([ABCDHF])/.exec(chars.slice(i, i + 8).join(''));
      const del = /^\x1b\[3~/.test(chars.slice(i, i + 4).join(''));
      flush();
      if (m) {
        calls.push([ARROWS[m[1]]]);
        i += m[0].length - 1;
      } else if (del) {
        calls.push(['DC']);
        i += 3;
      } else calls.push(['Escape']);
      continue;
    }
    if (ch === '\r' || ch === '\n') { flush(); calls.push(['Enter']); continue; }
    if (ch === '\x7f' || ch === '\b') { flush(); calls.push(['BSpace']); continue; }
    if (ch === '\t') { flush(); calls.push(['Tab']); continue; }
    if (c >= 1 && c <= 26) { flush(); calls.push([`C-${String.fromCharCode(c + 96)}`]); continue; }
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e)) continue;
    lit += ch;
  }
  flush();
  return calls;
}

export function createTerminalRoutes(deps: TerminalDeps, env: { auth: AuthDb; now: () => Date }): TerminalRoute[] {
  const pollMs = deps.pollMs ?? 600;
  const maxStreamMs = deps.maxStreamMs ?? 10 * 60_000;
  const active = new Map<string, () => void>(); // session id hash -> closer of that client's current stream
  let lastInputAudit = 0;

  async function tmuxUp(): Promise<boolean> {
    return (await deps.run('tmux', ['-V'])).code === 0;
  }

  async function resolve(session: unknown, window: unknown): Promise<{ session: string; window: string }> {
    const t = matchTerminalTarget(deps.sessions, session, window);
    if (!t) throw new HttpError(404, 'not found');
    const wins = await listWindows(deps.run, t.session);
    if (!wins.some((w) => w.name === t.window)) throw new HttpError(404, 'not found');
    return t;
  }

  const listing = async (c: Ctx): Promise<void> => {
    const up = await tmuxUp();
    const sessions: { session: string; up: boolean; windows: { name: string; index: number; active: boolean; command: string }[] }[] = [];
    for (const s of deps.sessions) {
      const wins = up ? await listWindows(deps.run, s) : [];
      sessions.push({
        session: s, up: wins.length > 0,
        windows: wins.map((w) => ({ name: cleanText(w.name, 64), index: w.index, active: w.active, command: cleanText(w.command, 64) })),
      });
    }
    json(c.res, 200, { tmux: up, inputEnabled: deps.inputEnabled, killed: deps.killed(), sessions });
  };

  const stream = async (c: Ctx): Promise<void> => {
    if (deps.killed()) return json(c.res, 423, { error: 'killed' });
    if (!(await tmuxUp())) return json(c.res, 503, { error: 'tmux_missing' });
    const target = await resolve(c.url.searchParams.get('session'), c.url.searchParams.get('window'));
    const spec = `=${target.session}:=${target.window}`;
    const client = c.session!.idHash;
    active.get(client)?.(); // one terminal at a time per client
    audit(env.auth, 'terminal_open', { ip: c.ip, note: `${target.session}:${target.window}` }, env.now());

    const res = c.res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    const send = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };

    await new Promise<void>((done) => {
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      let lastHash = '';
      let lastWrite = Date.now();
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        if (active.get(client) === stop) active.delete(client);
        if (!res.writableEnded) res.end();
        done();
      };
      active.set(client, stop);
      res.on('close', stop);
      const started = Date.now();
      const tick = async (): Promise<void> => {
        if (stopped) return;
        try {
          if (deps.killed()) { send('end', { reason: 'killed' }); return stop(); }
          if (Date.now() - started > maxStreamMs) { send('end', { reason: 'refresh' }); return stop(); }
          const [screen, dims] = await Promise.all([
            deps.run('tmux', ['capture-pane', '-p', '-e', '-t', spec]),
            deps.run('tmux', ['display-message', '-p', '-t', spec, '#{pane_width} #{pane_height} #{cursor_x} #{cursor_y}']),
          ]);
          if (screen.code !== 0 || dims.code !== 0) { send('end', { reason: 'gone' }); return stop(); }
          const [cols, rows, cx, cy] = dims.stdout.trim().split(' ').map((n) => Number(n));
          const text = deps.redact(screen.stdout).slice(0, 200_000);
          const hash = createHash('sha1').update(`${text}\0${cx},${cy}`).digest('hex');
          if (hash !== lastHash) {
            lastHash = hash;
            lastWrite = Date.now();
            send('frame', { cols, rows, cx, cy, text });
          } else if (Date.now() - lastWrite > 15_000) {
            lastWrite = Date.now();
            res.write(': keepalive\n\n');
          }
        } catch {
          send('end', { reason: 'error' });
          return stop();
        }
        if (!stopped) timer = setTimeout(() => { void tick(); }, pollMs);
      };
      send('hello', { session: target.session, window: target.window, inputEnabled: deps.inputEnabled });
      void tick();
    });
  };

  const input = async (c: Ctx): Promise<void> => {
    if (!deps.inputEnabled) return json(c.res, 403, { error: 'input_disabled' });
    if (deps.killed()) return json(c.res, 423, { error: 'killed' });
    const body = await readJson(c.req, 2048);
    const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (typeof o.keys !== 'string' || o.keys.length === 0 || o.keys.length > MAX_KEYS) return json(c.res, 400, { error: 'invalid keys' });
    const target = await resolve(o.session, o.window);
    const spec = `=${target.session}:=${target.window}`;
    for (const args of keysToTmux(o.keys)) {
      const r = await deps.run('tmux', ['send-keys', '-t', spec, ...args]);
      if (r.code !== 0) return json(c.res, 502, { error: 'send failed' });
    }
    const t = env.now();
    if (t.getTime() - lastInputAudit > 60_000) {
      lastInputAudit = t.getTime();
      audit(env.auth, 'terminal_input', { ip: c.ip, note: `${target.session}:${target.window}` }, t); // never the keys
    }
    json(c.res, 200, { ok: true });
  };

  return [
    { method: 'GET', pattern: '/api/terminal/sessions', fn: listing },
    { method: 'GET', pattern: '/api/terminal/stream', fn: stream },
    { method: 'POST', pattern: '/api/terminal/input', fn: input },
  ];
}
