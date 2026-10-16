// Imported board-wide feeds (plan 8G task 9, adapted from career-ops-hq/career-ops, MIT): one lazy loader per registry row
// `providers/<id>` in config/platforms.json. A registry string only SELECTS a loader here, it never becomes an import path.
// Every imported source is discover-only for apply (src/lib/discoverOnly.ts) and ships disabled (enabled:false).
import type { Provider } from '../provider.js';

type Loader = () => Promise<{ provider: Provider }>;

/** Source ids in the order they were imported. A test keeps this list, the loaders, the files and config/platforms.json in step. */
export const IMPORTED_IDS = [
  '4dayweek', 'arbeitnow', 'jobicy', 'workingnomads', 'themuse', 'landingjobs', 'thehub', 'flowxtra', 'yourator', 'getonbrd',
  'justjoin', 'manfred', 'cryptocurrencyjobs', 'jobspresso', 'larajobs', 'nodesk', 'pythonorg', 'startup-jobs',
] as const;

export const IMPORTED_LOADERS: Record<string, Loader> = {
  'providers/4dayweek': () => import('./4dayweek.js'),
  'providers/arbeitnow': () => import('./arbeitnow.js'),
  'providers/jobicy': () => import('./jobicy.js'),
  'providers/workingnomads': () => import('./workingnomads.js'),
  'providers/themuse': () => import('./themuse.js'),
  'providers/landingjobs': () => import('./landingjobs.js'),
  'providers/thehub': () => import('./thehub.js'),
  'providers/flowxtra': () => import('./flowxtra.js'),
  'providers/yourator': () => import('./yourator.js'),
  'providers/getonbrd': () => import('./getonbrd.js'),
  'providers/justjoin': () => import('./justjoin.js'),
  'providers/manfred': () => import('./manfred.js'),
  'providers/cryptocurrencyjobs': () => import('./cryptocurrencyjobs.js'),
  'providers/jobspresso': () => import('./jobspresso.js'),
  'providers/larajobs': () => import('./larajobs.js'),
  'providers/nodesk': () => import('./nodesk.js'),
  'providers/pythonorg': () => import('./pythonorg.js'),
  'providers/startup-jobs': () => import('./startup-jobs.js'),
};
