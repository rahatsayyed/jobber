import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadLearnedPlatforms, saveLearnedPlatform, detectLearned } from '../src/ats/learned.js';
import type { FieldMap } from '../src/ats/types.js';

const fakeFieldMap: FieldMap = {
  name: '#name',
  email: '#email',
  phone: '#phone',
  resumeUpload: '#resume',
  coverLetter: '#cover',
  submitButton: '#submit',
};

describe('learned ATS platform registry', () => {
  let tmpDir: string;
  let configPath: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function freshConfigPath(): string {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'ats-learned-test-'));
    configPath = path.join(tmpDir, 'learned-ats-platforms.json');
    return configPath;
  }

  it('detectLearned normalizes case and one trailing dot like hostMatches', () => {
    const p = freshConfigPath();
    saveLearnedPlatform('jobs.example.com', fakeFieldMap, p);
    expect(detectLearned('https://Jobs.Example.com./apply', p)?.platform).toBe('jobs.example.com');
    expect(detectLearned('https://jobs.example.com/apply', p)?.platform).toBe('jobs.example.com');
    expect(detectLearned('https://jobs.example.com.evil.net/apply', p)).toBeNull();
  });

  it('loadLearnedPlatforms returns {} when the file does not exist yet (first run)', () => {
    const p = freshConfigPath();
    expect(loadLearnedPlatforms(p)).toEqual({});
  });

  it('saveLearnedPlatform then loadLearnedPlatforms round-trips a FieldMap', () => {
    const p = freshConfigPath();
    saveLearnedPlatform('jobs.example.com', fakeFieldMap, p);
    expect(loadLearnedPlatforms(p)).toEqual({ 'jobs.example.com': fakeFieldMap });
  });

  it('saveLearnedPlatform merges a new domain without clobbering an existing one', () => {
    const p = freshConfigPath();
    saveLearnedPlatform('jobs.example.com', fakeFieldMap, p);
    const other: FieldMap = { ...fakeFieldMap, name: '#other-name' };
    saveLearnedPlatform('careers.other.com', other, p);

    const registry = loadLearnedPlatforms(p);
    expect(registry['jobs.example.com']).toEqual(fakeFieldMap);
    expect(registry['careers.other.com']).toEqual(other);
  });

  it('detectLearned matches a URL by hostname against the registry', () => {
    const p = freshConfigPath();
    saveLearnedPlatform('jobs.example.com', fakeFieldMap, p);
    const result = detectLearned('https://jobs.example.com/careers/123?ref=abc', p);
    expect(result).toEqual({ platform: 'jobs.example.com', fieldMap: fakeFieldMap });
  });

  it('detectLearned returns null for a domain not in the registry', () => {
    const p = freshConfigPath();
    saveLearnedPlatform('jobs.example.com', fakeFieldMap, p);
    expect(detectLearned('https://unrelated.com/jobs/1', p)).toBeNull();
  });

  it('detectLearned returns null for a malformed URL instead of throwing', () => {
    const p = freshConfigPath();
    expect(detectLearned('not a url', p)).toBeNull();
  });
});
