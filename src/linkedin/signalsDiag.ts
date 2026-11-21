// file: src/linkedin/signalsDiag.ts
// One small evidence file when a LinkedIn job page's own block mentions "connection" but the signal parser found nothing, so the owner
// can fix the pattern from real data. Holds only tag, role and short redacted texts (safeName). Writing never throws.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { safeName } from '../browserctl/diag.js';
import { PROJECT_ROOT } from '../layout/config.js';
import type { LinkedinSignals } from '../linkedinSignals.js';

/** Writes `.jobber/diag/linkedin-signals-<stamp>.json`. Returns the path relative to the project, or null. */
export function writeSignalsDiag(deps: { now: () => Date; diagDir?: string }, s: LinkedinSignals): string | null {
  try {
    const dir = deps.diagDir ?? path.join(PROJECT_ROOT, '.jobber', 'diag');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stamp = deps.now().toISOString().replace(/[:.]/g, '-');
    const target = path.join(dir, `linkedin-signals-${stamp}.json`);
    const nodes = s.probe.slice(0, 5).map((p) => ({ tag: safeName(p.tag), role: safeName(p.role), text: safeName(p.text) }));
    writeFileSync(target, JSON.stringify({ kind: 'linkedin_signals_unparsed', at: deps.now().toISOString(), checked: s.checked, nodes }), { mode: 0o600 });
    const rel = path.relative(PROJECT_ROOT, target);
    return rel.startsWith('..') ? target : rel;
  } catch {
    return null;
  }
}
