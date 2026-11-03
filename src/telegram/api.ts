// src/telegram/api.ts
// A tiny Bot API caller over fetch for the code-sent paths (no bridge daemon, no model, no grammY needed).
// It never throws and never puts the token in a result.
export interface ApiResult<T = unknown> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export interface TelegramApi {
  call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<ApiResult<T>>;
}

const TIMEOUT_MS = 15_000;

export function scrub(s: string, token: string): string {
  return token ? s.split(token).join('[token]') : s;
}

export function fetchApi(token: string, fetchFn: typeof fetch = fetch): TelegramApi {
  return {
    async call<T>(method: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
      try {
        const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        let body: Partial<ApiResult<T>> = {};
        try {
          body = (await res.json()) as Partial<ApiResult<T>>;
        } catch {
          // not JSON: only the status is known
        }
        if (res.ok && body.ok !== false) return { ok: true, result: body.result };
        return { ok: false, error_code: body.error_code ?? res.status, description: scrub(String(body.description ?? `http ${res.status}`), token) };
      } catch (e) {
        const name = e instanceof Error ? e.name : 'error';
        return { ok: false, description: `telegram request failed (${name})` };
      }
    },
  };
}
