import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium, type Page } from 'playwright';
import BetterSqlite3 from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, saveConnection } from '../db.js';
import { dbPath } from '../dbPath.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
import { resolveControlWithFallback, type FallbackDeps } from '../lib/domFallback.js';
import {
  MAX_NOTE_LENGTH,
  validateNoteLength,
  extractExpectedNameFromTitle,
  pickNearestToNameIndex,
  extractDialogRecipientName,
  namesPlausiblyMatch,
  verifyRecipientName,
  extractProfileSlug,
  verifyProfileUrl,
  isLikelySendInvitationResponse,
  pickButtonShapedIndex,
  extractAboutText,
  type Point,
} from '../linkedin/verify.js';
import { SELECTORS } from '../linkedin/selectors.js';

// One source of truth: the pure helpers live in src/linkedin/verify.ts and selectors.ts;
// re-exported here so existing importers (tests/connect.test.ts) keep working.
export {
  MAX_NOTE_LENGTH,
  validateNoteLength,
  extractExpectedNameFromTitle,
  pickNearestToNameIndex,
  extractDialogRecipientName,
  namesPlausiblyMatch,
  verifyRecipientName,
  extractProfileSlug,
  verifyProfileUrl,
  isLikelySendInvitationResponse,
  pickButtonShapedIndex,
  extractAboutText,
  SELECTORS,
};
export type { Point };

const DEPRECATED_REASON =
  'deprecated: use the linkedin MCP (linkedin_connect_send / linkedin_send_message)';

/** Kill switch, read at call time so tests and operators can flip it without a reload. */
function legacyConnectDisabled(): boolean {
  return process.env.LEGACY_CONNECT_DISABLED === 'true';
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

// Main-account session only — never the linkedin-apply burner session (see that file's
// identical hardcoded-path pattern).
const MAIN_STATE_PATH = path.join(projectRoot, 'secrets', 'linkedin-main-state.json');

const DEFAULT_MAX_LINKEDIN_SEARCHES_PER_DAY = 20;
const DEFAULT_MAX_CONNECTS_PER_DAY = 10;
const DEFAULT_MAX_MESSAGES_PER_DAY = 10;

// Explicit viewport (Playwright otherwise defaults to 1280x720) — this size is the one
// live-verified to work end-to-end for this file's selectors; a shorter viewport was found
// to hide the connect dialog's Send button below the fold.
export const BROWSER_VIEWPORT = { width: 1440, height: 2400 };

// Debug screenshots for connectSend(), gitignored — opt-in aid for diagnosing a suspected
// false-positive 'sent' result (see docs/phase2-known-issues.md).
const DEBUG_SCREENSHOT_DIR = path.join(projectRoot, 'debug', 'connect');

const db = openDb(dbPath());

export interface ProfileCandidate {
  profile_url: string;
  name: string;
  headline: string;
}

export interface FindLinkedinProfileResult {
  status: 'ok' | 'rate_limited' | 'failed';
  candidates: ProfileCandidate[];
  reason?: string;
}

export interface ConnectSendResult {
  status: 'sent' | 'rate_limited' | 'failed';
  reason?: string;
}

export interface ConnectionStatusResult {
  status: 'connected' | 'not_connected' | 'failed';
  reason?: string;
  /** Scraped from the profile's "About" section, same page load as the status check — feeds a
   *  personalized connect note / message. Absent when the profile has no About section. */
  profileContext?: { about?: string };
}

export interface SendLinkedinMessageResult {
  status: 'sent' | 'rate_limited' | 'failed';
  reason?: string;
}

export interface RecordConnectionStatusResult {
  status: 'ok' | 'failed';
  reason?: string;
}

export interface ConnectDeps {
  db?: BetterSqlite3.Database;
  maxSearchesPerDay?: number;
  maxConnectsPerDay?: number;
  maxMessagesPerDay?: number;
  /** Injectable Playwright `chromium` launcher, for testing without a real browser. */
  chromium?: { launch: typeof chromium.launch };
  /** Hybrid Claude fallback for selector-miss escalation (see domFallback.ts); off by default. */
  fallback?: FallbackDeps;
  fallbackEnabled?: boolean;
  /** Save a screenshot at each key connectSend() step to debug/connect/ (gitignored); off by default. */
  debugScreenshots?: boolean;
  /** Total time to keep polling for the "Pending" button before giving up. Injectable for tests. */
  pendingConfirmationTimeoutMs?: number;
  /** How long each individual poll attempt waits before reloading and trying again. */
  pendingConfirmationPollMs?: number;
  /** Total time to keep polling for the message compose box to clear after Send. Injectable for tests. */
  messageComposeClearTimeoutMs?: number;
  /** How long each individual compose-box-clear poll attempt waits before checking again. */
  messageComposeClearPollMs?: number;
}

async function captureDebugScreenshot(
  page: Pick<Page, 'screenshot'>,
  enabled: boolean,
  label: string
): Promise<void> {
  if (!enabled) return;
  try {
    mkdirSync(DEBUG_SCREENSHOT_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: path.join(DEBUG_SCREENSHOT_DIR, `${timestamp}-${label}.png`) });
  } catch {
    // Best-effort diagnostic only — never let a screenshot failure break the real flow.
  }
}

