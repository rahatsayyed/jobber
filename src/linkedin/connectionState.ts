// One rule for "is this profile a 1st-degree connection", shared by the status check and both send tools.
// Live evidence (2026-10-21): the "Manage notifications about <Name>" bell also shows on a profile you only FOLLOW, so a 3rd-degree
// profile with Connect and Follow buttons carried a bell. The bell alone therefore never means connected.

export interface ConnectionSignals {
  hasBell: boolean;
  pending: boolean;
  degree: string | null;
  actions: string[];
}

export type ConnectionState = 'connected' | 'pending' | 'not_connected';

const hasConnectButton = (actions: string[]): boolean => actions.some((a) => /^connect$/i.test(String(a).trim()));

export function connectionState(p: ConnectionSignals): { state: ConnectionState; code: string } {
  // A visible Connect button means there is no connection, whatever else the page shows.
  if (hasConnectButton(p.actions)) return { state: 'not_connected', code: 'connect_available' };
  if (p.degree === '1st') return { state: 'connected', code: p.hasBell ? 'bell_present' : 'first_degree' };
  // Degree not readable: the bell is the only remaining signal (no Connect button was seen above).
  if (p.degree === null && p.hasBell) return { state: 'connected', code: 'bell_present' };
  if (p.pending) return { state: 'pending', code: 'pending_control' };
  return { state: 'not_connected', code: p.hasBell ? 'not_first_degree' : 'no_bell' };
}
