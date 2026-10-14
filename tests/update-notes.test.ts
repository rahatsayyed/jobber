import { describe, it, expect } from 'vitest';
import { sanitizeLine, summarizeRange, formatNotification } from '../src/update/notes.js';

const base = {
  outcome: 'updated' as const, from: 'a'.repeat(40), to: 'b'.repeat(40), reason: null, step: null,
  commits: [] as { sha: string; subject: string }[], flags: [] as string[], dryRun: false, restartNeeded: false,
};

describe('sanitizeLine', () => {
  it('strips control, bidi, zero-width and newline characters', () => {
    const out = sanitizeLine('feat: x\u202e evil\n[click](http://x)\u200b\u2028\u2029\ufeff\u0007');
    expect(out).not.toMatch(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/);
    expect(out).toContain('[click](http://x)');
  });
  it('collapses whitespace and caps length', () => {
    expect(sanitizeLine('a   b\t\tc')).toBe('a b c');
    expect(sanitizeLine('x'.repeat(300)).length).toBeLessThanOrEqual(100);
    expect(sanitizeLine('x'.repeat(300), 20).length).toBeLessThanOrEqual(20);
  });
});

describe('summarizeRange', () => {
  it('groups and caps with +N more', () => {
    const commits = Array.from({ length: 30 }, (_, i) => ({ sha: `s${i}`, subject: `fix: thing ${i}` }));
    const lines = summarizeRange(commits, 10);
    expect(lines.length).toBeLessThanOrEqual(11);
    expect(lines[lines.length - 1]).toMatch(/^\+\d+ more$/);
  });
  it('groups by prefix', () => {
    const lines = summarizeRange([
      { sha: '1', subject: 'feat(x): a' }, { sha: '2', subject: 'chore: b' }, { sha: '3', subject: 'docs: c' },
    ]);
    const text = lines.join('\n');
    expect(text).toMatch(/feat/);
    expect(text).toMatch(/docs/);
    expect(text).toMatch(/other/);
  });
});

describe('formatNotification', () => {
  it('updated: range, summary and restart line', () => {
    const t = formatNotification({
      ...base, commits: [{ sha: '1', subject: 'feat: shiny' }, { sha: '2', subject: 'fix: bug' }], restartNeeded: true,
    });
    expect(t).toContain(`${'a'.repeat(12)}..${'b'.repeat(12)}`);
    expect(t).toContain('shiny');
    expect(t).toContain('restart Claude sessions to load the new code');
  });
  it('no restart line when not needed', () => {
    expect(formatNotification(base)).not.toContain('restart Claude sessions');
  });
  it.each([
    ['dirty', 'commit or stash local changes'],
    ['unsigned', 'review the commits and merge by hand or update AUTO_UPDATE_SIGNERS_FILE'],
    ['reserved-paths', 'review these paths, then run git merge --ff-only yourself'],
    ['diverged', 'local commits exist; rebase or reset by hand'],
  ])('skipped %s has a hint', (reason, hint) => {
    const t = formatNotification({ ...base, outcome: 'skipped', to: null, reason });
    expect(t).toContain(reason);
    expect(t).toContain(hint);
  });
  it('in-progress-marker and head-changed have hints, and error points to --status', () => {
    const a = formatNotification({ ...base, outcome: 'skipped', to: null, reason: 'in-progress-marker' });
    expect(a).toContain('fix: a previous update did not finish');
    expect(a).toContain('docs/backup-and-restore.md');
    const h = formatNotification({ ...base, outcome: 'skipped', to: null, reason: 'head-changed' });
    expect(h).toContain('fix: ');
    expect(h).toContain('HEAD moved');
    const e = formatNotification({ ...base, outcome: 'error', reason: 'x', step: 'merge' });
    expect(e).toContain('npm run auto-update -- --status');
    expect(e).not.toContain('update log');
  });
  it('other skip reasons and error get hints', () => {
    for (const r of ['disabled', 'unconfigured', 'no-upstream', 'detached-head', 'wrong-branch', 'lock-held']) {
      const t = formatNotification({ ...base, outcome: 'skipped', to: null, reason: r });
      expect(t.split('\n').length).toBeGreaterThan(1);
      expect(t).toContain(r);
    }
    const e = formatNotification({ ...base, outcome: 'error', reason: 'boom\u202e\nbad', step: 'merge' });
    expect(e).toContain('boom');
    expect(e).toContain('merge');
    expect(e).not.toContain('\u202e');
  });
  it('500 commits stays under 3500 chars', () => {
    const commits = Array.from({ length: 500 }, (_, i) => ({ sha: `${i}`, subject: `feat: ${'long '.repeat(40)}${i}` }));
    expect(formatNotification({ ...base, commits, flags: Array(100).fill('flag '.repeat(30)) }).length).toBeLessThanOrEqual(3500);
  });
  it('keeps html literal', () => {
    expect(formatNotification({ ...base, commits: [{ sha: '1', subject: '<b>hi</b>' }] })).toContain('<b>hi</b>');
  });
});