/**
 * Clicks a locator, retrying once via a native DOM `element.click()` if the first attempt
 * times out because something else intercepts the pointer event. INCIDENT 2026-08-28
 * (linkedin.com/in/example-person, live-confirmed, reproduced three times): a sponsored ad icon
 * (`svg#ads-small`) sat on top of the real "Invite ... to connect" button and blocked every
 * normal click attempt for the full 30s timeout. A `{ force: true }` retry was tried first and
 * was WORSE than the timeout: Playwright's forced click still dispatches a coordinate-based
 * mouse event, which the real browser then routes to whatever element is topmost at that
 * point — the ad, not our target — so it silently "succeeded" (no exception) while doing
 * nothing (no dialog ever opened). Dispatching a real DOM click directly on the already-resolved
 * element (`locator.evaluate(el => el.click())`) has no coordinate/hit-testing step at all, so
 * it cannot be redirected to an overlapping element.
 */
async function clickWithForceRetry(locator: {
  click: (opts?: { force?: boolean }) => Promise<void>;
  evaluate: (fn: (el: HTMLElement) => void) => Promise<void>;
}): Promise<void> {
  try {
    await locator.click();
  } catch (err) {
    if (err instanceof Error && /intercepts pointer events|Timeout.*exceeded/.test(err.message)) {
      await locator.evaluate((el) => el.click());
    } else {
      throw err;
    }
  }
}

/**
 * Escalates to a bounded Claude call over the real, currently-visible control texts
 * matching `candidateSelector`, clicking only if Claude's choice is verbatim one of them.
 * Returns whether a click happened. Use directly (not via `findAndClickControl`) when the
 * primary-path check isn't a plain `count() > 0` (e.g. the More-button bounding-box filter).
 */
async function escalateClick(
  page: Pick<Page, 'locator'>,
  intent: string,
  fallback: { enabled: boolean; deps?: FallbackDeps },
  candidateSelector = 'button, [role="button"], a[role="button"]'
): Promise<boolean> {
  const clickableLocator = page.locator(candidateSelector);
  const candidates = await clickableLocator.evaluateAll((els) =>
    els.map((el) => el.textContent?.trim()).filter((t): t is string => !!t)
  );
  const chosenText = await resolveControlWithFallback(candidates, intent, fallback.deps);
  if (!chosenText) return false;

  const fallbackLocator = clickableLocator.filter({ hasText: chosenText });
  if ((await fallbackLocator.count()) === 0) return false;
  await clickWithForceRetry(fallbackLocator.first());
  return true;
}

/**
 * Clicks the element matched by `selector`. If nothing matches and the hybrid fallback is
 * enabled, escalates via `escalateClick` over `candidateSelector`. Mirrors
 * src/apply/linkedin.ts's `findAndClickControl`.
 */
async function findAndClickControl(
  page: Pick<Page, 'locator'>,
  selector: string,
  intent: string,
  fallback: { enabled: boolean; deps?: FallbackDeps },
  candidateSelector?: string
): Promise<boolean> {
  const primaryLocator = page.locator(selector);
  if ((await primaryLocator.count()) > 0) {
    await clickWithForceRetry(primaryLocator.first());
    return true;
  }
  if (!fallback.enabled) return false;
  return escalateClick(page, intent, fallback, candidateSelector);
}

/** Position of the heading whose text matches `expectedName`, or null if none found. */
async function getProfileNamePoint(page: Pick<Page, 'locator'>, expectedName: string): Promise<Point | null> {
  if (!expectedName) return null;
  const headings = await page
    .locator(SELECTORS.nameHeadings)
    .evaluateAll((els) =>
      els.map((el) => {
        const box = el.getBoundingClientRect();
        return { text: (el.textContent ?? '').trim(), x: box.x, y: box.y };
      })
    );
  const match = headings.find((h) => h.text === expectedName);
  return match ? { x: match.x, y: match.y } : null;
}

/**
 * Resolves to whichever match of `selector` sits closest (2D distance) to the profile's own
 * name, replacing a DOM-ancestor scoping guess with proximity to a known-real anchor — and to
 * a zero-match locator (via `.nth(count)`, out of range) if the nearest is implausibly far
 * (see `pickNearestToNameIndex`), so an all-decoy page correctly falls through instead of
 * clicking the only match that exists. Falls back to `.first()` when there are no matches at
 * all or no name position — preserving `Locator.waitFor`'s auto-poll behavior for an element
 * that hasn't rendered yet.
 */
async function pickNearestLocator(page: Pick<Page, 'locator'>, selector: string, namePoint: Point | null) {
  const candidatesLocator = page.locator(selector);
  const count = await candidatesLocator.count();
  if (count === 0 || namePoint === null) return candidatesLocator.first();
  const candidates = await candidatesLocator.evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect();
      return { x: box.x, y: box.y };
    })
  );
  const index = pickNearestToNameIndex(namePoint, candidates);
  return candidatesLocator.nth(index === -1 ? count : index);
}

// Bounded, non-throwing waits below: `Locator.click()` only auto-waits for the clicked
// element itself, not for whatever it triggers, and `Locator.count()` doesn't retry — so
// without these, the next `.count()` check can race a render and report "not found"
// prematurely. Each swallows its own timeout and falls through to the caller's existing
// `.count()` check, which resolves to the pre-existing failure path — never throws.
const MENU_RENDER_TIMEOUT_MS = 8000;

async function waitForConnectMenu(page: Pick<Page, 'locator'>): Promise<void> {
  await page
    .locator(SELECTORS.connectMenuItem)
    .first()
    .waitFor({ state: 'visible', timeout: MENU_RENDER_TIMEOUT_MS })
    .catch(() => {});
}

const CONNECT_DIALOG_TIMEOUT_MS = 8000;

