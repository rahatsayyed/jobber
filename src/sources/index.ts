import type { Job } from '../db.js';
import { fetchAdzuna } from './adzuna.js';
import { fetchRemotive } from './remotive.js';
import { fetchRemoteok } from './remoteok.js';
import { fetchNaukri } from './naukri.js';
import { fetchBoards } from './boards/index.js';

// One failing source (sync or async throw) logs to stderr and contributes [] instead of losing every other source.
async function safely(name: string, fn: () => Promise<Job[]>): Promise<Job[]> {
  try {
    return await fn();
  } catch (e) {
    console.error(`[sources] ${name} failed:`, e);
    return [];
  }
}

export async function fetchAllJobs(params: { role: string; location?: string; isKnown?: (id: string) => boolean }): Promise<Job[]> {
  const [adzuna, remotive, remoteok, naukri, boards] = await Promise.all([
    safely('adzuna', () => fetchAdzuna({ role: params.role, location: params.location })),
    safely('remotive', () => fetchRemotive({ role: params.role })),
    safely('remoteok', () => fetchRemoteok()),
    safely('naukri', () => fetchNaukri({ role: params.role, location: params.location })),
    // Boards ignore role/location on purpose: only the filters in config/portals.json apply to them.
    // A board failure (or a missing/invalid portals.json) never loses the other sources.
    safely('boards', async () => (await fetchBoards({ isKnown: params.isKnown })).jobs),
  ]);
  return [...adzuna, ...remotive, ...remoteok, ...naukri, ...boards];
}
