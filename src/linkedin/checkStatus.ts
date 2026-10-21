// Typed, read-only connection status check. Never clicks, never touches people or touches.
import { haltReason } from '../outreach/limits.js';
import { layoutClassOf } from './layoutGuard.js';
import { gateField, MAX_FIELD_CHARS } from './state.js';
import { isProfileUrl } from './urls.js';
import { verifyProfileUrl } from './verify.js';
import type { ToolDeps } from './toolDeps.js';
import { connectionState } from './connectionState.js';

export interface StatusResult {
  status: 'connected' | 'not_connected' | 'pending' | 'failed' | 'halted';
  code: string;
  name?: string;
  degree?: '1st' | '2nd' | '3rd' | null;
  profileContext?: { about?: string };
  injection_suspected?: boolean;
  /** Layout verdict class for the profile page: match, partial, drift, unknown, blocked, logged_out or unloaded. */
  layout?: string;
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
  // 1st degree and no Connect button decide it (connectionState): the bell also shows for a profile that is only followed,
  // and a Message button alone is Premium or InMail.
  const cs = connectionState(p);
  const out: StatusResult = {
    status: cs.state,
    code: cs.code,
    degree: p.degree,
    // Read-only: reports the layout verdict class, never refuses on it.
    ...layoutClassOf(deps.rt, 'check_connection_status'),
  };
  const name = gateField(p.name ?? '', MAX_FIELD_CHARS.name);
  const about = p.about ? gateField(p.about, MAX_FIELD_CHARS.about) : null;
  // Classifier screen over everything surfaced; an unknown status must not decide a send.
  const verdict = await deps.screen(`${p.name ?? ''}\n${p.about ?? ''}`, 'read');
  if (verdict.blocked) {
    if (verdict.code === 'classifier_unavailable') return { status: 'failed', code: 'classifier_unavailable' };
    out.injection_suspected = true;
    return out;
  }
  if (name.text && !name.blocked) out.name = name.text;
  if (about) {
    if (about.blocked) out.injection_suspected = true;
    else if (about.text) out.profileContext = { about: about.text };
  }
  return out;
}