async function waitForConnectDialog(page: Pick<Page, 'locator'>): Promise<void> {
  const anySelector = [SELECTORS.addNoteButton, SELECTORS.sendButton].join(', ');
  await page
    .locator(anySelector)
    .first()
    .waitFor({ state: 'visible', timeout: CONNECT_DIALOG_TIMEOUT_MS })
    .catch(() => {});
}

const NOTE_TRANSITION_TIMEOUT_MS = 8000;

// How long to keep polling (reload + check) for the "Pending" button after Send, and how
// long each poll attempt waits before reloading again — this is the fallback path, used only
// when the faster network-response confirmation (below) doesn't fire. Bumped from 30s to 90s
// after repeated live evidence that 30s isn't consistently enough for real propagation.
const PENDING_CONFIRMATION_TIMEOUT_MS = 90000;
const PENDING_CONFIRMATION_POLL_MS = 5000;

// Bounded wait for the network to settle after navigating to a profile — `domcontentloaded`
// fires before LinkedIn's React app hydrates the header action row.
const PROFILE_HEADER_SETTLE_TIMEOUT_MS = 8000;

// Bounded wait for the send-invitation API response right after clicking Send — much faster
// than reload+poll when it fires.
const NETWORK_CONFIRMATION_TIMEOUT_MS = 12000;

async function waitForNoteDialogTransition(page: Pick<Page, 'locator'>): Promise<void> {
  const anySelector = [SELECTORS.noteTextarea, SELECTORS.sendButton].join(', ');
  await page
    .locator(anySelector)
    .first()
    .waitFor({ state: 'visible', timeout: NOTE_TRANSITION_TIMEOUT_MS })
    .catch(() => {});
}

/**
 * Pure: extracts the clean visible name/headline from a result card's collected
 * profile-link texts and span texts. Exported for unit testing without a live page.
 */
export function extractNameAndHeadline(
  profileLinkTexts: string[],
  spanTexts: string[]
): { name: string; headline: string } {
  const name = (profileLinkTexts[1] ?? profileLinkTexts[0] ?? '').trim();

  let lastDegreeIdx = -1;
  spanTexts.forEach((text, idx) => {
    if (/^•\s*(1st|2nd|3rd)/.test(text.trim())) lastDegreeIdx = idx;
  });
  const headline =
    lastDegreeIdx !== -1 && lastDegreeIdx + 1 < spanTexts.length
      ? spanTexts[lastDegreeIdx + 1].trim()
      : '';

  return { name, headline };
}

/**
 * Scrapes the profile's "About" section raw text (heading + body, unseparated) from the
 * currently-loaded page, or null if the profile has no About section. Live-confirmed
 * 2026-08-29 (linkedin.com/in/example-person-3): finding the <h2> whose exact text is "About"
 * and reading its closest <section> ancestor's textContent works; LinkedIn does not
 * consistently mark this section with an id or role, so no CSS selector alone can find it.
 */
async function scrapeAboutText(page: Pick<Page, 'evaluate'>): Promise<string | null> {
  return page
    .evaluate(() => {
      const heading = Array.from(document.querySelectorAll('main h2')).find(
        (h) => (h.textContent || '').trim().toLowerCase() === 'about'
      );
      const section = heading?.closest('section');
      return section ? (section.textContent || '').trim().replace(/\s+/g, ' ') : null;
    })
    .catch(() => null);
}

