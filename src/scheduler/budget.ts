// Per-run budget tracker over `claude -p --output-format stream-json` output.
// Pure: no fs, no Date.now(), no randomness. The clock is injected.

export interface Budget {
  maxWallSec: number;
  maxTokensApprox: number;
}

// Tool calls are counted for reporting only; the real limits are the send, connect, message and
// apply counters in src/outreach/limits.ts, so the count is never a stop condition.
export const BUDGET_DEFAULTS: Budget = { maxWallSec: 3600, maxTokensApprox: 1000000 };

function intInRange(raw: string | undefined, min: number, max: number, dflt: number): number {
  if (raw === undefined) return dflt;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return dflt;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : dflt;
}

export function loadBudget(env: NodeJS.ProcessEnv = process.env): Budget {
  return {
    maxWallSec: intInRange(env.RUN_MAX_WALL_SEC, 30, 7200, BUDGET_DEFAULTS.maxWallSec),
    maxTokensApprox: intInRange(env.RUN_MAX_TOKENS_APPROX, 1000, 2000000, BUDGET_DEFAULTS.maxTokensApprox),
  };
}

export const STALL_DEFAULT_SEC = 600;

// Seconds of log silence after which a run is killed as stalled (RUN_STALL_SEC, 60..3600, default 600).
export function loadStallSec(env: NodeJS.ProcessEnv = process.env): number {
  return intInRange(env.RUN_STALL_SEC, 60, 3600, STALL_DEFAULT_SEC);
}

// One warning line per budget env key that is set but invalid (outside its range), for the daemon start and the doctor.
export function budgetEnvWarnings(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const check = (key: string, min: number, max: number, dflt: number): void => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return;
    if (intInRange(raw, min, max, -1) === -1) out.push(`${key}=${raw.trim()} is outside ${min}..${max}, using ${dflt}`);
  };
  check('RUN_MAX_WALL_SEC', 30, 7200, BUDGET_DEFAULTS.maxWallSec);
  check('RUN_MAX_TOKENS_APPROX', 1000, 2000000, BUDGET_DEFAULTS.maxTokensApprox);
  check('RUN_STALL_SEC', 60, 3600, STALL_DEFAULT_SEC);
  return out;
}

export type StopReason = 'wall_clock' | 'tokens' | 'usage_limit' | 'stalled';

const MAX_BUFFER = 1_000_000;
export const LIMIT_RE = /(usage|rate) limit (reached|exceeded)|(plan|session) limit reached|hit your limit/i;
const NETWORK_RE = /can't reach|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|internet|DNS/i;

export class BudgetTracker {
  private toolCalls = 0;
  private networkRetries = 0;
  private chars = 0;
  private usageLimit = false;
  private buffer = '';
  private tailChecked: string | null = null; // unterminated tail already evaluated by check()
  private overflow = false; // current partial line exceeded the cap and was dropped
  private lines: string[] = [];
  private lastNow: Date;
  private lastByteAt: Date;
  private lastEvent = 'none';

  // stallSec 0 (default) means no stall check. A stall is a network event, never a usage limit.
  constructor(
    private readonly budget: Budget,
    private readonly startedAt: Date,
    private readonly stallSec = 0,
  ) {
    this.lastNow = startedAt;
    this.lastByteAt = startedAt;
  }

  feed(chunk: string, now: Date): void {
    this.lastNow = now;
    if (chunk.length > 0) this.lastByteAt = now;
    this.chars += chunk.length;
    const parts = chunk.split('\n');
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const terminated = i < parts.length - 1;
      if (!this.overflow) {
        if (this.buffer.length + part.length > MAX_BUFFER) {
          this.buffer = '';
          this.overflow = true;
        } else {
          this.buffer += part;
        }
      }
      if (terminated) {
        if (!this.overflow && this.buffer !== this.tailChecked) this.processLine(this.buffer);
        this.tailChecked = null;
        this.buffer = '';
        this.overflow = false;
      }
    }
  }

  private processLine(line: string): void {
    if (line.length === 0) return;
    this.lines.push(line.slice(0, 300));
    if (this.lines.length > 5) this.lines.shift();
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      // Raw CLI or stderr text, not stream-json: the only place a plain limit message is trusted.
      if (LIMIT_RE.test(line)) this.usageLimit = true;
      return;
    }
    if (!obj || typeof obj !== 'object') {
      if (LIMIT_RE.test(line)) this.usageLimit = true;
      return;
    }
    const ev = obj as { type?: unknown; subtype?: unknown; attempt?: unknown; max_retries?: unknown };
    if (typeof ev.type === 'string') {
      this.lastEvent = ev.subtype === 'api_retry' && ev.attempt !== undefined
        ? `api_retry attempt ${String(ev.attempt)} of ${String(ev.max_retries ?? '?')}`
        : typeof ev.subtype === 'string' ? `${ev.type} ${ev.subtype}` : ev.type;
    }
    const o = obj as {
      type?: unknown; subtype?: unknown; is_error?: unknown; result?: unknown; error?: unknown; message?: { content?: unknown };
    };
    // Never scan assistant or user (tool_result) messages: tool output may say limit reached.
    if (o.type === 'result' || o.type === 'system') {
      // A successful result is the model's own summary (it may say "invite limit reached"): scan it only for an error result.
      const fields = o.type === 'result' && o.is_error !== true ? [o.error] : [o.result, o.error];
      for (const f of fields) if (typeof f === 'string' && LIMIT_RE.test(f)) this.usageLimit = true;
    }
    if (o.type === 'system' && o.subtype === 'api_retry' && (o as { error_status?: unknown }).error_status !== 429) this.networkRetries++;
    // An interrupted run or a network outage also ends in an is_error result; only a bare is_error or a limit text is a limit.
    if (o.type === 'result' && o.is_error === true && o.subtype !== 'error_during_execution' && o.subtype !== 'error_max_turns') {
      const text = typeof o.result === 'string' ? o.result : '';
      if (this.networkRetries === 0 && !NETWORK_RE.test(text)) this.usageLimit = true;
    }
    if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
      for (const block of o.message.content) {
        if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'tool_use') this.toolCalls++;
      }
    }
  }

  private wallSecAt(now: Date): number {
    return Math.max(0, Math.floor((now.getTime() - this.startedAt.getTime()) / 1000));
  }

  check(now: Date): StopReason | null {
    if (this.buffer.length > 0 && !this.overflow && this.buffer !== this.tailChecked) {
      this.tailChecked = this.buffer;
      this.processLine(this.buffer);
    }
    if (this.usageLimit) return 'usage_limit';
    if (this.wallSecAt(now) > this.budget.maxWallSec) return 'wall_clock';
    if (Math.ceil(this.chars / 4) > this.budget.maxTokensApprox) return 'tokens';
    if (this.stallSec > 0 && this.silentSecAt(now) >= this.stallSec) return 'stalled';
    return null;
  }

  private silentSecAt(now: Date): number {
    return Math.max(0, Math.floor((now.getTime() - this.lastByteAt.getTime()) / 1000));
  }

  // Summary for a stalled run, with the type of the last event read from the log.
  stallSummary(now: Date): string {
    return `no output for ${this.silentSecAt(now)} s (last event: ${this.lastEvent})`;
  }

  snapshot(): { toolCalls: number; tokensApprox: number; wallSec: number; lastLines: string[] } {
    return {
      toolCalls: this.toolCalls,
      tokensApprox: Math.ceil(this.chars / 4),
      wallSec: this.wallSecAt(this.lastNow),
      lastLines: [...this.lines],
    };
  }
}
