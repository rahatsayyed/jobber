import { describe, expect, it } from 'vitest';
import { scrapeEmails } from '../src/lib/scrape.js';
import type { LiBrowser, LiLauncher, LiPage } from '../src/linkedin/types.js';

function launcherWith(pages: Record<string, string>) {
  const state = { launches: 0, closes: 0, visited: [] as string[], ctx: [] as Array<Record<string, unknown>> };
  const launcher: LiLauncher = {
    async launch(): Promise<LiBrowser> {
      state.launches++;
      return {
        async newContext(o) {
          state.ctx.push(o);
          let cur = '';
          const page = {
            async goto(u: string) { state.visited.push(u); cur = u; if (!(u in pages)) throw new Error('404'); },
            async evaluate(src: string) {
              return src.includes('mailto') ? [] : pages[cur] ?? '';
            },
          } as unknown as LiPage;
          return { newPage: async () => page } as never;
        },
        async close() { state.closes++; },
      };
    },
  };
  return { launcher, state };
}

describe('scrapeEmails', () => {
  it('launches through the injected shared-launcher seam and extracts emails', async () => {
    const { launcher, state } = launcherWith({ 'https://acme.test': 'write to jobs@acme.test', 'https://acme.test/careers': 'hr@acme.test' });
    const out = await scrapeEmails('acme.test', { launcher });
    expect(state.launches).toBe(1);
    expect(state.closes).toBe(1);
    expect(state.ctx[0]).toMatchObject({ locale: 'en-IN' });
    expect(out.sort()).toEqual(['hr@acme.test', 'jobs@acme.test']);
    expect(state.visited[0]).toBe('https://acme.test');
  });

  it('returns [] when Chrome is unavailable', async () => {
    const launcher: LiLauncher = { launch: async () => { throw new Error('nope'); } };
    expect(await scrapeEmails('acme.test', { launcher })).toEqual([]);
  });
});