export async function findLinkedinProfile(
  { company, role_hint }: { company: string; role_hint?: string },
  deps: ConnectDeps = {}
): Promise<FindLinkedinProfileResult> {
  const database = deps.db ?? db;
  const browserLauncher = deps.chromium ?? chromium;
  const maxPerDay =
    deps.maxSearchesPerDay ??
    Number(process.env.MAX_LINKEDIN_SEARCHES_PER_DAY ?? DEFAULT_MAX_LINKEDIN_SEARCHES_PER_DAY);

  // Gate first, before any Playwright action.
  const allowed = checkAndIncrement(database, 'linkedin_search', maxPerDay);
  if (!allowed) {
    return {
      status: 'rate_limited',
      candidates: [],
      reason: `daily LinkedIn search limit (${maxPerDay}) reached`,
    };
  }

  if (!existsSync(MAIN_STATE_PATH)) {
    return { status: 'failed', candidates: [], reason: 'main LinkedIn session state not found' };
  }

  let browser;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({
      storageState: MAIN_STATE_PATH,
      viewport: BROWSER_VIEWPORT,
    });
    const page = await context.newPage();

    const keywords = `${company} ${role_hint ?? 'recruiter hiring manager talent acquisition'}`;
    await page.goto(
      `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`,
      { timeout: 30000, waitUntil: 'domcontentloaded' }
    );

    // Locators (not ElementHandles) throughout — a Locator re-resolves at action time, so
    // it survives LinkedIn's dynamic re-renders.
    const resultCardsLocator = page.locator(SELECTORS.resultCard);
    const cardCount = await resultCardsLocator.count();
    const candidates: ProfileCandidate[] = [];

    for (let i = 0; i < Math.min(cardCount, 3); i++) {
      const card = resultCardsLocator.nth(i);
      const profileLinksLocator = card.locator(SELECTORS.profileLink);
      const linkCount = await profileLinksLocator.count();

      // Only indices 0/1 are consumed below — extra matches are unrelated mutual-connection
      // avatar links, and were observed to hang/timeout live if queried.
      const profileLinkTexts: string[] = [];
      for (let j = 0; j < Math.min(linkCount, 2); j++) {
        profileLinkTexts.push(((await profileLinksLocator.nth(j).textContent()) ?? '').trim());
      }
      // The clean-name link is the SECOND match within a card; fall back to the first.
      const nameLinkIndex = linkCount > 1 ? 1 : 0;
      const profile_url =
        linkCount > 0 ? ((await profileLinksLocator.nth(nameLinkIndex).getAttribute('href')) ?? '') : '';

      const spanTexts = await card
        .locator('span')
        .evaluateAll((els) => els.map((el) => (el.textContent ?? '').trim()).filter(Boolean));

      const { name, headline } = extractNameAndHeadline(profileLinkTexts, spanTexts);

      if (profile_url) {
        candidates.push({ profile_url, name, headline });
      }
    }

    return { status: 'ok', candidates };
  } catch (err) {
    return {
      status: 'failed',
      candidates: [],
      reason: (err as Error).message ?? 'unknown error during LinkedIn profile search',
    };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Read-only: determines whether `profile_url` is already a 1st-degree LinkedIn connection,
 * BEFORE any drafting or send decision is made — the caller uses this to choose which skill to
 * draft with (draft-connect-note vs draft-linkedin-message) and which send tool to call
 * (connect_send vs send_linkedin_message), rather than discovering it mid-send. Uses the
 * "Manage notifications about <Name>" bell (SELECTORS.bellButton) as the sole signal —
 * live-confirmed present only on a real connection's profile and absent on a real
 * not-connected profile (see SELECTORS.bellButton's doc comment). No rate limit: a single
 * profile-page navigation is no heavier than what connectSend/sendLinkedinMessage already do.
 */
export async function checkConnectionStatus(
  { profile_url }: { profile_url: string },
  deps: ConnectDeps = {}
): Promise<ConnectionStatusResult> {
  const browserLauncher = deps.chromium ?? chromium;

  if (!existsSync(MAIN_STATE_PATH)) {
    return { status: 'failed', reason: 'main LinkedIn session state not found' };
  }

  let browser;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({ storageState: MAIN_STATE_PATH, viewport: BROWSER_VIEWPORT });
    const page = await context.newPage();
    await page.goto(profile_url, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: PROFILE_HEADER_SETTLE_TIMEOUT_MS }).catch(() => {});

    const isConnected = (await page.locator(SELECTORS.bellButton).count()) > 0;
    const aboutRaw = await scrapeAboutText(page);
    const about = aboutRaw ? extractAboutText(aboutRaw) : null;
    return {
      status: isConnected ? 'connected' : 'not_connected',
      ...(about ? { profileContext: { about } } : {}),
    };
  } catch (err) {
    return {
      status: 'failed',
      reason: (err as Error).message ?? 'unknown error during connection status check',
    };
  } finally {
    if (browser) await browser.close();
  }
}

