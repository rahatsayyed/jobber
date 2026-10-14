import { chromium, type Page } from 'playwright';
import BetterSqlite3 from 'better-sqlite3';
import { openDb, getJob, getExcludedReason, getFirstHardStop, saveApplication } from '../db.js';
import { dbPath } from '../dbPath.js';
import { getBaseResume } from '../resume.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
import { resolveControlWithFallback, type FallbackDeps } from '../lib/domFallback.js';
import type { FieldMap } from '../ats/types.js';
import * as greenhouse from '../ats/greenhouse.js';
import * as lever from '../ats/lever.js';
import * as workday from '../ats/workday.js';
import * as ashby from '../ats/ashby.js';
import { detectLearned, saveLearnedPlatform } from '../ats/learned.js';
import { snapshotFormControls } from '../lib/domSnapshot.js';
import { bootstrapFieldMap } from '../lib/atsBootstrap.js';
import { lookAlikeAtsHost } from '../lib/hostClass.js';
import { isDiscoverOnlySource } from '../lib/discoverOnly.js';

// Best-effort, NOT live-verified selectors (unlike linkedin.ts's
// SELECTORS.submissionConfirmation, which was confirmed live against a real posting).
// There is no single proven post-submit signal across Greenhouse/Lever/Workday/Ashby in this
// codebase — this is a defensible heuristic guess at common confirmation copy, not a
// guarantee. Treat any 'submitted' result gated on this as lower-confidence than
// linkedin.ts's equivalent until a real posting confirms it.
export const SELECTORS = {
  submissionConfirmation:
    'text=/thank you|application (received|submitted)|successfully submitted|application complete/i',
} as const;

/**
 * Clicks the element matched by `selector`. If nothing matches (a selector-rot case) and the
 * hybrid fallback is enabled, escalates to a bounded Claude call over the real, currently-
 * visible button/link texts, clicking only if Claude's choice is verbatim one of them.
 * Returns whether a click happened. Mirrors linkedin.ts's `findAndClickControl`.
 */
async function findAndClickControl(
  page: Pick<Page, 'locator'>,
  selector: string,
  intent: string,
  fallback: { enabled: boolean; deps?: FallbackDeps }
): Promise<boolean> {
  const primaryLocator = page.locator(selector);
  if ((await primaryLocator.count()) > 0) {
    await primaryLocator.first().click();
    return true;
  }
  if (!fallback.enabled) return false;

  const clickableLocator = page.locator('button, [role="button"], a[role="button"]');
  const candidates = await clickableLocator.evaluateAll((els) =>
    els.map((el) => el.textContent?.trim()).filter((t): t is string => !!t)
  );
  const chosenText = await resolveControlWithFallback(candidates, intent, fallback.deps);
  if (!chosenText) return false;

  const fallbackLocator = clickableLocator.filter({ hasText: chosenText });
  if ((await fallbackLocator.count()) === 0) return false;
  await fallbackLocator.first().click();
  return true;
}

// Must match linkedin.ts's own DEFAULT_MAX_APPLIES_PER_DAY — see the shared-counter
// rationale on the `checkAndIncrement` call below.
const DEFAULT_MAX_APPLIES_PER_DAY = 5;

const db = openDb(dbPath());

interface AtsModule {
  detect(url: string): string | null;
  fieldMap: FieldMap;
}

const ATS_MODULES: AtsModule[] = [greenhouse, lever, workday, ashby];

/** Required fields — if a selector for any of these is missing on the page, the
 * application is routed to manual_review rather than being submitted. */
const REQUIRED_FIELDS: Array<keyof FieldMap> = ['name', 'email', 'resumeUpload'];

/**
 * Splits a full name on the first whitespace boundary into first/last parts.
 * A single-word name (no whitespace) yields an empty last name.
 */
export function splitName(fullName: string | undefined): { first: string; last: string } {
  const trimmed = (fullName ?? '').trim();
  if (!trimmed) return { first: '', last: '' };
  const idx = trimmed.indexOf(' ');
  if (idx === -1) return { first: trimmed, last: '' };
  return { first: trimmed.slice(0, idx), last: trimmed.slice(idx + 1).trim() };
}

/**
 * Returns the [key, selector] pairs that must resolve on the page before submission.
 * When a platform's fieldMap declares both `firstName` and `lastName` selectors, those
 * replace the combined `name` requirement so the gate checks the selectors that will
 * actually be filled, rather than the (unused) combined-name selector.
 */
