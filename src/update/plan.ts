import type { UpdateConfig } from './config.js';

export type Signature = 'G' | 'U' | 'B' | 'X' | 'Y' | 'R' | 'E' | 'N';
export interface RangeCommit { sha: string; subject: string; signature: Signature }
export interface RepoFacts {
  head: string;
  currentBranch: string | null;
  dirty: boolean;
  upstreamSha: string | null;
  upstreamLabel: string;
  ahead: number;
  behind: number;
  commits: RangeCommit[];
  changedPaths: string[];
  tagSignature: Signature | null;
}
export type SkipReason =
  | 'disabled' | 'unconfigured' | 'no-upstream' | 'detached-head' | 'wrong-branch' | 'dirty'
  | 'diverged' | 'unsigned' | 'reserved-paths' | 'lock-held';
export type UpdatePlan =
  | { action: 'noop'; head: string }
  | { action: 'skip'; reason: SkipReason; detail: string; head: string }
  | { action: 'apply'; from: string; to: string; commits: RangeCommit[]; changedPaths: string[]; permissionSetFileChanged: boolean };

export const PERMISSION_SETS_PATH = 'config/permission-sets.json';

export function matchesReviewPath(path: string, reviewPaths: string[]): boolean {
  const norm = (x: string) => x.normalize('NFC').toLowerCase();
  const p = norm(path);
  return reviewPaths.some((raw) => {
    const e = norm(raw);
    return e.endsWith('/') ? p.startsWith(e) || p === e.slice(0, -1) : p === e;
  });
}

export function planUpdate(facts: RepoFacts, cfg: UpdateConfig, opts: { ignoreEnabled?: boolean } = {}): UpdatePlan {
  const head = facts.head;
  const skip = (reason: SkipReason, detail: string): UpdatePlan => ({ action: 'skip', reason, detail, head });

  if (!cfg.enabled && !opts.ignoreEnabled) return skip('disabled', 'AUTO_UPDATE is not true');
  if (cfg.problems.length > 0) return skip('unconfigured', cfg.problems.join('; '));
  if (facts.currentBranch === null) return skip('detached-head', 'HEAD is detached');
  if (facts.currentBranch !== cfg.branch) {
    return skip('wrong-branch', `on ${facts.currentBranch}, expected ${cfg.branch}`);
  }
  if (facts.dirty) return skip('dirty', 'working tree has uncommitted changes');
  if (facts.upstreamSha === null) return skip('no-upstream', `${facts.upstreamLabel} not found`);

  if (facts.behind === 0 && facts.ahead === 0) return { action: 'noop', head };
  if (facts.ahead > 0) {
    return skip('diverged', `${facts.ahead} local commit(s) not in ${facts.upstreamLabel}, ${facts.behind} behind`);
  }

  if (cfg.requireSigned) {
    const bad = facts.commits.filter((c) => c.signature !== 'G');
    if (bad.length > 0) {
      return skip('unsigned', `no good signature on: ${bad.map((c) => c.sha.slice(0, 12)).join(', ')}`);
    }
    if (cfg.tagPattern !== null && facts.tagSignature !== 'G') {
      return skip('unsigned', `tag ${facts.upstreamLabel} has no good signature`);
    }
  }

  const reserved = facts.changedPaths.filter((p) => matchesReviewPath(p, cfg.reviewPaths));
  if (reserved.length > 0) {
    return skip('reserved-paths', `needs manual review: ${reserved.join(', ')}`);
  }

  return {
    action: 'apply',
    from: head,
    to: facts.upstreamSha,
    commits: facts.commits,
    changedPaths: facts.changedPaths,
    permissionSetFileChanged: facts.changedPaths.includes(PERMISSION_SETS_PATH),
  };
}