export async function connectSend(
  {
    profile_url,
    note,
    job_id,
    company,
  }: { profile_url: string; note: string; job_id?: string; company?: string },
  deps: ConnectDeps = {}
): Promise<ConnectSendResult> {
  if (legacyConnectDisabled()) return { status: 'failed', reason: DEPRECATED_REASON };
  const database = deps.db ?? db;
  const browserLauncher = deps.chromium ?? chromium;
  const maxPerDay =
    deps.maxConnectsPerDay ?? Number(process.env.MAX_CONNECTS_PER_DAY ?? DEFAULT_MAX_CONNECTS_PER_DAY);
  const fallback = {
    enabled: deps.fallbackEnabled ?? (Boolean(deps.fallback) || process.env.CONNECT_HYBRID_FALLBACK === 'true'),
    deps: deps.fallback,
  };
  const debugScreenshots =
    deps.debugScreenshots ?? process.env.CONNECT_DEBUG_SCREENSHOTS === 'true';

  // Cheap pre-flight checks run before the rate-limit gate, so a rejection never burns a
  // quota slot for a no-op that was never going to touch Playwright.
  const { ok, length } = validateNoteLength(note);
  if (!ok) {
    return {
      status: 'failed',
      reason: `note length ${length} is invalid (must be 1-300 characters; LinkedIn's 300-character cap)`,
    };
  }

  if (!existsSync(MAIN_STATE_PATH)) {
    return { status: 'failed', reason: 'main LinkedIn session state not found' };
  }

  // Gate immediately before the Playwright launch.
  const allowed = checkAndIncrement(database, 'connect_send', maxPerDay);
  if (!allowed) {
    return { status: 'rate_limited', reason: `daily connect limit (${maxPerDay}) reached` };
  }

  let browser;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({
      storageState: MAIN_STATE_PATH,
      viewport: BROWSER_VIEWPORT,
    });
    const page = await context.newPage();
    await page.goto(profile_url, { timeout: 30000, waitUntil: 'domcontentloaded' });
    // Wait for the network to settle — `domcontentloaded` fires before the profile-header
    // action row (Connect/Follow/Pending) finishes hydrating.
    await page.waitForLoadState('networkidle', { timeout: PROFILE_HEADER_SETTLE_TIMEOUT_MS }).catch(() => {});
    await captureDebugScreenshot(page, debugScreenshots, '01-profile-loaded');

    // The profile owner's own name, from the page title (not `<h1>` — confirmed missing
    // entirely on a real profile), captured before any click for the mandatory
    // recipient-name verification gate below and as the proximity anchor below.
    const expectedName = extractExpectedNameFromTitle((await page.title().catch(() => '')) ?? '');
    const namePoint = await getProfileNamePoint(page, expectedName);

    // Step 0: some profiles show "Connect" directly at the top level instead of hiding it
    // behind "More" — check that first, picking whichever match sits closest to the name.
    const directConnectLocator = await pickNearestLocator(page, SELECTORS.directConnectButton, namePoint);
    const hasDirectConnect = (await directConnectLocator.count()) > 0;

    if (hasDirectConnect) {
      await clickWithForceRetry(directConnectLocator);
      await captureDebugScreenshot(page, debugScreenshots, '02-direct-connect-clicked');
    } else {
      // Step 1: click the profile-header "More" button, filtered to the button-shaped
      // match via bounding-box heights (see pickButtonShapedIndex above).
      const moreButtonsLocator = page.locator(SELECTORS.moreButton);
      const moreButtonCount = await moreButtonsLocator.count();
      let moreButtonIndex = -1;
      if (moreButtonCount > 0) {
        const moreButtonBoxes = await moreButtonsLocator.evaluateAll((els) =>
          els.map((el) => ({ height: el.getBoundingClientRect().height }))
        );
        moreButtonIndex = pickButtonShapedIndex(moreButtonBoxes);
      }

      if (moreButtonIndex !== -1) {
        await clickWithForceRetry(moreButtonsLocator.nth(moreButtonIndex));
      } else {
        // No button-shaped match — escalate directly (this check isn't a plain
        // `count() > 0`, so it can't go through findAndClickControl's shared handling).
        const clickedMore =
          fallback.enabled &&
          (await escalateClick(
            page,
            'Open the profile-header overflow menu that contains "Connect" (a button-shaped ' +
              '"More" control, not a small post "…more" text toggle)',
            fallback
          ));
        if (!clickedMore) {
          return {
            status: 'failed',
            reason:
              moreButtonCount === 0
                ? 'More button not found on profile'
                : 'no button-shaped More button found on profile',
          };
        }
      }
      await waitForConnectMenu(page);
      await captureDebugScreenshot(page, debugScreenshots, '02-more-menu-open');

      // Step 2: click "Connect" inside the opened overflow menu.
      const clickedConnectMenuItem = await findAndClickControl(
        page,
        SELECTORS.connectMenuItem,
        'Click "Connect" inside the currently open profile overflow menu',
        fallback,
        '[role="menu"] [role="menuitem"]'
      );
      if (!clickedConnectMenuItem) {
        return { status: 'failed', reason: 'Connect menu item not found after opening More menu' };
      }
    }
    await waitForConnectDialog(page);
    await captureDebugScreenshot(page, debugScreenshots, '03-connect-dialog-open');

    // Independent, text-free safety net: confirm the browser is still on the requested
    // profile right before the note is filled / Send is clicked. Runs before the name check
    // since it doesn't depend on parsing any visible text.
    const urlCheck = verifyProfileUrl(profile_url, page.url());
    if (!urlCheck.ok) {
      await captureDebugScreenshot(page, debugScreenshots, '03a-url-mismatch');
      return {
        status: 'failed',
        reason:
          `profile URL mismatch: expected profile slug "${urlCheck.expectedSlug}" but the ` +
          `browser is currently on "${urlCheck.actualSlug}" — aborting before filling the ` +
          'note or clicking Send',
      };
    }

    // Mandatory recipient-name verification safety net — runs for BOTH the direct-Connect
    // and More-menu paths (both reach this point), before any note is filled or Send is
    // clicked. This is the gate against ANY selector picking the wrong link. FAIL-CLOSED:
    // an unverifiable name (either side empty) blocks rather than allows — see
    // verifyRecipientName's doc comment.
    const dialogTextLocator = page.locator(SELECTORS.noteDialogContainer).first();
    const dialogText = ((await dialogTextLocator.count()) > 0 ? await dialogTextLocator.textContent() : '') ?? '';
    const { ok: recipientOk, recipientName } = verifyRecipientName(expectedName, dialogText);
    if (!recipientOk) {
      await captureDebugScreenshot(page, debugScreenshots, '03b-recipient-name-mismatch');
      return {
        status: 'failed',
        reason: recipientName
          ? `recipient name mismatch: the connect dialog addresses "${recipientName}" but the ` +
            `profile navigated to is "${expectedName}" — aborting before filling the note or ` +
            'clicking Send to avoid sending to the wrong person'
          : `could not verify the connect dialog's recipient name (expected "${expectedName}") — ` +
            'aborting before filling the note or clicking Send',
      };
    }

    const addNoteButtonLocator = page.locator(SELECTORS.addNoteButton);
    if ((await addNoteButtonLocator.count()) > 0) {
      await clickWithForceRetry(addNoteButtonLocator.first());
      await waitForNoteDialogTransition(page);
      const noteInputLocator = page.locator(SELECTORS.noteTextarea);
      if ((await noteInputLocator.count()) > 0) {
        await noteInputLocator.first().fill(note);
      }
      await captureDebugScreenshot(page, debugScreenshots, '04-note-filled');
    }

    // Start listening for the send-invitation API response BEFORE clicking Send, so a fast
    // response can't resolve before we start awaiting it.
    const networkConfirmationPromise = page
      .waitForResponse(isLikelySendInvitationResponse, { timeout: NETWORK_CONFIRMATION_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);

    const clickedSend = await findAndClickControl(
      page,
      SELECTORS.sendButton,
      'Send the LinkedIn connection request from the currently open invite dialog (a ' +
        '"Send"/"Send invitation" button)',
      fallback
    );
    if (!clickedSend) {
      await captureDebugScreenshot(page, debugScreenshots, '05-send-button-not-found');
      return { status: 'failed', reason: 'Send button not found on connect dialog' };
    }
    await captureDebugScreenshot(page, debugScreenshots, '06-immediately-after-send-click');

    // Fast path: a matching 2xx API response is a much more authoritative and quicker signal
    // than waiting for the UI to visually update.
    let pendingConfirmed = await networkConfirmationPromise;

    if (!pendingConfirmed) {
      // Don't trust the click alone — a click can silently no-op. This DOM-disappearance wait
      // is a fast diagnostic capture only; it is NOT the basis for the sent/failed decision.
      await page
        .locator(SELECTORS.sendButton)
        .first()
        .waitFor({ state: 'hidden', timeout: 10000 })
        .catch(() => {});
      await captureDebugScreenshot(page, debugScreenshots, '07-after-dialog-dismiss-wait');

      // Fallback confirmation gate: reload the profile and poll for LinkedIn's own "Pending"
      // action button, which replaces "Follow" once the request is actually recorded.
      const pendingTimeoutMs = deps.pendingConfirmationTimeoutMs ?? PENDING_CONFIRMATION_TIMEOUT_MS;
      const pendingPollMs = deps.pendingConfirmationPollMs ?? PENDING_CONFIRMATION_POLL_MS;
      const deadline = Date.now() + pendingTimeoutMs;
      do {
        await page.goto(profile_url, { timeout: 30000, waitUntil: 'domcontentloaded' }).catch(() => {});
        // Same "checked too early" fix as the initial load — let the reloaded page hydrate
        // before checking for the Pending button.
        await page.waitForLoadState('networkidle', { timeout: PROFILE_HEADER_SETTLE_TIMEOUT_MS }).catch(() => {});
        // Re-derive the name anchor each reload (fresh DOM) and pick the nearest match.
        const pendingNamePoint = await getProfileNamePoint(page, expectedName);
        pendingConfirmed = await (await pickNearestLocator(page, SELECTORS.pendingButton, pendingNamePoint))
          .waitFor({ state: 'visible', timeout: pendingPollMs })
          .then(() => true)
          .catch(() => false);
      } while (!pendingConfirmed && Date.now() < deadline);
    }

    await captureDebugScreenshot(
      page,
      debugScreenshots,
      pendingConfirmed ? '08-pending-confirmed' : '08-pending-not-found'
    );

    if (!pendingConfirmed) {
      return {
        status: 'failed',
        reason:
          'clicked Send but the "Pending" button never appeared on the profile — connection ' +
          'request was not confirmed. Verify manually on LinkedIn.',
      };
    }

    saveConnection(database, {
      job_id: job_id ?? null,
      company: company ?? null,
      profile_url,
      headline: null,
      note,
      status: 'sent',
      sent_at: new Date().toISOString(),
    });

    return { status: 'sent' };
  } catch (err) {
    return {
      status: 'failed',
      reason: (err as Error).message ?? 'unknown error during connect send',
    };
  } finally {
    if (browser) await browser.close();
  }
}

