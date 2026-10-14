// src/web/env.ts
import { assertName } from '../platform/tmux.js';

export interface WebConfig {
  token: string;
  port: number;
  session: string;
  window: string;
}

export type WebEnvResult = { ok: true; config: WebConfig } | { ok: false; error: string };

export function parseWebEnv(env: Record<string, string | undefined>): WebEnvResult {
  const token = env.WEB_TOKEN ?? '';
  if (token.length < 24) return { ok: false, error: 'WEB_TOKEN is missing or shorter than 24 characters (openssl rand -hex 24)' };
  const rawPort = (env.WEB_PORT ?? '').trim();
  let port = 8787;
  if (rawPort !== '') {
    if (!/^\d+$/.test(rawPort)) return { ok: false, error: 'WEB_PORT must be an integer from 1024 to 65535' };
    port = Number(rawPort);
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    return { ok: false, error: 'WEB_PORT must be an integer from 1024 to 65535' };
  }
  const session = (env.WEB_TMUX_SESSION ?? '').trim() || 'ccgram';
  const window = (env.WEB_TMUX_WINDOW ?? '').trim() || 'JobApplier';
  try {
    assertName(session);
  } catch {
    return { ok: false, error: 'WEB_TMUX_SESSION is not a valid tmux name' };
  }
  try {
    assertName(window);
  } catch {
    return { ok: false, error: 'WEB_TMUX_WINDOW is not a valid tmux name' };
  }
  return { ok: true, config: { token, port, session, window } };
}
