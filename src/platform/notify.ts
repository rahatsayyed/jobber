export interface Notifier {
  send(text: string): Promise<{ ok: boolean; detail: string }>;
}

const TIMEOUT_MS = 10_000;

export function telegramNotifier(env: NodeJS.ProcessEnv, fetchFn: typeof fetch = fetch): Notifier {
  return {
    async send(text) {
      const token = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
      const chatId = (env.ALLOWED_USERS ?? '').split(',').map((s) => s.trim()).filter(Boolean)[0];
      if (!token || !chatId) return { ok: false, detail: 'telegram not configured' };
      try {
        const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return { ok: false, detail: `telegram http ${res.status}` };
        return { ok: true, detail: 'sent' };
      } catch (e) {
        const name = e instanceof Error ? e.name : 'error';
        return { ok: false, detail: `telegram request failed (${name})` };
      }
    },
  };
}

export const consoleNotifier: Notifier = {
  async send(text) {
    console.log(text);
    return { ok: true, detail: 'printed' };
  },
};
