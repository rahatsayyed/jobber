// The one import path for browser launching outside src/linkedin/. It re-exports the shared
// launcher and context options and imports no browser library itself (tests/browser-launch-lint).
export { launchRealChrome, HEADLESS_CONTEXT_OPTIONS, LINKEDIN_CONTEXT_OPTIONS } from '../linkedin/browser.js';
export type { LiBrowser, LiContext, LiLauncher, LiPage } from '../linkedin/types.js';
