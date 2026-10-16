// Builds the Provider of one company-board vendor from its existing fetcher: the runner gets jobs plus a raw sample without
// the fetcher having to hand its payload over (transport.ts feeds the sink). Imports only types from the vendor files.
import type { z } from 'zod';
import type { Provider } from '../provider.js';
import type { BoardFetcher, BoardJob } from './greenhouse.js';
import { withRawSink } from './transport.js';

export const SAMPLE_ITEMS = 5;

/** Items of `raw[key]` when it is an array, otherwise the payload itself, so a renamed envelope key fails the item spec instead of passing as an empty board. */
export function listAt(raw: unknown, key: string): unknown[] {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[key] : undefined;
  return Array.isArray(v) ? v : [raw];
}

export interface BoardProvider extends Provider {
  /** Raw payloads captured while the fetcher ran -> the sample for the shape check ([] when nothing was captured). */
  sampleOf(raws: unknown[]): unknown[];
}

export function makeBoardProvider(id: string, fetcher: BoardFetcher, shapeSpec: z.ZodTypeAny, itemsOf: (raws: unknown[]) => unknown[]): BoardProvider {
  const sampleOf = (raws: unknown[]): unknown[] => {
    if (!raws.length) return [];
    try { return itemsOf(raws).slice(0, SAMPLE_ITEMS); } catch { return [{ unreadable: true }]; }
  };
  return {
    id,
    shapeSpec,
    sampleOf,
    async fetch(ctx) {
      if (!ctx.company) throw new Error(`${id}: fetch needs ctx.company`);
      const raws: unknown[] = [];
      const jobs: BoardJob[] = await withRawSink(raws, () => fetcher(ctx.company!, ctx));
      return { jobs, sample: sampleOf(raws) };
    },
  };
}
