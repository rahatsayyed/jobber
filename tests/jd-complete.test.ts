// The one definition of a complete job description (src/jdComplete.ts) and its reuse by src/atsJd.ts.
import { describe, expect, it } from 'vitest';
import { applyJdNote, isJdIncomplete as atsIncomplete, JD_MIN_CHARS } from '../src/atsJd.js';
import {
  JD_FETCH_SOURCES, JD_MIN_CHARS_COMPLETE, cleanJdText, isJdComplete, isJdIncomplete, jdFetchPlatform, needsJdFetch,
} from '../src/jdComplete.js';

const SENTENCE = 'We are hiring a full stack engineer to build React and Node.js products with PostgreSQL and TypeScript for our customers. ';
const FULL = SENTENCE.repeat(4); // about 480 characters
const pad = (n: number): string => 'a '.repeat(Math.ceil(n / 2)).slice(0, n - 1) + 'z';

describe('isJdComplete', () => {
  it('needs at least 400 cleaned characters', () => {
    expect(JD_MIN_CHARS_COMPLETE).toBe(400);
    expect(isJdComplete(pad(399))).toBe(false);
    expect(isJdComplete(pad(400))).toBe(true);
    expect(isJdComplete(FULL)).toBe(true);
  });
  it('rejects empty, null, a snippet and a location-only line', () => {
    for (const v of [null, undefined, '', '   ', 'India (Remote)', 'Bengaluru, Karnataka, India', 'Build scalable web applications using React and Node.']) {
      expect(isJdComplete(v)).toBe(false);
      expect(isJdIncomplete(v)).toBe(true);
    }
  });
  it('never counts a leading Location line toward the length', () => {
    const withLoc = `Location: Bengaluru, India (Remote)\n\n${pad(390)}`;
    expect(withLoc.length).toBeGreaterThan(400);
    expect(isJdComplete(withLoc)).toBe(false);
    expect(isJdComplete(`Location: Pune\n\n${pad(400)}`)).toBe(true);
    expect(cleanJdText('Location: Pune\n\nBody   text\n here')).toBe('Body text here');
  });
  it('rejects a text that ends in a truncation marker', () => {
    expect(isJdComplete(`${FULL}...`)).toBe(false);
    expect(isJdComplete(`${FULL}…`)).toBe(false);
    expect(isJdComplete(`${FULL} Read more`)).toBe(false);
    expect(isJdComplete(`${FULL} show more`)).toBe(false);
    expect(isJdComplete(`${FULL}  See more `)).toBe(false);
    expect(isJdComplete(`${FULL} [truncated]`)).toBe(false);
    // a marker in the middle is fine
    expect(isJdComplete(`${FULL} Read more about us at the careers page. ${SENTENCE}`)).toBe(true);
  });
  it('is the definition atsJd uses (one place)', () => {
    expect(JD_MIN_CHARS).toBe(JD_MIN_CHARS_COMPLETE);
    expect(atsIncomplete).toBe(isJdIncomplete);
    expect(applyJdNote(50, pad(399))).toEqual({ coverage: null, note: 'jd_incomplete' });
    expect(applyJdNote(50, FULL)).toEqual({ coverage: 50, note: null });
  });
});

describe('JD_FETCH_SOURCES', () => {
  it('gates the snippet-only sources and leaves API and board sources alone', () => {
    expect(JD_FETCH_SOURCES).toEqual(expect.arrayContaining(['naukri', 'linkedin-jobs']));
    expect(jdFetchPlatform('naukri')).toBe('naukri');
    expect(jdFetchPlatform('manual:naukri')).toBe('naukri');
    expect(jdFetchPlatform('linkedin-jobs')).toBe('linkedin');
    expect(jdFetchPlatform('manual:linkedin')).toBe('linkedin');
    for (const s of ['remoteok', 'remotive', 'greenhouse', 'lever', 'wellfound', 'linkedin-posts', 'hackernews', 'gen:x', null, undefined]) {
      expect(jdFetchPlatform(s)).toBeNull();
      expect(needsJdFetch(s, 'x')).toBe(false);
    }
  });
  it('needsJdFetch is true only for a gated source with an incomplete description', () => {
    expect(needsJdFetch('naukri', 'India')).toBe(true);
    expect(needsJdFetch('linkedin-jobs', null)).toBe(true);
    expect(needsJdFetch('naukri', FULL)).toBe(false);
    expect(needsJdFetch('linkedin-jobs', `${FULL}...`)).toBe(true);
  });
});
