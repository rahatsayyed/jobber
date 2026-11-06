// src/telegram/drip.ts
// `/drip`: status of the two drip lanes and "run one tick now" with a confirm step. The bridge never sends mail or LinkedIn itself: a
// confirmed request is one scheduler_state row (src/scheduler/dripRequest.ts) that the scheduler daemon's own 30 s tick consumes, with
// every gate (kill switch, halts, quiet hours, window, caps, minimum gap, dry run) still applied by the daemon.
// Callback data is short and opaque: `dr:s` (status), `dr:m` / `dr:l` (ask to run mail / linkedin now), `dr:y:<token>` (confirm), `dr:n:<token>` (cancel).
import { randomBytes } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import { loadOutreachConfig } from '../outreach/config.js';
import { ceilings } from '../outreach/limits.js';
import { isDryRun } from '../safety/dryRun.js';
import { readFreshRequest, readRefusal, writeDripRequest, type DripLane } from '../scheduler/dripRequest.js';
import {
  LI_STATE_LAST_ACTION, LI_STATE_NEXT_AT, loadLinkedinDripConfig,
} from '../scheduler/linkedinDrip.js';
import { emailAutoReplyOn } from '../outreach/emailReplyFlags.js';
import { emailRepliesSentToday } from '../outreach/emailReplies.js';
import { STATE_NEXT_AT, emailBrakeOn, lastSendAt, loadDripConfig, sentToday } from '../scheduler/mailDrip.js';
import { getState } from '../scheduler/runLog.js';

export interface Button { text: string; data: string }

export interface DripIo {
  env: NodeJS.ProcessEnv;
  openDb(): BetterSqlite3.Database;
  now(): Date;
  killed(): { stopped: boolean; reason: string };
  reply(markdown: string): Promise<void>;
  sendButtons(markdown: string, rows: Button[][]): Promise<void>;
}

export const CONFIRM_TTL_MS = 2 * 60_000;
const MAX_TOKENS = 20;
export const CALLBACK_PREFIX = 'dr:';
export const MAX_CALLBACK_BYTES = 64;

interface Pending { lane: DripLane; userId?: number; expires: number }

/** In-memory, single-use confirm tokens that expire after two minutes. */
export class ConfirmStore {
  private readonly m = new Map<string, Pending>();
  constructor(private readonly now: () => number = Date.now) {}

  private purge(): void {
    const t = this.now();
    for (const [k, v] of this.m) if (v.expires <= t) this.m.delete(k);
  }

  issue(lane: DripLane, userId?: number): string {
    this.purge();
    while (this.m.size >= MAX_TOKENS) {
      const oldest = this.m.keys().next().value;
      if (oldest === undefined) break;
      this.m.delete(oldest);
    }
    const token = randomBytes(4).toString('hex');
    this.m.set(token, { lane, userId, expires: this.now() + CONFIRM_TTL_MS });
    return token;
  }

  /** Returns the lane once; the token is gone afterwards, also when it is refused. */
  consume(token: string, userId?: number): DripLane | null {
    this.purge();
    const p = this.m.get(token);
    if (!p) return null;
    this.m.delete(token);
    if (p.userId !== undefined && userId !== undefined && p.userId !== userId) return null;
    return p.lane;
  }

  size(): number {
    this.purge();
    return this.m.size;
  }
}

const LANE_LABEL: Record<DripLane, string> = { mail: 'Mail', linkedin: 'LinkedIn' };

const ist = (d: Date): string => `${new Date(d.getTime() + 330 * 60_000).toISOString().slice(11, 16)} IST`;

function when(iso: string | null | undefined, now: Date): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return 'none yet';
  const min = Math.round((t - now.getTime()) / 60_000);
  const rel = min > 0 ? `in ${min} min` : `${-min} min ago`;
  return `${ist(new Date(t))} (${rel})`;
}

function nextTick(iso: string | null, now: Date): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t) || t <= now.getTime()) return 'due when the gates allow';
  return `not before ${when(iso, now)}`;
}

/** The status text, from SQLite and the env only. Every value is built in code; nothing third-party is shown. */
export function renderDripStatus(db: BetterSqlite3.Database, env: NodeJS.ProcessEnv, now: Date): string {
  const L: string[] = ['🚰 **Drip lanes**'];
  if (isDryRun(env)) L.push('⏸ **Dry run is ON:** _ticks record what they would do and send nothing._');
  const safe = <T>(f: () => T, dflt: T): T => { try { return f(); } catch { return dflt; } };

  // mail
  const mc = loadDripConfig(env);
  const mailOff = mc.problems.length > 0 ? `OFF (bad config: ${mc.problems[0]?.slice(0, 80)})` : emailBrakeOn(env) ? 'OFF (SEND_LIMIT_PER_RUN=0 brake)' : 'on';
  const mailLast = safe(() => lastSendAt(db), null);
  const mailToday = safe(() => sentToday(db), 0);
  L.push('', `${mailOff === 'on' ? '✅' : '⏸'} **Mail**: ${mailOff}`);
  L.push(`- **next tick:** ${nextTick(safe(() => getState(db, STATE_NEXT_AT), null), now)}`);
  L.push(`- **last send:** ${mailLast ? when(mailLast.toISOString(), now) : 'none yet'}`);
  L.push(`- **today:** **${mailToday}** sent, cap ${mc.maxPerDay > 0 ? mc.maxPerDay : 'none'}`);
  if (emailAutoReplyOn(env)) L.push(`- **auto replies today:** **${safe(() => emailRepliesSentToday(db), 0)}** sent (counted in the sends above)`);
  L.push(`- **send window:**${String(Math.floor(mc.windowStartMin / 60)).padStart(2, '0')}:${String(mc.windowStartMin % 60).padStart(2, '0')} to ${String(Math.floor(mc.windowEndMin / 60)).padStart(2, '0')}:${String(mc.windowEndMin % 60).padStart(2, '0')} IST`);
  L.push(...refusalLines(db, 'mail', now));

  // linkedin
  const lc = loadLinkedinDripConfig(env);
  const liOff = !lc.enabled ? 'OFF (LINKEDIN_DRIP=false)' : lc.problems.length > 0 ? `OFF (bad config: ${lc.problems[0]?.slice(0, 80)})` : 'on';
  const last = safe(() => {
    const raw = getState(db, LI_STATE_LAST_ACTION);
    return raw ? (JSON.parse(raw) as { at?: string; kind?: string }) : null;
  }, null);
  const c = safe(() => ceilings(db, loadOutreachConfig(env), now), null);
  L.push('', `${liOff === 'on' ? '✅' : '⏸'} **LinkedIn**: ${liOff}`);
  L.push(`- **next tick:** ${nextTick(safe(() => getState(db, LI_STATE_NEXT_AT), null), now)}`);
  L.push(`- **last action:** ${last?.at ? `${String(last.kind ?? 'action').replace(/[^a-z_]/gi, '').slice(0, 20)} ${when(last.at, now)}` : 'none yet'}`);
  L.push(c ? `- **today (rolling 24 h):** invites **${c.linkedin_invite.used}/${c.linkedin_invite.limit}**, messages **${c.linkedin_message.used}/${c.linkedin_message.limit}**` : '- **today:** unknown');
  L.push(...refusalLines(db, 'linkedin', now));
  return L.join('\n');
}

