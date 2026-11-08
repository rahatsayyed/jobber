import { describe, expect, it } from 'vitest';
import { describeProvider } from './_replay.js';
import { formatRemoteLocation, provider } from '../../src/sources/providers/remote-com.js';

describeProvider({
  id: "remote-com",
  provider,
  file: "remote-com.json",
  host: "remote.com",
  count: 1,
  first: {"title": "Senior React Engineer", "company": "Remote", "url": "https://apply.remote.com/jobs/abc123", "posted_at": "2026-10-20"},
  descStarts: "Location: Remote",
  breakKey: "public_id",
});

describe('formatRemoteLocation', () => {
  it('spells out region codes, keeps unknown ones and the workplace label', () => {
    expect(formatRemoteLocation('APAC, EMEA', 'remote')).toBe('Remote · APAC (Asia-Pacific) / EMEA (Europe, Middle East & Africa)');
    expect(formatRemoteLocation('Narnia, apac, APAC', 'hybrid')).toBe('Hybrid · Narnia / APAC (Asia-Pacific)');
    expect(formatRemoteLocation(null, 'weird')).toBe('');
  });
});
