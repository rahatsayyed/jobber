// src/platform/redact.ts
// Redaction for tmux pane text before it is shown to the manager session.
// NOTE: this duplicates the intent of redactSecrets in src/web/server.ts on purpose (that
// module is owned by another plan); the pane variant is line oriented and always strict.

const LINE_MARKERS = /(TOKEN\s*=|PASSWORD\s*=|SECRET\s*=|API_KEY\s*=|WEB_OIDC_CLIENT_SECRET|^\s*(cookie|set-cookie|authorization)\s*:)/i;

const PATTERNS: RegExp[] = [
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot token shape
  /\bsk-(?:or-)?[A-Za-z0-9_-]{8,}/g, // API keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi,
  /[A-Fa-f0-9]{32,}/g, // long hex runs
  /[A-Za-z0-9+/_-]{32,}={0,2}/g, // long base64 / url-safe runs
];

/** Mask secret-shaped text. Whole lines carrying credential markers are replaced. */
export function redactPane(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (LINE_MARKERS.test(line)) return '[redacted line]';
      let out = line;
      for (const re of PATTERNS) out = out.replace(re, '[redacted]');
      return out;
    })
    .join('\n');
}