// Bounded wait for the message compose box to render after clicking the Message button.
const MESSAGE_COMPOSE_TIMEOUT_MS = 8000;

// Bounded poll (after clicking Send) for the compose box to actually clear — see the
// 2026-08-28 incident note at its call site.
const MESSAGE_COMPOSE_CLEAR_TIMEOUT_MS = 5000;
const MESSAGE_COMPOSE_CLEAR_POLL_MS = 300;

/**
 * Sends a LinkedIn direct message to a profile that is ALREADY a 1st-degree connection — the
 * counterpart to checkConnectionStatus returning 'connected'. Live-verified 2026-08-28
 * (linkedin.com/in/example-person-2): a real test message sent and appeared correctly in the
 * conversation thread — a send-confirmation false negative was found and fixed the same day
 * (see MESSAGE_COMPOSE_CLEAR_TIMEOUT_MS below).
 *
 * Safety net: same profile-URL fail-closed check as connectSend (verifyProfileUrl) runs before
 * anything is typed or sent. There is no separate recipient-name dialog check here (unlike
 * connectSend) because the message overlay's exact recipient-name markup is unknown; the
 * proximity-based messageButton pick (pickNearestLocator, same mechanism connectSend uses for
 * directConnectButton) plus the URL check are the safety net until live inspection can add a
 * dedicated name check.
 */
