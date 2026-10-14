import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

// Hybrid-mode Claude fallback for browser-automation steps whose hardcoded Playwright
// selectors miss (LinkedIn's DOM is not stable the way Greenhouse/Lever/Workday/Ashby's is).
// This is the escalation path ONLY — the fast, free, selector-based path in linkedin.ts
// always runs first and is the common case.
//
// There is no Anthropic API key/billing set up for this project — the user has a Claude
// subscription, not API credits. So this shells out to the `claude` CLI in non-interactive
// print mode (`claude -p "/command-name <json>"`), invoking a project-level custom slash
// command (`.claude/commands/easy-apply-*-fallback.md`) rather than an ad hoc inline prompt.
// This means the exact task, output contract, and "never invent" rules live in one reviewable
// file instead of being re-derived in a prompt string on every call, and it authenticates via
// the same Claude Code subscription session rather than a separate metered API key. Each call
// is a single, isolated, non-agentic invocation (no follow-up turns).
//
// These calls are never allowed to invent data: every function here only ever picks one
// option from a caller-supplied allowlist (a real on-page button/link text, or an existing
// truthful answer's key) and is rejected if Claude's choice isn't verbatim in that list.

export interface FallbackDeps {
  /** Injectable Claude invocation, for testing without spawning the real CLI. */
  runClaude?: (command: string, input: unknown) => Promise<string | null>;
  /** Optional --model override (e.g. "sonnet", "haiku") for faster/cheaper escalation calls. */
  model?: string;
}

export async function runClaudeCli(command: string, input: unknown, model?: string): Promise<string | null> {
  const args = ['-p', `/${command} ${JSON.stringify(input)}`, '--output-format', 'json'];
  if (model) args.push('--model', model);
  try {
    const { stdout } = await execFileAsync(process.env.CLAUDE_CLI_PATH ?? 'claude', args, {
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      // Slash commands run through the full CLI (not --bare, which disables custom
      // commands entirely) and otherwise wait ~3s for stdin that will never arrive.
      // `input` isn't in Node's ExecFileOptions typings but is honored at runtime
      // (verified empirically — see the domFallback design notes).
      ...({ input: '' } as object),
    });
    const parsed = JSON.parse(stdout);
    return typeof parsed?.result === 'string' ? parsed.result : null;
  } catch {
    return null;
  }
}

/**
 * Claude's CLI response text is meant to be a bare JSON object per our prompt, but models
 * sometimes wrap it in a markdown fence or add stray text — try the raw text, a fenced
 * block, and the first `{...}` span, in that order, validating against `schema` each time.
 */
export function extractJson<T>(raw: string, schema: z.ZodType<T>): T | null {
  const candidates = [raw.trim()];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.unshift(fenced[1].trim());
  const bare = raw.match(/\{[\s\S]*\}/);
  if (bare) candidates.push(bare[0]);

  for (const candidate of candidates) {
    try {
      const result = schema.safeParse(JSON.parse(candidate));
      if (result.success) return result.data;
    } catch {
      // Try the next candidate extraction strategy.
    }
  }
  return null;
}

const ControlChoiceSchema = z.object({ matchedText: z.string().nullable() });

/**
 * Given a list of real on-page button/link texts and a description of what the caller
 * needs clicked next, asks Claude to pick the one candidate that satisfies the intent.
 * Returns null if Claude finds no match, the call fails, or Claude's answer isn't
 * verbatim one of the supplied candidates (never trust free text back from the model).
 */
export async function resolveControlWithFallback(
  candidates: string[],
  intent: string,
  deps: FallbackDeps = {}
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const invoke = deps.runClaude ?? ((command: string, input: unknown) => runClaudeCli(command, input, deps.model));

  const raw = await invoke('easy-apply-control-fallback', { intent, candidates });
  if (!raw) return null;
  const parsed = extractJson(raw, ControlChoiceSchema);
  if (!parsed?.matchedText) return null;
  return candidates.includes(parsed.matchedText) ? parsed.matchedText : null;
}

export type FallbackAnswerValue = string | number | boolean;

export interface KnownAnswerTopic {
  /** Opaque identifier Claude must echo back verbatim to select this topic. */
  key: string;
  /** Human-readable description of what information this topic already truthfully answers. */
  description: string;
  value: FallbackAnswerValue;
}

const AnswerChoiceSchema = z.object({ matchedKey: z.string().nullable() });

/**
 * Given an unrecognized screening question and the set of topics the candidate already has
 * a truthful, verified answer for (from user-data/easy-apply-answers.json), asks Claude whether
 * the question is a rephrasing of one of those topics. Returns that topic's already-truthful
 * value if so, or null if the question asks for genuinely new information — this function
 * NEVER fabricates a new value, it only ever points at an existing one.
 */
export async function resolveAnswerTopicWithFallback(
  question: string,
  topics: KnownAnswerTopic[],
  deps: FallbackDeps = {}
): Promise<FallbackAnswerValue | null> {
  if (topics.length === 0) return null;
  const invoke = deps.runClaude ?? ((command: string, input: unknown) => runClaudeCli(command, input, deps.model));

  const raw = await invoke('easy-apply-answer-fallback', {
    question,
    topics: topics.map(({ key, description }) => ({ key, description })),
  });
  if (!raw) return null;
  const parsed = extractJson(raw, AnswerChoiceSchema);
  if (!parsed?.matchedKey) return null;
  const topic = topics.find((t) => t.key === parsed.matchedKey);
  return topic?.value ?? null;
}
