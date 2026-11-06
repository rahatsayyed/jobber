import { sendToTopic } from '../telegram/send.js';
import type { TopicName } from '../telegram/topics.js';

export interface SendNotifyOpts {
  /** Telegram forum topic. Text-only calls go to `alerts`. */
  topic?: TopicName;
  /** The text is HTML built by src/platform/tgHtml.ts (already escaped): sent as is, not converted from markdown. */
  html?: boolean;
  /** true: arrives without sound (disable_notification). false: always notifies. Unset: the topic default (drips and wakes silent, others loud; TELEGRAM_SILENT_TOPICS). */
  silent?: boolean;
}

export interface Notifier {
  send(text: string, opts?: SendNotifyOpts): Promise<{ ok: boolean; detail: string }>;
}

/**
 * Code-sent Telegram notifications: text is markdown, converted to HTML in code (everything escaped first) and
 * posted to the topic's message_thread_id. Needs only the token; no bridge daemon and no model.
 */
export function telegramNotifier(env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch, root?: string): Notifier {
  return {
    async send(text, opts) {
      return sendToTopic(opts?.topic ?? 'alerts', text, { env, fetchFn, root, ...(opts?.html ? { html: true } : {}), ...(opts?.silent !== undefined ? { silent: opts.silent } : {}) });
    },
  };
}

export const consoleNotifier: Notifier = {
  async send(text) {
    console.log(text);
    return { ok: true, detail: 'printed' };
  },
};
