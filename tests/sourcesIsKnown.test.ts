import { describe, it, expect, vi } from 'vitest';

// The runner (src/sources/runner.ts) loads each source's `provider` export; the mocks expose one that forwards to the mocked fetch.
const mockSource = (fn: string, id: string) => ({ [fn]: vi.fn().mockResolvedValue([]), provider: { id, shapeSpec: {}, fetch: async () => ({ jobs: [], sample: [] }) } });
vi.mock('../src/sources/adzuna.js', () => mockSource('fetchAdzuna', 'adzuna'));
vi.mock('../src/sources/remotive.js', () => mockSource('fetchRemotive', 'remotive'));
vi.mock('../src/sources/remoteok.js', () => mockSource('fetchRemoteok', 'remoteok'));
vi.mock('../src/sources/naukri.js', () => mockSource('fetchNaukri', 'naukri'));
vi.mock('../src/sources/boards/index.js', () => ({ fetchBoards: vi.fn().mockResolvedValue({ jobs: [], errors: [], stats: [] }) }));

describe('fetchAllJobs', () => {
  it('forwards isKnown to the boards fetch and still works without it', async () => {
    const { fetchBoards } = await import('../src/sources/boards/index.js');
    const { fetchAllJobs } = await import('../src/sources/index.js');
    const isKnown = (id: string) => id === 'x';
    await fetchAllJobs({ role: 'r', isKnown });
    expect(vi.mocked(fetchBoards).mock.calls[0][0]).toEqual({ isKnown });
    await fetchAllJobs({ role: 'r' });
    expect(vi.mocked(fetchBoards).mock.calls[1][0]).toEqual({ isKnown: undefined });
  });
});
