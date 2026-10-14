// Typed, read-only connection status check. Never clicks, never touches people or touches.
import { haltReason } from '../outreach/limits.js';
import { gateField, MAX_FIELD_CHARS } from './state.js';
import { isProfileUrl } from './urls.js';
import { verifyProfileUrl } from './verify.js';
import type { ToolDeps } from './toolDeps.js';

export interface StatusResult {
  status: 'connected' | 'not_connected' | 'pending' | 'failed' | 'halted';
  code: string;
  name?: string;
  degree?: '1st' | '2nd' | '3rd' | null;
  profileContext?: { about?: string };
  injection_suspected?: boolean;
}

export async function checkConnectionStatus(a: { profile_url: string }, deps: ToolDeps): Promise<StatusResult> {
  if (haltReason(deps.db, 'linkedin')) return { status: 'halted', code: 'halted' };
  if (!isProfileUrl(a.profile_url)) return { status: 'failed', code: 'not_profile_url' };
  const r = await deps.rt.open(a.profile_url);
  if (!r.ok) return r.code === 'halted' ? { status: 'halted', code: 'halted' } : { status: 'failed', code: r.code };
  const snap = r.snapshot;
  if (!verifyProfileUrl(a.profile_url, snap.url).ok) return { status: 'failed', code: 'profile_url_mismatch' };
  const p = snap.profile;
  if (!p) return { status: 'failed', code: 'no_profile' };
  // The bell is the only 1st-degree signal: a Message button alone is Premium/InMail (2026-08-28).
  const out: StatusResult = {
    status: p.hasBell ? 'connected' : p.pending ? 'pending' : 'not_connected',
    code: p.hasBell ? 'bell_present' : p.pending ? 'pending_control' : 'no_bell',
    degree: p.degree,
  };
  const name = gateField(p.name ?? '', MAX_FIELD_CHARS.name);
  if (name.text && !name.blocked) out.name = name.text;
  if (p.about) {
    const g = gateField(p.about, MAX_FIELD_CHARS.about);
    if (g.blocked) out.injection_suspected = true;
    else if (g.text) out.profileContext = { about: g.text };
  }
  return out;
}
