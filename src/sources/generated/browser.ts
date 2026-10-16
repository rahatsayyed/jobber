// Page fetcher for html_list generated providers (O-browser): a read-only page load in the shared locked web session
// (webcore runtime: shared launcher, serial queue, per-host politeness, navigation guard), then the same sanitised HTML
// scout_capture_fixture stores (no scripts, hidden inputs or input values). The host check runs again on the FINAL URL,
// so a redirect off the spec hosts is rejected. This module imports no browser library.
import type { WebRuntime } from '../../webcore/runtime.js';
import { FIXTURE_HTML_SCRIPT } from '../../scout/page.js';
import { hostAllowed } from './spec.js';
import type { TextFetcher } from './engine.js';

export function createBrowserTextFetcher(runtime: WebRuntime, spec: { id: string; hosts: string[] }): TextFetcher {
  return async (url) => {
    const nav = await runtime.open(url, { allowedHosts: spec.hosts, jobId: `gen-${spec.id}` });
    if (!nav.ok) throw new Error(`gen:${spec.id}: page not opened (${nav.code})`);
    return runtime.serial(async () => {
      const page = runtime.page();
      if (!page) throw new Error(`gen:${spec.id}: no page`);
      let finalUrl: URL;
      try { finalUrl = new URL(page.url()); } catch { throw new Error(`gen:${spec.id}: bad final url`); }
      if (finalUrl.protocol !== 'https:' || finalUrl.username || finalUrl.password || !hostAllowed(finalUrl.hostname, spec.hosts)) {
        throw new Error(`gen:${spec.id}: redirected off hosts`);
      }
      const html = await page.evaluate<string>(FIXTURE_HTML_SCRIPT);
      if (typeof html !== 'string' || !html) throw new Error(`gen:${spec.id}: empty page`);
      return html;
    });
  };
}
