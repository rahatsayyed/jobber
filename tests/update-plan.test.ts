import { describe, it, expect } from 'vitest';
import { planUpdate, matchesReviewPath, type RepoFacts } from '../src/update/plan.js';
import { loadUpdateConfig } from '../src/update/config.js';

const cfg = loadUpdateConfig({ AUTO_UPDATE: 'true', AUTO_UPDATE_SIGNERS_FILE: '/x/allowed_signers' });
const A = 'a'.repeat(40), B = 'b'.repeat(40);
function facts(over: Partial<RepoFacts> = {}): RepoFacts {
  return { head: A, currentBranch: 'main', dirty: false, upstreamSha: B, upstreamLabel: 'origin/main',
    ahead: 0, behind: 1, commits: [{ sha: B, subject: 'feat: x', signature: 'G' }],
    changedPaths: ['src/a.ts'], tagSignature: null, ...over };
}

describe('planUpdate', () => {
  it('applies a clean signed fast-forward', () => {
    expect(planUpdate(facts(), cfg)).toMatchObject({ action: 'apply', from: A, to: B });
  });
  it('is disabled unless AUTO_UPDATE=true, but ignoreEnabled bypasses that for --now', () => {
    const off = loadUpdateConfig({ AUTO_UPDATE_SIGNERS_FILE: '/x' });
    expect(planUpdate(facts(), off)).toMatchObject({ action: 'skip', reason: 'disabled' });
    expect(planUpdate(facts(), off, { ignoreEnabled: true }).action).toBe('apply');
  });
  it('skips on dirty, detached, wrong branch, no upstream', () => {
    expect(planUpdate(facts({ dirty: true }), cfg)).toMatchObject({ reason: 'dirty' });
    expect(planUpdate(facts({ currentBranch: null }), cfg)).toMatchObject({ reason: 'detached-head' });
    expect(planUpdate(facts({ currentBranch: 'feature' }), cfg)).toMatchObject({ reason: 'wrong-branch' });
    expect(planUpdate(facts({ upstreamSha: null }), cfg)).toMatchObject({ reason: 'no-upstream' });
  });
  it('noop when already up to date; diverged when local commits exist (ahead or both)', () => {
    expect(planUpdate(facts({ behind: 0, commits: [] }), cfg).action).toBe('noop');
    expect(planUpdate(facts({ ahead: 2, behind: 0, commits: [] }), cfg)).toMatchObject({ reason: 'diverged' });
    expect(planUpdate(facts({ ahead: 1, behind: 3 }), cfg)).toMatchObject({ reason: 'diverged' });
  });
  it('unsigned: any non-G commit, listing the shas; allowed when requireSigned=false', () => {
    const f = facts({ commits: [{ sha: A, subject: 'a', signature: 'G' }, { sha: B, subject: 'b', signature: 'N' }] });
    const p = planUpdate(f, cfg);
    expect(p).toMatchObject({ action: 'skip', reason: 'unsigned' });
    expect((p as { detail: string }).detail).toContain(B.slice(0, 12));
    const loose = loadUpdateConfig({ AUTO_UPDATE: 'true', AUTO_UPDATE_REQUIRE_SIGNED: 'false' });
    expect(planUpdate(f, loose).action).toBe('apply');
  });
  it('an unconfigured signer (requireSigned, no file) refuses', () => {
    const bad = loadUpdateConfig({ AUTO_UPDATE: 'true' });
    expect(planUpdate(facts(), bad)).toMatchObject({ reason: 'unconfigured' });
  });
  it('tag mode requires a good tag signature too', () => {
    const t = loadUpdateConfig({ AUTO_UPDATE: 'true', AUTO_UPDATE_SIGNERS_FILE: '/x', AUTO_UPDATE_TAG_PATTERN: 'v*' });
    expect(planUpdate(facts({ upstreamLabel: 'v1.2.0', tagSignature: 'N' }), t)).toMatchObject({ reason: 'unsigned' });
    expect(planUpdate(facts({ upstreamLabel: 'v1.2.0', tagSignature: 'G' }), t).action).toBe('apply');
  });
  it('reserved paths force manual review, with the paths in the detail', () => {
    for (const p of ['.claude/settings.json', '.claude/hooks/x.sh', '.githooks/pre-commit', 'config/ccgram.pin.json', 'scripts/ccgram/run.sh']) {
      const r = planUpdate(facts({ changedPaths: ['src/a.ts', p] }), cfg);
      expect(r).toMatchObject({ action: 'skip', reason: 'reserved-paths' });
      expect((r as { detail: string }).detail).toContain(p);
    }
  });
  it('flags a permission-set definition change without skipping', () => {
    const r = planUpdate(facts({ changedPaths: ['config/permission-sets.json'] }), cfg);
    expect(r).toMatchObject({ action: 'apply', permissionSetFileChanged: true });
  });
  it('permissionSetFileChanged is false otherwise', () => {
    expect(planUpdate(facts(), cfg)).toMatchObject({ action: 'apply', permissionSetFileChanged: false });
  });
});

describe('matchesReviewPath', () => {
  it('prefix entries end with a slash, exact otherwise, no partial-name matches', () => {
    expect(matchesReviewPath('scripts/ccgram/run.sh', ['scripts/ccgram/'])).toBe(true);
    expect(matchesReviewPath('scripts/ccgram-other.sh', ['scripts/ccgram/'])).toBe(false);
    expect(matchesReviewPath('.claude/settings.json', ['.claude/settings.json'])).toBe(true);
    expect(matchesReviewPath('.claude/settings.json.bak', ['.claude/settings.json'])).toBe(false);
  });
  it('is case-insensitive, NFC-normalized, and matches a bare directory name', () => {
    expect(matchesReviewPath('.CLAUDE/hooks/x.sh', ['.claude/hooks/'])).toBe(true);
    expect(matchesReviewPath('Config/ccgram.pin.json', ['config/ccgram.pin.json'])).toBe(true);
    expect(matchesReviewPath('.githooks', ['.githooks/'])).toBe(true);
    expect(matchesReviewPath('café/x', ['café/'])).toBe(true);
  });
});