export async function sendLinkedinMessage(
  { profile_url, message, job_id, company }: { profile_url: string; message: string; job_id?: string; company?: string },
  deps: ConnectDeps = {}
): Promise<SendLinkedinMessageResult> {
  if (legacyConnectDisabled()) return { status: 'failed', reason: DEPRECATED_REASON };
  const database = deps.db ?? db;
  const browserLauncher = deps.chromium ?? chromium;
  const maxPerDay =
    deps.maxMessagesPerDay ?? Number(process.env.MAX_MESSAGES_PER_DAY ?? DEFAULT_MAX_MESSAGES_PER_DAY);
  const fallback = {
    enabled: deps.fallbackEnabled ?? (Boolean(deps.fallback) || process.env.LINKEDIN_MESSAGE_HYBRID_FALLBACK === 'true'),
    deps: deps.fallback,
  };
  const debugScreenshots = deps.debugScreenshots ?? process.env.CONNECT_DEBUG_SCREENSHOTS === 'true';

  if (message.trim().length === 0) {
    return { status: 'failed', reason: 'message is empty' };
  }

  if (!existsSync(MAIN_STATE_PATH)) {
    return { status: 'failed', reason: 'main LinkedIn session state not found' };
  }

  const allowed = checkAndIncrement(database, 'linkedin_message_send', maxPerDay);
  if (!allowed) {
    return { status: 'rate_limited', reason: `daily message limit (${maxPerDay}) reached` };
  }

  let browser;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({ storageState: MAIN_STATE_PATH, viewport: BROWSER_VIEWPORT });
    const page = await context.newPage();
    await page.goto(profile_url, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: PROFILE_HEADER_SETTLE_TIMEOUT_MS }).catch(() => {});
    await captureDebugScreenshot(page, debugScreenshots, 'm01-profile-loaded');

    const expectedName = extractExpectedNameFromTitle((await page.title().catch(() => '')) ?? '');
    const namePoint = await getProfileNamePoint(page, expectedName);

    const messageButtonLocator = await pickNearestLocator(page, SELECTORS.messageButton, namePoint);
    if ((await messageButtonLocator.count()) === 0) {
      return {
        status: 'failed',
        reason: 'Message button not found on profile — target may not be a 1st-degree connection',
      };
    }
    await clickWithForceRetry(messageButtonLocator);
    await captureDebugScreenshot(page, debugScreenshots, 'm02-message-button-clicked');

    // Fail-closed profile-URL check, same rationale as connectSend's — before typing or
    // sending anything, confirm the browser is still on the requested profile.
    const urlCheck = verifyProfileUrl(profile_url, page.url());
    if (!urlCheck.ok) {
      await captureDebugScreenshot(page, debugScreenshots, 'm02a-url-mismatch');
      return {
        status: 'failed',
        reason:
          `profile URL mismatch: expected profile slug "${urlCheck.expectedSlug}" but the ` +
          `browser is currently on "${urlCheck.actualSlug}" — aborting before typing or sending`,
      };
    }

    const composeTextareaLocator = page.locator(SELECTORS.messageComposeTextarea);
    await composeTextareaLocator
      .first()
      .waitFor({ state: 'visible', timeout: MESSAGE_COMPOSE_TIMEOUT_MS })
      .catch(() => {});
    if ((await composeTextareaLocator.count()) === 0) {
      return { status: 'failed', reason: 'message compose box not found after clicking Message' };
    }
    await clickWithForceRetry(composeTextareaLocator.first());
    await composeTextareaLocator.first().fill(message);
    await captureDebugScreenshot(page, debugScreenshots, 'm03-message-typed');

    const clickedSend = await findAndClickControl(
      page,
      SELECTORS.messageSendButton,
      'Click the Send button in the currently open LinkedIn message compose box',
      fallback
    );
    if (!clickedSend) {
      await captureDebugScreenshot(page, debugScreenshots, 'm04-send-button-not-found');
      return { status: 'failed', reason: 'Send button not found in message compose box' };
    }
    await captureDebugScreenshot(page, debugScreenshots, 'm05-send-clicked');

    // Never trust a click alone (a click can silently no-op — the same class of bug
    // connectSend's Pending-button polling guards against). Best-effort confirmation: LinkedIn
    // clears the compose box after a successful send, so an input still holding the typed text
    // is treated as an unconfirmed send. INCIDENT 2026-08-28 (live-verified): a single immediate
    // read here false-negatived a message that actually sent successfully — LinkedIn clears the
    // box asynchronously, slightly after the Send click resolves. Poll (bounded) instead of a
    // single read, same shape as connectSend's pending-button poll.
    const composeClearTimeoutMs = deps.messageComposeClearTimeoutMs ?? MESSAGE_COMPOSE_CLEAR_TIMEOUT_MS;
    const composeClearPollMs = deps.messageComposeClearPollMs ?? MESSAGE_COMPOSE_CLEAR_POLL_MS;
    const clearDeadline = Date.now() + composeClearTimeoutMs;
    let stillHasText = true;
    do {
      stillHasText = await composeTextareaLocator
        .first()
        .textContent()
        .then((t) => (t ?? '').trim().length > 0)
        .catch(() => true);
      if (!stillHasText) break;
      await page.waitForTimeout(composeClearPollMs);
    } while (Date.now() < clearDeadline);
    if (stillHasText) {
      await captureDebugScreenshot(page, debugScreenshots, 'm06-send-not-confirmed');
      return {
        status: 'failed',
        reason:
          'clicked Send but the message compose box still holds the typed text — send was not ' +
          'confirmed. Verify manually on LinkedIn.',
      };
    }

    saveConnection(database, {
      job_id: job_id ?? null,
      company: company ?? null,
      profile_url,
      headline: null,
      note: message,
      status: 'messaged',
      sent_at: new Date().toISOString(),
    });

    return { status: 'sent' };
  } catch (err) {
    return {
      status: 'failed',
      reason: (err as Error).message ?? 'unknown error during message send',
    };
  } finally {
    if (browser) await browser.close();
  }
}

/**
 * Pure bookkeeping write for a connection draft that was never sent — records a
 * `drafted`/`skipped` row so the orchestrator has a tool to call without ever touching
 * connect_send. No Playwright, no rate-limit gating.
 */
export function recordConnectionStatus(
  {
    profile_url,
    note,
    status,
    job_id,
    company,
  }: { profile_url: string; note: string; status: 'drafted' | 'skipped'; job_id?: string; company?: string },
  deps: { db?: BetterSqlite3.Database } = {}
): RecordConnectionStatusResult {
  const database = deps.db ?? db;
  try {
    saveConnection(database, {
      job_id: job_id ?? null,
      company: company ?? null,
      profile_url,
      headline: null,
      note,
      status,
      sent_at: null,
    });
    return { status: 'ok' };
  } catch (err) {
    return {
      status: 'failed',
      reason: (err as Error).message ?? 'unknown error recording connection status',
    };
  }
}

