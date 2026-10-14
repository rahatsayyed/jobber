import type { Outcome } from './state.js';

const MAX_TOTAL = 3500;

export function sanitizeLine(s: string, max = 100): string {
  const cleaned = s
    .replace(/[\t\n\r\v\f]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max - 3) + '...' : cleaned;
}

const GROUPS = ['feat', 'fix', 'docs', 'other'] as const;

export function summarizeRange(commits: { sha: string; subject: string }[], maxLines = 10): string[] {
  const grouped: Record<string, string[]> = { feat: [], fix: [], docs: [], other: [] };
  for (const c of commits) {
    const subject = sanitizeLine(c.subject);
    const m = /^(feat|fix|docs)(\([^)]*\))?!?:/i.exec(subject);
    grouped[m ? m[1]!.toLowerCase() : 'other']!.push(subject);
  }
  const lines: string[] = [];
  let shown = 0;
  for (const g of GROUPS) {
    const items = grouped[g]!;
    if (items.length === 0) continue;
    for (const [i, subject] of items.entries()) {
      if (shown >= maxLines) break;
      lines.push(i === 0 ? `${g} (${items.length}): ${subject}` : `  ${subject}`);
      shown++;
    }
  }
  const total = commits.length;
  if (total > shown) lines.push(`+${total - shown} more`);
  return lines;
}

const HINTS: Record<string, string> = {
  dirty: 'commit or stash local changes',
  unsigned: 'review the commits and merge by hand or update AUTO_UPDATE_SIGNERS_FILE',
  'reserved-paths': 'review these paths, then run git merge --ff-only yourself',
  diverged: 'local commits exist; rebase or reset by hand',
  disabled: 'set AUTO_UPDATE=true to enable updates',
  unconfigured: 'fix the AUTO_UPDATE settings in .env',
  'no-upstream': 'check the AUTO_UPDATE remote and branch settings',
  'detached-head': 'check out the update branch',
  'wrong-branch': 'switch to the configured update branch',
  'lock-held': 'another run is active; it will retry on the next tick',
};

const TITLES: Record<Outcome, string> = {
  updated: 'Jobber updated',
  skipped: 'Jobber update skipped',
  noop: 'Jobber is up to date',
  dry_run: 'Jobber update dry run',
  rolled_back: 'Jobber update rolled back',
  rollback_failed: 'Jobber update rollback FAILED',
  error: 'Jobber update error',
};

export function formatNotification(r: {
  outcome: Outcome; from: string; to: string | null; reason: string | null; step: string | null;
  commits: { sha: string; subject: string }[]; flags: string[]; dryRun: boolean; restartNeeded: boolean;
}): string {
  const lines: string[] = [];
  lines.push(r.dryRun && r.outcome !== 'dry_run' ? `${TITLES[r.outcome]} (dry run)` : TITLES[r.outcome]);
  const from = r.from.slice(0, 12);
  lines.push(r.to ? `${from}..${r.to.slice(0, 12)}` : `at ${from}`);
  if (r.outcome === 'skipped') {
    const reason = r.reason ?? 'unknown';
    lines.push(`reason: ${sanitizeLine(reason, 200)}`);
    const hint = HINTS[reason.split(':')[0]!.trim()];
    if (hint) lines.push(`fix: ${hint}`);
  } else if (r.reason) {
    lines.push(`reason: ${sanitizeLine(r.reason, 200)}`);
    if (r.outcome === 'error') lines.push('fix: see the update log, then retry or update by hand');
  }
  if (r.step) lines.push(`step: ${sanitizeLine(r.step, 60)}`);
  if (r.commits.length > 0) {
    lines.push('', ...summarizeRange(r.commits));
  }
  if (r.flags.length > 0) {
    lines.push('', ...r.flags.slice(0, 10).map((f) => `flag: ${sanitizeLine(f, 160)}`));
  }
  if (r.restartNeeded && r.outcome === 'updated') {
    lines.push('', 'restart Claude sessions to load the new code');
  }
  const text = lines.join('\n');
  return text.length > MAX_TOTAL ? text.slice(0, MAX_TOTAL - 3) + '...' : text;
}
