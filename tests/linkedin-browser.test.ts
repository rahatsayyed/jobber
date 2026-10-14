import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { launchRealChrome, LINKEDIN_LAUNCH_OPTIONS, LINKEDIN_HEADED_LAUNCH_OPTIONS, LINKEDIN_CONTEXT_OPTIONS } from '../src/linkedin/browser.js';
import { HEADLESS_CONTEXT_OPTIONS } from '../src/sources/naukri.js';
import type { LiBrowser, LiLauncher } from '../src/linkedin/types.js';

function fakeLauncher(): { launcher: LiLauncher; calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  const browser = { newContext: async () => ({}), close: async () => {} } as unknown as LiBrowser;
  return { calls, launcher: { launch: async (o) => { calls.push(o); return browser; } } };
}

describe('launchRealChrome', () => {
  it('passes exactly the headless real-Chrome recipe', async () => {
    const { launcher, calls } = fakeLauncher();
    await launchRealChrome({ launcher });
    expect(calls).toEqual([{ channel: 'chrome', headless: true, args: ['--headless=new'] }]);
    expect(LINKEDIN_LAUNCH_OPTIONS).toEqual({ channel: 'chrome', headless: true, args: ['--headless=new'] });
  });
  it('headed variant is real Chrome without --headless=new', async () => {
    const { launcher, calls } = fakeLauncher();
    await launchRealChrome({ headed: true, launcher });
    expect(calls).toEqual([{ channel: 'chrome', headless: false }]);
    expect(LINKEDIN_HEADED_LAUNCH_OPTIONS).toEqual({ channel: 'chrome', headless: false });
  });
  it('maps a launch error to chrome_unavailable', async () => {
    const launcher: LiLauncher = { launch: async () => { throw new Error("Executable doesn't exist " + 'x'.repeat(500)); } };
    const e = await launchRealChrome({ launcher }).catch((x) => x as Error);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message.startsWith('chrome_unavailable: ')).toBe(true);
    expect((e as Error).message.length).toBeLessThanOrEqual('chrome_unavailable: '.length + 120);
  });
});

describe('context options', () => {
  it('reuses the Naukri headless context options', () => {
    expect(LINKEDIN_CONTEXT_OPTIONS).toEqual(HEADLESS_CONTEXT_OPTIONS);
    expect(LINKEDIN_CONTEXT_OPTIONS.userAgent).not.toMatch(/HeadlessChrome/);
    expect(LINKEDIN_CONTEXT_OPTIONS.locale).toBe('en-IN');
    expect(LINKEDIN_CONTEXT_OPTIONS.timezoneId).toBe('Asia/Kolkata');
    expect(LINKEDIN_CONTEXT_OPTIONS.viewport).toEqual({ width: 1440, height: 900 });
  });
});

describe('source scan', () => {
  const files: string[] = [];
  for (const [dir, re] of [['src/linkedin', /\.ts$/], ['scripts', /^linkedin-.*\.ts$/]] as const) {
    for (const f of readdirSync(dir)) if (re.test(f)) files.push(path.join(dir, f));
  }
  it('finds the linkedin sources', () => { expect(files).toContain(path.join('src/linkedin', 'browser.ts')); });
  it('never imports stock playwright, launches outside browser.ts or names the chromium channel', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/from\s+['"]playwright['"]/);
      expect(src, f).not.toMatch(/['"]chromium['"]/);
      if (path.basename(f) !== 'browser.ts') expect(src, f).not.toMatch(/\.launch\(/);
    }
  });
});