const server = new McpServer({ name: 'connect', version: '0.1.0' });

server.registerTool(
  'find_linkedin_profile',
  {
    description:
      'DEPRECATED (plan 6C): superseded by the linkedin MCP (linkedin_open / linkedin_state); still supported until plan 6D. ' +
      'Searches LinkedIn people-search for a contact at the given company (recruiter/hiring-manager ' +
      'style roles by default, or a role_hint), using the MAIN LinkedIn account session. Returns up to ' +
      'the top 3 candidate profiles. Gated by a daily linkedin_search rate limit. Read-only — never ' +
      'sends a connection request.',
    inputSchema: {
      company: z.string(),
      role_hint: z.string().optional(),
    },
  },
  async ({ company, role_hint }) => {
    const result = await findLinkedinProfile({ company, role_hint });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

server.registerTool(
  'check_connection_status',
  {
    description:
      'DEPRECATED (plan 6C): superseded by the linkedin MCP (linkedin_open / linkedin_state); still supported until plan 6D. ' +
      'Read-only: checks whether profile_url is already a 1st-degree LinkedIn connection, using the ' +
      'MAIN LinkedIn account session. Call this BEFORE drafting anything — the result decides which ' +
      "skill to draft with (draft-connect-note if 'not_connected', draft-linkedin-message if " +
      "'connected') and which send tool to use afterward (connect_send vs send_linkedin_message). " +
      'Also returns profileContext.about (the profile\'s "About" section text, if present) ' +
      'scraped from the same page load — pass it to the drafting skill so the note/message can ' +
      'reference something real about the person instead of staying generic. ' +
      'Never sends or clicks anything. No rate limit.',
    inputSchema: {
      profile_url: z.string(),
    },
  },
  async ({ profile_url }) => {
    const result = await checkConnectionStatus({ profile_url });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

server.registerTool(
  'connect_send',
  {
    description:
      'DEPRECATED (plan 6C): use linkedin_connect_send on the linkedin MCP. ' +
      'Sends a LinkedIn connection request with a note, using the MAIN LinkedIn account session. ' +
      'This performs the real action immediately when called — it does NOT wait for approval itself. ' +
      'The orchestrating agent (CLAUDE.md) must only call this AFTER an explicit human "send" reply ' +
      'to a posted draft, and only for a profile check_connection_status has already confirmed is ' +
      "'not_connected'; never call this speculatively or on a profile you haven't status-checked. " +
      "Gated by a daily connect_send rate limit and LinkedIn's 300-character note cap. Set " +
      'debug_screenshots=true to save a screenshot at each step to debug/connect/ (gitignored) — ' +
      "useful when investigating a suspected false-positive 'sent' result.",
    inputSchema: {
      profile_url: z.string(),
      note: z.string(),
      job_id: z.string().optional(),
      company: z.string().optional(),
      debug_screenshots: z.boolean().optional(),
    },
  },
  async ({ profile_url, note, job_id, company, debug_screenshots }) => {
    const result = await connectSend(
      { profile_url, note, job_id, company },
      { debugScreenshots: debug_screenshots }
    );
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

server.registerTool(
  'send_linkedin_message',
  {
    description:
      'DEPRECATED (plan 6C): use linkedin_send_message on the linkedin MCP. ' +
      'Sends a LinkedIn direct message to a profile that is ALREADY a 1st-degree connection, using ' +
      'the MAIN LinkedIn account session — call this only for a profile check_connection_status has ' +
      "already confirmed is 'connected'. Performs the real action immediately when called; the " +
      'orchestrating agent must only call this after an explicit human "send" reply to a posted ' +
      'draft, same as connect_send. Gated by a daily linkedin_message_send rate limit ' +
      '(MAX_MESSAGES_PER_DAY). Live-verified 2026-08-28. Set debug_screenshots=true to save a ' +
      'screenshot at each step to debug/connect/ (gitignored).',
    inputSchema: {
      profile_url: z.string(),
      message: z.string(),
      job_id: z.string().optional(),
      company: z.string().optional(),
      debug_screenshots: z.boolean().optional(),
    },
  },
  async ({ profile_url, message, job_id, company, debug_screenshots }) => {
    const result = await sendLinkedinMessage(
      { profile_url, message, job_id, company },
      { debugScreenshots: debug_screenshots }
    );
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

server.registerTool(
  'record_connection_status',
  {
    description:
      'DEPRECATED (plan 6C): superseded by the linkedin MCP (linkedin_open / linkedin_state); still supported until plan 6D. ' +
      "Records a connection draft's status as 'drafted' or 'skipped' in the database. Pure " +
      "bookkeeping write — no Playwright, no rate-limit gating. Use this after posting a drafted " +
      "connection note to Telegram (status='drafted'), or when the user declines to approve it " +
      "(status='skipped'), so the DB reflects what actually happened without ever calling connect_send.",
    inputSchema: {
      profile_url: z.string(),
      note: z.string(),
      status: z.enum(['drafted', 'skipped']),
      job_id: z.string().optional(),
      company: z.string().optional(),
    },
  },
  async ({ profile_url, note, status, job_id, company }) => {
    const result = recordConnectionStatus({ profile_url, note, status, job_id, company });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env.VITEST !== 'true') {
  main().catch((err) => {
    console.error('[connect] fatal error:', err);
    process.exit(1);
  });
}
