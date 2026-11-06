// src/telegram/silent.ts
// Which Telegram notices arrive silent (Bot API `disable_notification: true`: no sound, no vibration; the message
// still shows up and the unread badge still counts). Routine topics are silent by default, topics that ask for the
// owner are loud. TELEGRAM_SILENT_TOPICS (comma list of topic names) changes the set without code.
import { TOPIC_NAMES, type TopicName } from './topics.js';

/** Silent unless the owner sets TELEGRAM_SILENT_TOPICS. alerts, assist, inbox and chat stay loud. */
export const DEFAULT_SILENT_TOPICS: readonly TopicName[] = ['drips', 'wakes'];

export interface SilentTopics {
  topics: Set<TopicName>;
  /** Doctor-style notes: unknown names that were ignored. */
  warnings: string[];
}

/**
 * Reads TELEGRAM_SILENT_TOPICS. Blank or unset: the default (`drips,wakes`). The word `none` alone: nothing is
 * silent. An unknown name is ignored and reported in `warnings`; a list with no valid name falls back to the default.
 */
export function silentTopicsFromEnv(env: NodeJS.ProcessEnv): SilentTopics {
  const raw = (env.TELEGRAM_SILENT_TOPICS ?? '').trim();
  if (!raw) return { topics: new Set(DEFAULT_SILENT_TOPICS), warnings: [] };
  const parts = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 1 && parts[0] === 'none') return { topics: new Set(), warnings: [] };
  const topics = new Set<TopicName>();
  const warnings: string[] = [];
  for (const p of parts) {
    if ((TOPIC_NAMES as readonly string[]).includes(p)) topics.add(p as TopicName);
    else warnings.push(`TELEGRAM_SILENT_TOPICS: unknown topic "${p.slice(0, 40)}" ignored (known: ${TOPIC_NAMES.join(', ')})`);
  }
  if (topics.size === 0) {
    warnings.push('TELEGRAM_SILENT_TOPICS: no valid topic name, the default (drips,wakes) is used');
    return { topics: new Set(DEFAULT_SILENT_TOPICS), warnings };
  }
  return { topics, warnings };
}

/**
 * The silent flag of one notice. An explicit `silent` (true or false) always wins; otherwise the topic decides;
 * no topic (plain chat) is loud. Replies to owner commands and button presses never go through this (the bridge
 * calls postChunks without `silent`, so they stay loud).
 */
export function resolveSilent(topic: TopicName | undefined, explicit: boolean | undefined, env: NodeJS.ProcessEnv): boolean {
  if (typeof explicit === 'boolean') return explicit;
  return topic !== undefined && silentTopicsFromEnv(env).topics.has(topic);
}

/**
 * For code that composes a notice and knows how urgent it is (for example the wake summary, built in
 * src/scheduler/driver.ts): returns the `silent` value to pass to `Notifier.send`.
 *   noticeUrgency({ needsOwner: true })  -> false (loud: the owner must act or look now)
 *   noticeUrgency({ failed: true })      -> false (loud: something failed or was halted)
 *   noticeUrgency({})                    -> undefined (no override: the topic default decides)
 * It returns `undefined` rather than `true` for routine notices so the owner's TELEGRAM_SILENT_TOPICS still applies.
 * Spread it as `...(s === undefined ? {} : { silent: s })` or pass `{ topic, silent: noticeUrgency(...) }` (undefined is fine).
 */
export function noticeUrgency(u: { needsOwner?: boolean; failed?: boolean; halted?: boolean }): boolean | undefined {
  return u.needsOwner || u.failed || u.halted ? false : undefined;
}
