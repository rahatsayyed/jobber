// Per-run budget tracker over `claude -p --output-format stream-json` output.
// Pure: no fs, no Date.now(), no randomness. The clock is injected.

export interface Budget {
  maxToolCalls: number;
  maxWallSec: number;
  maxTokensApprox: number;
}

export const BUDGET_DEFAULTS: Budget = { maxToolCalls: 60, maxWallSec: 900, maxTokensApprox: 150000 };

function intInRange(raw: string | undefined, min: number, max: number, dflt: number): number {
  if (raw === undefined) return dflt;
  const s = raw.trim();
  if (!/^\d+$/.test(s)) return dflt;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : dflt;
}

export function loadBudget(env: NodeJS.ProcessEnv = process.env): Budget {
  return {
    maxToolCalls: intInRange(env.RUN_MAX_TOOL_CALLS, 1, 1000, BUDGET_DEFAULTS.maxToolCalls),
    maxWallSec: intInRange(env.RUN_MAX_WALL_SEC, 30, 7200, BUDGET_DEFAULTS.maxWallSec),
    maxTokensApprox: intInRange(env.RUN_MAX_TOKENS_APPROX, 1000, 2000000, BUDGET_DEFAULTS.maxTokensApprox),
  };
}

export type StopReason = 'tool_calls' | 'wall_clock' | 'tokens' | 'usage_limit';

const MAX_BUFFER = 1_000_000;
const LIMIT_RE = /(usage|rate) limit (reached|exceeded)|limit reached/i;

export class BudgetTracker {
  private toolCalls = 0;
  private chars = 0;
  private usageLimit = false;
  private buffer = '';
  private overflow = false; // current partial line exceeded the cap and was dropped
  private lines: string[] = [];
  private lastNow: Date;

  constructor(
    private readonly budget: Budget,
    private readonly startedAt: Date,
  ) {
    this.lastNow = startedAt;
  }

  feed(chunk: string, now: Date): void {
    this.lastNow = now;
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
        if (!this.overflow) this.processLine(this.buffer);
        this.buffer = '';
        this.overflow = false;
      }
    }
  }

  private processLine(line: string): void {
    if (line.length === 0) return;
    this.lines.push(line.slice(0, 300));
    if (this.lines.length > 5) this.lines.shift();
    if (LIMIT_RE.test(line)) this.usageLimit = true;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    const o = obj as { type?: unknown; is_error?: unknown; message?: { content?: unknown } };
    if (o.type === 'result' && o.is_error === true) this.usageLimit = true;
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
    if (this.usageLimit) return 'usage_limit';
    if (this.toolCalls > this.budget.maxToolCalls) return 'tool_calls';
    if (this.wallSecAt(now) > this.budget.maxWallSec) return 'wall_clock';
    if (Math.ceil(this.chars / 4) > this.budget.maxTokensApprox) return 'tokens';
    return null;
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
