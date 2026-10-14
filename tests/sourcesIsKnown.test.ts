import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/sources/adzuna.js', () => ({ fetchAdzuna: vi.fn().mockResolvedValue([]) }));
vi.mock('../src/sources/remotive.js', () => ({ fetchRemotive: vi.fn().mockResolvedValue([]) }));
vi.mock('../src/sources/remoteok.js', () => ({ fetchRemoteok: vi.fn().mockResolvedValue([]) }));
vi.mock('../src/sources/naukri.js', () => ({ fetchNaukri: vi.fn().mockResolvedValue([]) }));
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