function getRequiredFieldEntries(fieldMap: FieldMap): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  for (const key of REQUIRED_FIELDS) {
    if (key === 'name' && fieldMap.firstName && fieldMap.lastName) {
      entries.push(['firstName', fieldMap.firstName], ['lastName', fieldMap.lastName]);
      continue;
    }
    entries.push([key, fieldMap[key] as string]);
  }
  return entries;
}

/**
 * Finds the tailored resume + cover-letter body prepared for a job, checking both the legacy
 * `outreach` table (the old direct-send flow) and `outreach_queue` (the autonomous pipeline,
 * which never writes to `outreach`) and preferring whichever row is more recent — mirrors
 * linkedin.ts's `findPreparedResumePath`, which fixed the identical gap for Easy Apply on
 * 2026-07-20. That fix was never ported here, so every external-ATS apply attempt via the
 * autonomous pipeline fell through to manual_review with "no prepared resume found" until now.
 */
function findPreparedApplicationMaterials(
  database: BetterSqlite3.Database,
  job_id: string
): { resume_path: string; body: string } | undefined {
  const legacy = database
    .prepare('SELECT resume_path, body, created_at FROM outreach WHERE job_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(job_id) as { resume_path: string; body: string; created_at: string } | undefined;
  const queued = database
    .prepare(
      `SELECT resume_pdf_path as resume_path, email_body as body, created_at FROM outreach_queue
       WHERE job_id = ? AND resume_pdf_path IS NOT NULL ORDER BY created_at DESC LIMIT 1`
    )
    .get(job_id) as { resume_path: string; body: string; created_at: string } | undefined;

  if (!legacy && !queued) return undefined;
  if (!legacy) return { resume_path: queued!.resume_path, body: queued!.body };
  if (!queued) return { resume_path: legacy.resume_path, body: legacy.body };
  return new Date(queued.created_at) >= new Date(legacy.created_at)
    ? { resume_path: queued.resume_path, body: queued.body }
    : { resume_path: legacy.resume_path, body: legacy.body };
}

export interface AtsDetection {
  platform: string;
  fieldMap: FieldMap;
}

/** Pure: given an apply_url, figure out which ATS platform hosts it (or null). */
export function detectAts(url: string): AtsDetection | null {
  for (const mod of ATS_MODULES) {
    const platform = mod.detect(url);
    if (platform) return { platform, fieldMap: mod.fieldMap };
  }
  return null;
}

export interface ApplyExternalResult {
  job_id: string;
  status: 'submitted' | 'manual_review' | 'failed' | 'rate_limited';
  platform?: string | null;
  reason?: string;
}

export interface ApplyExternalDeps {
  db?: BetterSqlite3.Database;
  maxAppliesPerDay?: number;
  /** Injectable Playwright `chromium` launcher, for testing without a real browser. */
  chromium?: { launch: typeof chromium.launch };
  /**
   * Hybrid Claude fallback for submit-button-selector-miss escalation only (see
   * domFallback.ts and linkedin.ts's identical pattern). Off by default unless
   * explicitly enabled here or via `EXTERNAL_APPLY_HYBRID_FALLBACK=true`. Required-field
   * selectors (name/email/resumeUpload) are NOT covered — Greenhouse/Lever/Workday/Ashby's
   * field IDs are documented as far more stable than LinkedIn's, and matching a label to an
   * input is different work this fallback doesn't do.
   */
  fallback?: FallbackDeps;
  fallbackEnabled?: boolean;
  /**
   * Injectable Claude fallback for the self-extending ATS bootstrap step (always-on, no
   * opt-in flag — see docs/superpowers/specs/2026-07-21-ats-bootstrap-design.md). Separate
   * from `fallback` above, which only covers the opt-in submit-click escalation.
   */
  bootstrap?: FallbackDeps;
  /**
   * Override for the learned-platform registry file path, for testing without touching the
   * real config/learned-ats-platforms.json.
   */
  learnedPlatformsPath?: string;
}

function recordAndReturn(
  database: BetterSqlite3.Database,
  jobId: string,
  platform: string | null,
  status: 'submitted' | 'manual_review' | 'failed',
  reason?: string
): ApplyExternalResult {
  saveApplication(database, {
    job_id: jobId,
    platform,
    status,
    reason: reason ?? null,
    applied_at: status === 'submitted' ? new Date().toISOString() : null,
  });
  return { job_id: jobId, status, platform, reason };
}

export async function applyExternal(
  { job_id, expected_platform }: { job_id: string; expected_platform?: string },
  deps: ApplyExternalDeps = {}
): Promise<ApplyExternalResult> {
  const database = deps.db ?? db;
  const browserLauncher = deps.chromium ?? chromium;
  const fallback = {
    enabled:
      deps.fallbackEnabled ?? (Boolean(deps.fallback) || process.env.EXTERNAL_APPLY_HYBRID_FALLBACK === 'true'),
    deps: deps.fallback,
  };

  const job = getJob(database, job_id);
  if (!job || !job.apply_url) {
    return recordAndReturn(database, job_id, null, 'manual_review', 'job not found or missing apply_url');
  }
  // Jobs from discover-only sources (Workday boards, aggregators, vendors without an apply module) are refused before the veto lookup,
  // the bootstrap, the browser and the daily counter: their apply_url may be an aggregator page or a tenant host we never learned.
  if (isDiscoverOnlySource(job.source)) {
    return recordAndReturn(database, job_id, null, 'manual_review', `source "${job.source}" is discover-only: apply is not supported for it (email and connect outreach still run)`);
  }
  const vetoReason = getExcludedReason(database, job_id);
  if (vetoReason) {
    return recordAndReturn(database, job_id, null, 'manual_review', `excluded by veto: ${vetoReason}`);
  }
  const hardStop = getFirstHardStop(database, job_id);
  if (hardStop) {
    return recordAndReturn(database, job_id, null, 'manual_review', `hard stop: ${hardStop}`);
  }

  if (lookAlikeAtsHost(job.apply_url)) {
    // A host that imitates greenhouse/lever/workday/ashby/linkedin but is not one must never reach the
    // ATS bootstrap (it would learn a field map for it and submit personal data). Fail closed.
    return recordAndReturn(database, job_id, null, 'manual_review', 'apply_url host is a look-alike of a known ATS/LinkedIn domain; refusing to apply or bootstrap');
  }

  // Only http(s) URLs may proceed: javascript:, file:, data:, protocol-relative and unparseable URLs never reach
  // detectAts/detectLearned, the bootstrap, the browser or the rate counter.
  let schemeOk = false;
  try { const proto = new URL(job.apply_url).protocol; schemeOk = proto === 'http:' || proto === 'https:'; } catch { /* unparseable */ }
  if (!schemeOk) {
    return recordAndReturn(database, job_id, null, 'manual_review', 'apply_url is not an http(s) URL; refusing to apply');
  }

  const prepared = findPreparedApplicationMaterials(database, job_id);

  if (!prepared || !prepared.resume_path) {
    return recordAndReturn(
      database,
      job_id,
      null,
      'manual_review',
      'no tailored resume/cover letter prepared for this job (run outreach-preparer first)'
    );
  }

  let ats = detectAts(job.apply_url) ?? detectLearned(job.apply_url, deps.learnedPlatformsPath);

  if (!ats) {
    if (expected_platform) {
      // A caller invoking a SPECIFIC platform tool (apply.greenhouse et al.) always sets
      // expected_platform. An unrecognized domain there means a data problem (wrong apply_url
      // stored), not a legitimate new platform to learn — bootstrapping only ever fires for
      // the no-expected-platform case (a generic caller with no fixed platform in mind), never
      // through an explicit specific-platform tool call.
      return recordAndReturn(database, job_id, null, 'manual_review', 'unsupported ATS platform');
    }
    // else: fall through — attempt to bootstrap a FieldMap once the browser has launched, below.
  } else if (expected_platform && ats.platform !== expected_platform) {
    // Safety check for the per-platform tool split (apply.greenhouse/lever/workday/ashby): a
    // job's apply_url can drift from what the caller expects (e.g. a Greenhouse posting that
    // redirects through a Lever-branded domain). Refuse rather than silently applying through
    // the wrong platform's tool.
    return recordAndReturn(
      database,
      job_id,
      ats.platform,
      'manual_review',
      `expected platform "${expected_platform}" but apply_url resolved to "${ats.platform}"`
    );
  }

  const applicant = getBaseResume();

  // Gate immediately before the Playwright launch — after every cheap, pure, non-browser
  // pre-flight check above (job lookup, tailored-resume lookup, ATS detection, base resume
  // fetch) has already had a chance to reject the request for free, so a rejection never
  // burns a quota slot for a no-op. An unrecognized domain with no expected_platform is NOT a
  // cheap rejection past this point — bootstrapping is a real attempt (browser launch + a
  // live Claude call) and still burns a slot, the same as any other apply attempt.
  //
  // Judgment call: this shares the SAME 'easy_apply' counter key as linkedin.ts's
  // `apply_easy_apply`, per the design spec (docs/superpowers/specs/2026-07-07-jobapplier-
  // phase2-design.md §5.1: "Rate-limited by MAX_APPLIES_PER_DAY (shared counter with 5.2)"),
  // where §5.2 is this file. So `MAX_APPLIES_PER_DAY` is one combined daily cap across
  // LinkedIn Easy Apply + external ATS applies, not two independent caps.
  const maxPerDay =
    deps.maxAppliesPerDay ?? Number(process.env.MAX_APPLIES_PER_DAY ?? DEFAULT_MAX_APPLIES_PER_DAY);
  const allowed = checkAndIncrement(database, 'easy_apply', maxPerDay);
  if (!allowed) {
    return {
      job_id,
      status: 'rate_limited',
      platform: ats?.platform ?? null,
      reason: `daily apply limit (${maxPerDay}) reached`,
    };
  }

  let browser;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(job.apply_url, { timeout: 30000, waitUntil: 'domcontentloaded' });

    if (!ats) {
      let hostname: string | null = null;
      try {
        hostname = new URL(job.apply_url).hostname.toLowerCase();
      } catch {
        hostname = null;
      }

      const snapshot = await snapshotFormControls(page);
      const bootstrapResult = await bootstrapFieldMap(snapshot, deps.bootstrap);
      if ('missing' in bootstrapResult) {
        return recordAndReturn(
          database,
          job_id,
          hostname,
          'manual_review',
          `could not learn a field map for this platform — missing: ${bootstrapResult.missing.join(', ')}`
        );
      }

      if (hostname) saveLearnedPlatform(hostname, bootstrapResult.fieldMap, deps.learnedPlatformsPath);
      ats = { platform: hostname ?? 'unknown', fieldMap: bootstrapResult.fieldMap };
    }
    const resolvedAts = ats!;

    for (const [key, selector] of getRequiredFieldEntries(resolvedAts.fieldMap)) {
      const el = await page.$(selector);
      if (!el) {
        return recordAndReturn(
          database,
          job_id,
          resolvedAts.platform,
          'manual_review',
          `required field "${key}" not found on page (selector: ${selector})`
        );
      }
    }

    if (resolvedAts.fieldMap.firstName && resolvedAts.fieldMap.lastName) {
      const { first, last } = splitName(applicant.name);
      await page.fill(resolvedAts.fieldMap.firstName, first);
      await page.fill(resolvedAts.fieldMap.lastName, last);
    } else {
      await page.fill(resolvedAts.fieldMap.name, applicant.name ?? '');
    }

    await page.fill(resolvedAts.fieldMap.email, applicant.email ?? '');

    if (applicant.phone) {
      const phoneEl = await page.$(resolvedAts.fieldMap.phone);
      if (phoneEl) await page.fill(resolvedAts.fieldMap.phone, applicant.phone);
    }

    const coverLetterEl = await page.$(resolvedAts.fieldMap.coverLetter);
    if (coverLetterEl && prepared.body) {
      await page.fill(resolvedAts.fieldMap.coverLetter, prepared.body);
    }

    await page.setInputFiles(resolvedAts.fieldMap.resumeUpload, prepared.resume_path);

    const clickedSubmit = await findAndClickControl(
      page,
      resolvedAts.fieldMap.submitButton,
      'Submit the completed job application form',
      fallback
    );
    if (!clickedSubmit) {
      return recordAndReturn(
        database,
        job_id,
        resolvedAts.platform,
        'manual_review',
        `submit button not found on page (selector: ${resolvedAts.fieldMap.submitButton})`
      );
    }

    // Don't trust the click alone — the same false-positive class of bug fixed in
    // linkedin.ts this session (a submit click can silently no-op with no thrown
    // error). Unlike that file's live-verified confirmation text, SELECTORS.submissionConfirmation
    // here is a best-effort heuristic (see its comment above) — but "unproven" is still safer
    // than "unchecked": if it can't be confirmed within the timeout, report manual_review
    // rather than a guessed 'submitted'.
    const confirmed = await page
      .locator(SELECTORS.submissionConfirmation)
      .first()
      .waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true)
      .catch(() => false);

    if (!confirmed) {
      return recordAndReturn(
        database,
        job_id,
        resolvedAts.platform,
        'manual_review',
        'clicked submit but could not confirm the application was actually recorded — verify manually'
      );
    }

    return recordAndReturn(database, job_id, resolvedAts.platform, 'submitted');
  } catch (err) {
    return recordAndReturn(
      database,
      job_id,
      ats?.platform ?? null,
      'failed',
      (err as Error).message ?? 'unknown error during external apply'
    );
  } finally {
    if (browser) await browser.close();
  }
}

