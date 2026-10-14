import { describe, it, expect, vi } from 'vitest';
import { openDb, isSeen, saveJob } from '../src/db.js';

// This test targets the seam between `fetchAllJobs` and its caller (`src/mcp/job-fetch.ts`'s
// `list_new_jobs`), which is exactly where Critical #1 slipped through 3 prior task reviews:
// `fetchNaukriJobs` used to call `isSeen`/`saveJob` itself, so by the time `list_new_jobs` ran
// its OWN `isSeen` filter over `fetchAllJobs`'s combined output, every Naukri job had already
// been marked seen and was silently dropped. All four sources must return jobs a caller's own
// fresh isSeen/saveJob dedup pass can still see as new.
//
// All four source modules are mocked here (network/browser-free) so this test exercises only
// the seam contract: what `fetchAllJobs` returns must survive a `list_new_jobs`-shaped
// isSeen-filter-then-saveJob pass, for every source including Naukri.
vi.mock('../src/sources/adzuna.js', () => ({
  fetchAdzuna: vi.fn().mockResolvedValue([
    { id: 'adzuna:1', source: 'adzuna', title: 'A', company: 'Co', url: 'u1', apply_url: 'u1', description: '' },
  ]),
}));
vi.mock('../src/sources/remotive.js', () => ({
  fetchRemotive: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/sources/remoteok.js', () => ({
  fetchRemoteok: vi.fn().mockResolvedValue([]),
}));
vi.mock('../src/sources/boards/index.js', () => ({
  fetchBoards: vi.fn().mockResolvedValue({ jobs: [], errors: [], stats: [] }),
}));
vi.mock('../src/sources/naukri.js', () => ({
  fetchNaukri: vi.fn().mockResolvedValue([
    {
      id: 'naukri:12345',
      source: 'naukri',
      title: 'Full Stack Developer',
      company: 'Acme',
      url: 'https://www.naukri.com/job-listings-full-stack-developer-acme-12345',
      apply_url: 'https://acme.com/careers/apply/123',
      description: '',
    },
  ]),
}));

describe('fetchAllJobs resilience', () => {
  it('a throwing source contributes nothing but keeps the other sources and the boards', async () => {
    const { fetchRemoteok } = await import('../src/sources/remoteok.js');
    const { fetchBoards } = await import('../src/sources/boards/index.js');
    vi.mocked(fetchRemoteok).mockRejectedValueOnce(new Error('remoteok down'));
    vi.mocked(fetchBoards).mockResolvedValueOnce({ jobs: [{ id: 'gh:a:1', source: 'greenhouse', title: 'T', company: 'A', url: 'u', apply_url: 'u', description: '' }], errors: [], stats: [] });
    const { fetchAllJobs } = await import('../src/sources/index.js');
    const jobs = await fetchAllJobs({ role: 'r' });
    expect(jobs.map((j) => j.id)).toEqual(expect.arrayContaining(['adzuna:1', 'naukri:12345', 'gh:a:1']));
  });
});

describe('fetchAllJobs seam with a caller-owned isSeen/saveJob dedup pass', () => {
  it('returns a Naukri job that a fresh caller db has never seen, and survives list_new_jobs-style dedup+persist', async () => {
    const { fetchAllJobs } = await import('../src/sources/index.js');
    const jobs = await fetchAllJobs({ role: 'Full Stack Developer', location: 'India' });

    const naukriJob = jobs.find((j) => j.source === 'naukri');
    expect(naukriJob).toBeDefined();

    // Simulate exactly what list_new_jobs does with a fresh db: fetchNaukri must not have
    // pre-marked this job as seen (that was Critical #1's bug).
    const db = openDb(':memory:');
    expect(isSeen(db, naukriJob!.id)).toBe(false);

    const newJobs = jobs.filter((job) => !isSeen(db, job.id));
    expect(newJobs.map((j) => j.id)).toContain('naukri:12345');

    for (const job of newJobs) {
      saveJob(db, job);
    }

    // Now the caller's own db has legitimately marked it seen, post-persist.
    expect(isSeen(db, 'naukri:12345')).toBe(true);
  });
});
