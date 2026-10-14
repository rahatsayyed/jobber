// src/dash/cookies.ts
// Cookie parsing and serialization for the dashboard.

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k || k in out) continue;
    const raw = part.slice(i + 1).trim();
    try { out[k] = decodeURIComponent(raw); } catch { out[k] = raw; }
  }
  return out;
}

export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-jobber_session' : 'jobber_session';
}

export function oidcCookieName(secure: boolean): string {
  return secure ? '__Host-jobber_oidc' : 'jobber_oidc';
}

function attrs(maxAgeSec: number, secure: boolean): string {
  return `HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(maxAgeSec))}${secure ? '; Secure' : ''}`;
}

export function serializeSession(value: string, secure: boolean, maxAgeSec: number): string {
  return `${sessionCookieName(secure)}=${value}; ${attrs(maxAgeSec, secure)}`;
}

export function serializeOidc(value: string, secure: boolean): string {
  return `${oidcCookieName(secure)}=${value}; ${attrs(600, secure)}`;
}

export function clearCookie(name: string, secure: boolean): string {
  return `${name}=; ${attrs(0, secure)}`;
}
