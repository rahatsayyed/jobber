import { describe, expect, it } from 'vitest';
import { realBcPage } from '../src/browserctl/driver.js';

// A page whose "Close your conversation" locator reports one open window per click, until none are left.
function fakePage(open: number, failClickAt = -1) {
  const state = { open, clicks: 0, selectors: [] as string[] };
  const loc = {
    count: async () => state.open,
    first: () => loc,
    click: async () => {
      if (state.clicks === failClickAt) throw new Error('detached');
      state.clicks++;
      state.open--;
    },
  };
  const page: any = {
    url: () => 'https://www.linkedin.com/in/x/',
    locator: (s: string) => { state.selectors.push(s); return loc; },
    waitForTimeout: async () => undefined,
  };
  return { page, state };
}

describe('closeChatWindows', () => {
  it('clicks the close control of every open chat window and returns how many it closed', async () => {
    const f = fakePage(3);
    const bc = realBcPage(f.page);
    expect(await bc.closeChatWindows!()).toBe(3);
    expect(f.state.open).toBe(0);
    expect(f.state.selectors[0]).toContain('Close your conversation');
  });

  it('does nothing when no window is open', async () => {
    const f = fakePage(0);
    expect(await realBcPage(f.page).closeChatWindows!()).toBe(0);
    expect(f.state.clicks).toBe(0);
  });

  it('stops quietly when a click fails and never loops forever', async () => {
    const f = fakePage(5, 1);
    expect(await realBcPage(f.page).closeChatWindows!()).toBe(1);
    const g = fakePage(99);
    expect(await realBcPage(g.page).closeChatWindows!()).toBeLessThanOrEqual(6);
  });
});