function refusalLines(db: BetterSqlite3.Database, lane: DripLane, now: Date): string[] {
  const out: string[] = [];
  const req = readFreshRequest(db, lane, now);
  if (req) out.push(`- a "run now" request is waiting for the daemon (id ${req.id})`);
  const r = readRefusal(db, lane);
  out.push(r ? `- **last refusal:** ${r.reason} at ${when(r.at, now)}` : '- **last refusal:** none');
  return out;
}

export const STATUS_BUTTONS: Button[][] = [
  [{ text: 'Mail now', data: 'dr:m' }, { text: 'LinkedIn now', data: 'dr:l' }],
  [{ text: 'Status', data: 'dr:s' }],
];

export class DripController {
  readonly store: ConfirmStore;
  constructor(store: ConfirmStore = new ConfirmStore()) {
    this.store = store;
  }

  async status(io: DripIo): Promise<void> {
    const db = io.openDb();
    let text: string;
    try {
      text = renderDripStatus(db, io.env, io.now());
    } finally {
      db.close();
    }
    await io.sendButtons(text, STATUS_BUTTONS);
  }

  /** Step 1 of a "now" request: only a confirm message, nothing is written yet. */
  async ask(lane: DripLane, io: DripIo, userId?: number): Promise<void> {
    const k = io.killed();
    if (k.stopped) return io.reply(`Kill switch is on (${k.reason}). I will not request a drip tick.`);
    const token = this.store.issue(lane, userId);
    const kind = lane === 'mail' ? 'a real email' : 'a real LinkedIn action';
    const dry = isDryRun(io.env) ? '\nDry run is ON, so the tick would only record what it would do.' : '';
    await io.sendButtons(
      `This can send ${kind}. The daemon still applies every gate (kill switch, halts, quiet hours, send window, caps, minimum gap). Confirm? (valid 2 minutes)${dry}`,
      [[{ text: 'Confirm', data: `dr:y:${token}` }, { text: 'Cancel', data: `dr:n:${token}` }]],
    );
  }

  /** Step 2: a valid, unused, unexpired token writes the request. */
  async confirm(token: string, io: DripIo, userId?: number): Promise<void> {
    const lane = this.store.consume(token, userId);
    if (!lane) return io.reply('That confirmation expired or was already used. Send /drip again.');
    const k = io.killed();
    if (k.stopped) return io.reply(`Kill switch is on (${k.reason}). No request was made.`);
    const db = io.openDb();
    try {
      writeDripRequest(db, lane, io.now());
    } finally {
      db.close();
    }
    await io.reply(`${LANE_LABEL[lane]} drip tick requested. The daemon picks it up within 30 s; the result goes to the mail or linkedin topic. If a gate refuses it, /drip shows the reason.`);
  }

  async cancel(token: string, io: DripIo, userId?: number): Promise<void> {
    this.store.consume(token, userId);
    await io.reply('Cancelled. Nothing was requested.');
  }

  /** Typed `/drip`, `/drip status`, `/drip mail now`, `/drip linkedin now`. */
  async command(rest: string, io: DripIo, userId?: number): Promise<void> {
    const t = rest.toLowerCase().split(/\s+/).filter(Boolean);
    if (t.length === 0 || (t.length === 1 && t[0] === 'status')) return this.status(io);
    if (t.length === 2 && t[1] === 'now' && (t[0] === 'mail' || t[0] === 'linkedin')) return this.ask(t[0], io, userId);
    return io.reply('usage: /drip | /drip mail now | /drip linkedin now');
  }

  /** A button press. The caller has already answered the callback query and checked the owner id. */
  async callback(data: string, io: DripIo, userId?: number): Promise<void> {
    if (!data.startsWith(CALLBACK_PREFIX) || Buffer.byteLength(data) > MAX_CALLBACK_BYTES) return;
    const [, op, token] = data.split(':');
    if (op === 's') return this.status(io);
    if (op === 'm') return this.ask('mail', io, userId);
    if (op === 'l') return this.ask('linkedin', io, userId);
    if (op === 'y' && token) return this.confirm(token, io, userId);
    if (op === 'n' && token) return this.cancel(token, io, userId);
  }
}
