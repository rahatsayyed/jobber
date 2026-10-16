import type { Job } from '../db.js';
import { fetchAdzuna } from './adzuna.js';
import { fetchRemotive } from './remotive.js';
import { fetchRemoteok } from './remoteok.js';
import { fetchNaukri } from './naukri.js';
import { fetchBoards } from './boards/index.js';
import { collectSources, statsToOutcomes, type SourceOutcome, type SourceProvider } from './status.js';

export interface FetchParams { role: string; location?: string; isKnown?: (id: string) => boolean }

/**
 * Runs every source. One failing source (sync or async throw) contributes no jobs and an error outcome (redacted, logged to stderr)
 * instead of losing every other source. `outcomes` feeds the per-source status (src/sources/status.ts).
 */
export async function fetchAllJobsDetailed(params: FetchParams): Promise<{ jobs: Job[]; outcomes: SourceOutcome[] }> {
  const providers: SourceProvider[] = [
    { id: 'adzuna', run: () => fetchAdzuna({ role: params.role, location: params.location }) },
    { id: 'remotive', run: () => fetchRemotive({ role: params.role }) },
    { id: 'remoteok', run: () => fetchRemoteok() },
    { id: 'naukri', run: () => fetchNaukri({ role: params.role, location: params.location }) },
    // Boards ignore role/location on purpose: only the filters in config/portals.json apply to them.
    // A board failure (or a missing/invalid portals.json) never loses the other sources.
    {
      id: 'boards',
      run: async () => {
        const r = await fetchBoards({ isKnown: params.isKnown });
        return { jobs: r.jobs, outcomes: statsToOutcomes(r.stats, r.errors) };
      },
    },
  ];
  const { jobs, outcomes } = await collectSources(providers);
  // Source order is stable (adzuna, remotive, remoteok, naukri, boards) because collectSources keeps provider order.
  return { jobs, outcomes };
}

export async function fetchAllJobs(params: FetchParams): Promise<Job[]> {
  return (await fetchAllJobsDetailed(params)).jobs;
}
