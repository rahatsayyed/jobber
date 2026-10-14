import { describe, it, expect } from 'vitest';
import { loadUpdateConfig } from '../src/update/config.js';

describe('loadUpdateConfig', () => {
  it('defaults: disabled, origin/main, signing required', () => {
    const c = loadUpdateConfig({});
    expect(c).toMatchObject({ enabled: false, remote: 'origin', branch: 'main', requireSigned: true, tagPattern: null, signersFile: null });
    expect(c.reviewPaths).toContain('.claude/settings.json');
    expect(c.reviewPaths).toContain('config/ccgram.pin.json');
  });
  it('enabled only for the exact string true', () => {
    for (const v of ['TRUE', '1', 'yes', ' true']) expect(loadUpdateConfig({ AUTO_UPDATE: v }).enabled).toBe(false);
    expect(loadUpdateConfig({ AUTO_UPDATE: 'true' }).enabled).toBe(true);
  });
  it('rejects option-like and traversal values for remote, branch and tag pattern', () => {
    for (const bad of ['-x', 'a b', 'a;b', '../x', '']) {
      expect(loadUpdateConfig({ AUTO_UPDATE_BRANCH: bad }).problems.length).toBeGreaterThan(0);
    }
    expect(loadUpdateConfig({ AUTO_UPDATE_REMOTE: '--upload-pack=x' }).problems.length).toBeGreaterThan(0);
    expect(loadUpdateConfig({ AUTO_UPDATE_TAG_PATTERN: 'v*;rm' }).problems.length).toBeGreaterThan(0);
  });
  it('accepts valid values', () => {
    const c = loadUpdateConfig({
      AUTO_UPDATE_REMOTE: 'upstream',
      AUTO_UPDATE_BRANCH: 'release/1.x',
      AUTO_UPDATE_TAG_PATTERN: 'v*',
      AUTO_UPDATE_REQUIRE_SIGNED: 'false',
      AUTO_UPDATE_REVIEW_PATHS: 'a/b, c/ ,',
    });
    expect(c).toMatchObject({ remote: 'upstream', branch: 'release/1.x', tagPattern: 'v*', requireSigned: false, problems: [] });
    expect(c.reviewPaths).toEqual(['a/b', 'c/']);
  });
  it('requireSigned with no signers file is a problem; requireSigned=false is not', () => {
    expect(loadUpdateConfig({ AUTO_UPDATE: 'true' }).problems.join()).toMatch(/signers/i);
    expect(loadUpdateConfig({ AUTO_UPDATE: 'true', AUTO_UPDATE_REQUIRE_SIGNED: 'false' }).problems).toEqual([]);
  });
});
