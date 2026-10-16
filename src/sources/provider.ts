// The contract between the script-first runner (runner.ts) and one source (a vendor board, an API, Naukri).
import type { z } from 'zod';
import type { Job } from '../db.js';
import type { FetchCtx } from './boards/greenhouse.js';

export type { FetchCtx };

export interface Provider {
  id: string;
  /** Throws on a request or parse failure (the runner records it). `sample` is up to 5 RAW items for the shape check, before any normalizing. */
  fetch(ctx: FetchCtx): Promise<{ jobs: Job[]; sample: unknown[] }>;
  /** What one raw item must look like (required keys and types only, extra keys allowed). */
  shapeSpec: z.ZodTypeAny;
}
