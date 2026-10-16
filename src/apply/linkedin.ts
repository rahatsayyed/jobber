import { chromium, type Page } from 'playwright';
import BetterSqlite3 from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getJob, getExcludedReason, getFirstHardStop, saveApplication } from '../db.js';
import { dbPath } from '../dbPath.js';
import { checkAndIncrement } from '../lib/rateLimit.js';
import { hostMatches } from '../lib/hostClass.js';
import { isDiscoverOnlySource } from '../lib/discoverOnly.js';
import { userDataPath } from '../lib/userData.js';
import { findPreparedResumePath } from '../applier/resume.js';
import {
  resolveControlWithFallback,
  resolveAnswerTopicWithFallback,
  type FallbackDeps,
  type KnownAnswerTopic,
} from '../lib/domFallback.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '../..');

// Burner-only session state. This MCP must NEVER load `secrets/linkedin-main-state.json`
// (that account is reserved for the `connect` MCP in Task 4). The path is intentionally
// hardcoded, not a configurable parameter.
const BURNER_STATE_PATH = path.join(projectRoot, 'secrets', 'linkedin-burner-state.json');
const ANSWERS_CONFIG_PATH = userDataPath('easy-apply-answers.json');

const DEFAULT_MAX_APPLIES_PER_DAY = 5;

const db = openDb(dbPath());

export interface EasyApplyAnswers {
  years_experience: number;
  authorized_to_work: boolean;
  requires_sponsorship: boolean;
  willing_to_relocate: boolean;
  notice_period_days: number;
  expected_salary: string;
  phone: string;
  linkedin_profile_url: string;
  // Free-form fallback for screening questions that don't fit the fixed fields above,
  // keyed by the exact question text as it appears on the posting (matched case- and
  // whitespace-insensitively — see resolveAnswer). Populated by the orchestrating agent
  // in response to a `needs_answer` result; see CLAUDE.md's "Applying (Phase 2)" section.
  custom?: Record<string, AnswerValue>;
}

export type AnswerValue = string | number | boolean;

/** Keyword/regex patterns matched (in order) against a screening question's text. */
const QUESTION_PATTERNS: Array<{ pattern: RegExp; key: keyof EasyApplyAnswers }> = [
  { pattern: /years?\b.{0,20}\bexperience/i, key: 'years_experience' },
  { pattern: /authoriz(e|ed|ation)\b.{0,25}\bwork/i, key: 'authorized_to_work' },
  { pattern: /sponsorship/i, key: 'requires_sponsorship' },
  { pattern: /relocat/i, key: 'willing_to_relocate' },
  { pattern: /notice period/i, key: 'notice_period_days' },
  { pattern: /salary/i, key: 'expected_salary' },
  // "expected CTC" is India-market phrasing for the same question as "expected salary".
  // Deliberately requires "expected" adjacent to "CTC" so a distinct question like
  // "current CTC" (which has no corresponding answer in the config) still falls through
  // to null/manual_review rather than being answered with the wrong figure.
  { pattern: /expected.{0,15}ctc/i, key: 'expected_salary' },
  { pattern: /phone/i, key: 'phone' },
  { pattern: /linkedin.{0,15}(profile|url)/i, key: 'linkedin_profile_url' },
];

function normalizeQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\*+$/, '').trim();
}

/**
 * Pure: matches a screening question's text against known patterns and returns the
 * corresponding value from the answers config, or null if the question is unrecognized.
 * Callers MUST treat a null return as "unanswerable" and abort (surfacing the question via
 * a `needs_answer` result) rather than guessing or submitting with a blank/default value.
 */
export function resolveAnswer(question: string, answers: EasyApplyAnswers): AnswerValue | null {
  for (const { pattern, key } of QUESTION_PATTERNS) {
    if (pattern.test(question)) {
      return (answers[key] as AnswerValue | undefined) ?? null;
    }
  }
  if (answers.custom) {
    const normalized = normalizeQuestion(question);
    for (const [key, value] of Object.entries(answers.custom)) {
      if (normalizeQuestion(key) === normalized) {
        return value;
      }
    }
  }
  return null;
}

function loadAnswers(): EasyApplyAnswers {
  return JSON.parse(readFileSync(ANSWERS_CONFIG_PATH, 'utf8'));
}

/** Human-readable descriptions of the fixed answer fields, for the Claude fallback prompt. */
const ANSWER_TOPIC_DESCRIPTIONS: Record<Exclude<keyof EasyApplyAnswers, 'custom'>, string> = {
  years_experience: "How many years of relevant work experience the candidate has",
  authorized_to_work: "Whether the candidate is authorized to work in the job's country without sponsorship",
  requires_sponsorship: 'Whether the candidate will require visa/work sponsorship',
  willing_to_relocate: 'Whether the candidate is willing to relocate for this role',
  notice_period_days: "The candidate's notice period, in days",
  expected_salary: "The candidate's expected salary or CTC",
  phone: "The candidate's phone number",
  linkedin_profile_url: "The candidate's LinkedIn profile URL",
};

function buildAnswerTopics(answers: EasyApplyAnswers): KnownAnswerTopic[] {
  const topics: KnownAnswerTopic[] = (
    Object.entries(ANSWER_TOPIC_DESCRIPTIONS) as [Exclude<keyof EasyApplyAnswers, 'custom'>, string][]
  ).map(([key, description]) => ({ key, description, value: answers[key] }));
  if (answers.custom) {
    for (const [key, value] of Object.entries(answers.custom)) {
      topics.push({
        key: `custom:${key}`,
        description: `A screening question the candidate already answered verbatim: ${JSON.stringify(key)}`,
        value,
      });
    }
  }
  return topics;
}

/**
 * Hybrid resolution: try the free, instant pattern/exact-match resolver first (the common
 * case). Only when that returns null AND the hybrid fallback is enabled for this call do we
 * pay for a bounded Claude classification to check whether the question is a rephrasing of
 * an answer topic the candidate already has a truthful value for (see domFallback.ts) —
 * never a fabricated new value.
 */
async function resolveAnswerHybrid(
  question: string,
  answers: EasyApplyAnswers,
  fallback: { enabled: boolean; deps?: FallbackDeps }
): Promise<AnswerValue | null> {
  const direct = resolveAnswer(question, answers);
  if (direct !== null || !fallback.enabled) return direct;
  return resolveAnswerTopicWithFallback(question, buildAnswerTopics(answers), fallback.deps);
}

/**
 * Clicks the element matched by `selector`. If nothing matches (a selector-rot case — the
 * common failure mode against LinkedIn's unstable DOM) and the hybrid fallback is enabled,
 * escalates to a bounded Claude call over the real, currently-visible button/link texts,
 * clicking only if Claude's choice is verbatim one of them. Returns whether a click happened.
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

export interface ApplyEasyApplyResult {
  job_id: string;
  status: 'submitted' | 'manual_review' | 'failed' | 'rate_limited' | 'needs_answer';
  reason?: string;
  // Set only when status is 'needs_answer': the exact screening-question text, verbatim
  // from the posting, for the caller to answer and add to
  // `user-data/easy-apply-answers.json`'s `custom` map (see CLAUDE.md).
  question?: string;
}

// Moved to src/applier/resume.ts (plan 8G-2 task 18); re-exported here until this file is deleted in task 23.
export { findPreparedResumePath };

/**
 * Given a truthful answer that a numeric-only field just rejected as "Invalid input", returns
 * an ordered list of reformatted candidates to retry — never a different figure, only the same
 * truthful value expressed in a way the field might accept:
 * 1. Strip everything but digits and a decimal point (handles a unit suffix like "25 LPA").
 * 2. If that's still a decimal, also offer it rounded up to the next whole number (ceiling) —
 *    some fields only accept whole numbers (observed live: "years of experience with X"
 *    rejecting "3.5").
 * Returns an empty array when the answer has no numeric content at all (e.g. "None") — there is
 * nothing safe to reformat it into, the caller must fall through to its existing handling.
 */
export function computeNumericFallbackCandidates(answer: string): string[] {
  const stripped = answer.replace(/[^0-9.]/g, '');
  if (!stripped) return [];
  const candidates = [stripped];
  if (stripped.includes('.')) {
    const asNumber = Number(stripped);
    if (!Number.isNaN(asNumber)) {
      candidates.push(String(Math.ceil(asNumber)));
    }
  }
  return candidates;
}

/**
 * Distinguishes "the form is genuinely on a final step with no working submit control" from
 * "the form never advanced past an earlier step because a field's truthful answer failed
 * LinkedIn's client-side validation" (observed live: a numeric-only field like "years of
 * experience with X" silently rejects a non-numeric truthful answer such as "None", the
 * existing invalid-input recovery only handles values with a leading digit to strip down to,
 * and the surrounding Next/Review-click loop has no way to tell these two situations apart —
 * it just exhausts MAX_FORM_STEPS and reports the generic, misleading "submit button not found
 * on final step" either way). Returns a specific reason naming the stuck question(s) when any
 * are invalid, or `null` when none are (a genuine missing-submit-control case).
 */
export function describeStuckValidationErrors(
  entries: Array<{ questionText: string; isInvalid: boolean }>
): string | null {
  const invalidQuestions = entries.filter((e) => e.isInvalid).map((e) => e.questionText);
  if (invalidQuestions.length === 0) return null;
  return `form did not advance — validation error(s) on: ${invalidQuestions.join(', ')}`;
}

function recordAndReturn(
  database: BetterSqlite3.Database,
  jobId: string,
  status: 'submitted' | 'manual_review' | 'failed' | 'needs_answer',
  reason?: string,
  question?: string
): ApplyEasyApplyResult {
  saveApplication(database, {
    job_id: jobId,
    platform: 'linkedin',
    method: 'easy_apply',
    account: 'burner',
    status,
    reason: reason ?? null,
    applied_at: status === 'submitted' ? new Date().toISOString() : null,
  });
  return { job_id: jobId, status, reason, question };
}

// Best-effort LinkedIn Easy Apply DOM selectors. LinkedIn's markup changes and isn't
// publicly stable the way Greenhouse/Lever/Workday/Ashby's is.
//
// nextButton/reviewButton/submitButton were live-tested against a real Easy Apply
// modal (see .superpowers/sdd/task-6-selector-fix-report.md) and confirmed to render
// with fully obfuscated/hashed CSS classes, NO aria-label, NO role="dialog", and NO
// data-test-* attributes anywhere in the ancestor chain. The one stable anchor found
// was a semantic `<footer>` tag a few levels up (the modal's action-button row), with
// the button's visible text content ("Next" confirmed live; "Review"/"Submit" are
// reasonable-copy guesses per LinkedIn's known step labels, not live-verified). These
// selectors use Playwright's `:has-text()` (case-insensitive substring match) scoped
// to `footer` so they tolerate minor copy variations (e.g. "Submit application" vs
// "Submit") without accidentally matching unrelated buttons elsewhere on the page.
export const SELECTORS = {
  easyApplyButton: 'button.jobs-apply-button, button[aria-label*="Easy Apply" i]',
  formGrouping: '.jobs-easy-apply-form-section__grouping, .fb-dash-form-element',
  questionLabel: 'label',
  textInput: 'input[type="text"], input[type="number"], input[type="tel"], textarea',
  nextButton: 'footer button:has-text("Next")',
  reviewButton: 'footer button:has-text("Review")',
  submitButton: 'footer button:has-text("Submit")',
  resumeUpload: 'input[type="file"]',
  // Newer multi-page apply flow ("Contact info" step): a standalone phone-number
  // input outside any `.jobs-easy-apply-form-section__grouping`/`.fb-dash-form-element`
  // container, so the question-grouping loop above never sees or fills it. Live-verified
  // 2026-07-15 against a real posting (`docs/phase2-known-issues.md`).
  phoneInput: 'input[type="tel"]',
  // Same newer flow's "Resume" step: no `<input type="file">` exists in the DOM until
  // this button is clicked, which opens a native OS file-chooser dialog rather than
  // revealing a hidden input. Live-verified 2026-07-15.
  resumeUploadButton: 'button:has-text("Upload resume")',
  // Same newer flow's "Additional Questions" step: standalone text questions carry the
  // question text verbatim in `aria-label` (not inside formGrouping/label at all), so
  // this is a direct, reliable match rather than needing a wrapping container.
  ariaLabeledTextInput: 'input[aria-label]:not([type="file"]):not([type="tel"])',
  // Yes/No screening questions render as an ARIA radiogroup, with the question text in
  // a `<p>` immediately preceding the fieldset, and each option's own visible text
  // ("Yes"/"No") inside its `[role="radio"]` container.
  radioGroup: 'fieldset[role="radiogroup"]',
  radioOption: '[role="radio"]',
  // Live-verified 2026-07-15: a submit click can silently no-op (LinkedIn swallowed the
  // click with no error and no application was actually recorded on a real attempt). The
  // underlying job page shows this text once a submission has genuinely gone through, so
  // it's used as a positive confirmation rather than trusting the click alone.
  submissionConfirmation: 'text=Application submitted',
} as const;

const MAX_FORM_STEPS = 10;

// How long to wait for the Easy Apply modal (or its next form step) to actually render
// before checking for controls. Bounded and non-throwing: `Locator.click()` only
// auto-waits for the clicked element itself to be actionable, not for whatever the click
// triggers afterward (e.g. a modal animating in), and `Locator.count()` is a synchronous
// snapshot with no retry — so without this wait, the very next `.count()` checks race the
// modal's render and can see 0 elements that appear a moment later. Confirmed live: the
// real modal's "Next" button (inside a `<footer>`) rendered ~2.5s after the Easy Apply
// click (see .superpowers/sdd/task-6-timing-fix-report.md). We wait for ANY of the
// controls a healthy render could produce next (a form grouping, or a next/review/submit
// button) rather than a fixed sleep, so the wait ends as soon as the DOM is actually
// ready instead of always burning the full timeout. If nothing appears in time, we
// swallow the timeout and fall through to the existing `.count()` checks, which then
// correctly resolve to the existing manual_review fallbacks.
const MODAL_RENDER_TIMEOUT_MS = 8000;

async function waitForFormControls(page: Pick<Page, 'locator'>): Promise<void> {
  const anySelector = [
    SELECTORS.formGrouping,
    SELECTORS.nextButton,
    SELECTORS.reviewButton,
    SELECTORS.submitButton,
  ].join(', ');
  await page
    .locator(anySelector)
    .first()
    .waitFor({ state: 'visible', timeout: MODAL_RENDER_TIMEOUT_MS })
    .catch(() => {
      // Timed out waiting for the modal/next-step to render. Don't throw — let the
      // caller's existing `.count()` checks run and take the normal manual_review path.
    });
}

export interface ApplyEasyApplyDeps {
  db?: BetterSqlite3.Database;
  maxAppliesPerDay?: number;
  /** Injectable Playwright `chromium` launcher, for testing without a real browser. */
  chromium?: { launch: typeof chromium.launch };
  /**
   * Hybrid Claude fallback for selector-miss/unanswerable-question escalation (see
   * domFallback.ts). Off by default unless explicitly enabled here or via
   * `EASY_APPLY_HYBRID_FALLBACK=true` — this keeps the fast/free selector path as the only
   * thing that runs unless hybrid mode is deliberately turned on, and keeps tests hermetic
   * (no real API calls) unless a test explicitly injects a fallback client.
   */
  fallback?: FallbackDeps;
  fallbackEnabled?: boolean;
  /** Burner session state file; defaults to the secrets path. Injectable for hermetic tests. */
  burnerStatePath?: string;
}

export async function applyEasyApply(
  { job_id }: { job_id: string },
  deps: ApplyEasyApplyDeps = {}
): Promise<ApplyEasyApplyResult> {
  const database = deps.db ?? db;
  const browserLauncher = deps.chromium ?? chromium;
  const maxPerDay =
    deps.maxAppliesPerDay ?? Number(process.env.MAX_APPLIES_PER_DAY ?? DEFAULT_MAX_APPLIES_PER_DAY);
  const fallback = {
    enabled: deps.fallbackEnabled ?? (Boolean(deps.fallback) || process.env.EASY_APPLY_HYBRID_FALLBACK === 'true'),
    deps: deps.fallback,
  };

  // Cheap, pure, non-browser pre-flight checks run BEFORE the rate-limit gate below, so a
  // pre-flight rejection (missing job, bad answers config, missing burner session) never
  // burns a quota slot for a no-op that was never going to touch Playwright.
  const job = getJob(database, job_id);
  if (!job || !job.url) {
    return recordAndReturn(database, job_id, 'manual_review', 'job not found or missing url');
  }
  // Discover-only sources never get an apply attempt, even when their url happens to be a linkedin.com one:
  // refused before the host check, the veto lookup, the session, the browser and the daily counter.
  if (isDiscoverOnlySource(job.source)) {
    return recordAndReturn(database, job_id, 'manual_review', `source "${job.source}" is discover-only: apply is not supported for it (email and connect outreach still run)`);
  }
  const vetoReason = getExcludedReason(database, job_id);
  if (vetoReason) {
    return recordAndReturn(database, job_id, 'manual_review', `excluded by veto: ${vetoReason}`);
  }
  const hardStop = getFirstHardStop(database, job_id);
  if (hardStop) {
    return recordAndReturn(database, job_id, 'manual_review', `hard stop: ${hardStop}`);
  }

  // The page is opened with the burner session at job.url: only a linkedin.com URL may receive it.
  if (!hostMatches(job.url, 'linkedin.com')) {
    return recordAndReturn(database, job_id, 'manual_review', 'job url is not a linkedin.com host; refusing to use the burner session');
  }

  let answers: EasyApplyAnswers;
  try {
    answers = loadAnswers();
  } catch (err) {
    return recordAndReturn(
      database,
      job_id,
      'manual_review',
      `failed to load answers config: ${(err as Error).message}`
    );
  }

  if (!existsSync(deps.burnerStatePath ?? BURNER_STATE_PATH)) {
    return recordAndReturn(database, job_id, 'manual_review', 'burner session state not found');
  }

  // Gate immediately before the Playwright launch — still strictly "before any Playwright
  // action", just moved as late as possible so the cheap checks above get first refusal.
  const allowed = checkAndIncrement(database, 'easy_apply', maxPerDay);
  if (!allowed) {
    return {
      job_id,
      status: 'rate_limited',
      reason: `daily Easy Apply limit (${maxPerDay}) reached`,
    };
  }

  let browser;
  try {
    browser = await browserLauncher.launch({ headless: true });
    const context = await browser.newContext({ storageState: deps.burnerStatePath ?? BURNER_STATE_PATH });
    const page = await context.newPage();
    await page.goto(job.url, { timeout: 30000, waitUntil: 'domcontentloaded' });

    // Locators (not ElementHandles) are used throughout: a Locator re-resolves its
    // selector at the moment of each action, so it survives the re-renders/animations
    // of LinkedIn's Easy Apply modal. An ElementHandle instead pins to one DOM node
    // captured at query time, which can detach before a later `.click()`/`.fill()`
    // fires — causing "Element is not attached to the DOM" failures.
    const clickedEasyApply = await findAndClickControl(
      page,
      SELECTORS.easyApplyButton,
      'Start the job application (an "Easy Apply" button)',
      fallback
    );
    if (!clickedEasyApply) {
      return recordAndReturn(
        database,
        job_id,
        'manual_review',
        'Easy Apply button not found (posting may not support Easy Apply)'
      );
    }
    await waitForFormControls(page);

    const resumePath = findPreparedResumePath(database, job_id);

    for (let step = 0; step < MAX_FORM_STEPS; step++) {
      // Newer "Contact info" step: fill the standalone phone input directly, since it
      // falls outside formGrouping and is invisible to the question-label loop below.
      const phoneInputLocator = page.locator(SELECTORS.phoneInput);
      if ((await phoneInputLocator.count()) > 0) {
        const currentPhoneValue = await phoneInputLocator.first().inputValue();
        if (!currentPhoneValue) {
          await phoneInputLocator.first().fill(String(answers.phone));
        }
      }

      // Newer "Resume" step: clicking this button opens a native file-chooser dialog
      // (no pre-existing `<input type="file">` to target with `setInputFiles`), so it
      // must be handled with `page.waitForEvent('filechooser')` at click time.
      const resumeUploadButtonLocator = page.locator(SELECTORS.resumeUploadButton);
      if ((await resumeUploadButtonLocator.count()) > 0) {
        if (!resumePath) {
          return recordAndReturn(
            database,
            job_id,
            'manual_review',
            'resume upload required but no prepared resume found for this job'
          );
        }
        const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null);
        await resumeUploadButtonLocator.first().click();
        const chooser = await fileChooserPromise;
        if (chooser) {
          await chooser.setFiles(resumePath);
          // Upload is asynchronous (a visible "Uploading" indicator appears, then an
          // "Upload resume" button re-renders while it's in flight). Clicking Next before
          // this resolves either no-ops against a disabled button or, worse, re-triggers
          // a second upload on the next loop iteration because the button reappeared.
          // Wait for the indicator to clear rather than guessing at a fixed delay.
          await page
            .getByText('Uploading', { exact: true })
            .first()
            .waitFor({ state: 'hidden', timeout: 15000 })
            .catch(() => {});
        }
      }

      const groupingLocator = page.locator(SELECTORS.formGrouping);
      const groupingCount = await groupingLocator.count();
      for (let i = 0; i < groupingCount; i++) {
        const grouping = groupingLocator.nth(i);
        const labelLocator = grouping.locator(SELECTORS.questionLabel);
        const questionText =
          (await labelLocator.count()) > 0 ? ((await labelLocator.first().textContent()) ?? '').trim() : '';
        if (!questionText) continue;

        const answer = await resolveAnswerHybrid(questionText, answers, fallback);
        if (answer === null) {
          // Real, verifiable early-return before any submit action: an unrecognized
          // screening question means we cannot answer truthfully, so abort here and
          // surface the question to the caller rather than guessing or clicking further.
          return recordAndReturn(
            database,
            job_id,
            'needs_answer',
            `unanswerable screening question: "${questionText}"`,
            questionText
          );
        }

        const inputLocator = grouping.locator(SELECTORS.textInput);
        if ((await inputLocator.count()) > 0) {
          await inputLocator.first().fill(String(answer));
        }
      }

      // Newer "Additional Questions" step: standalone text inputs outside any
      // formGrouping container, carrying the question verbatim in `aria-label`.
      const ariaLabeledInputLocator = page.locator(SELECTORS.ariaLabeledTextInput);
      const ariaLabeledInputCount = await ariaLabeledInputLocator.count();
      for (let i = 0; i < ariaLabeledInputCount; i++) {
        const input = ariaLabeledInputLocator.nth(i);
        const questionText = (await input.getAttribute('aria-label')) ?? '';
        if (!questionText) continue;
        const currentValue = await input.inputValue();
        if (currentValue) continue;

        const answer = await resolveAnswerHybrid(questionText, answers, fallback);
        if (answer === null) {
          return recordAndReturn(
            database,
            job_id,
            'needs_answer',
            `unanswerable screening question: "${questionText}"`,
            questionText
          );
        }
        await input.fill(String(answer));

        // Some numeric-style fields (observed on CTC/salary and "years of experience with X"
        // questions) silently reject a unit-suffixed or decimal value ("25 LPA", "3.5") with an
        // inline "Invalid input" error — but that validation only renders on blur, not
        // immediately after `.fill()`. Blur first, then retry through each reformatted
        // candidate in order (strip to digits/dot, then floor to a whole number) until one is
        // accepted or the candidates are exhausted; see computeNumericFallbackCandidates for
        // why this never invents a different figure, only reformats the truthful one.
        await input.blur();
        let isInvalid = await input.evaluate((el) => {
          const wrapper = el.parentElement?.parentElement;
          return wrapper ? /invalid input/i.test(wrapper.textContent ?? '') : false;
        });
        if (isInvalid) {
          for (const candidate of computeNumericFallbackCandidates(String(answer))) {
            await input.fill(candidate);
            await input.blur();
            isInvalid = await input.evaluate((el) => {
              const wrapper = el.parentElement?.parentElement;
              return wrapper ? /invalid input/i.test(wrapper.textContent ?? '') : false;
            });
            if (!isInvalid) break;
          }
        }
      }

      // Same step: Yes/No screening questions rendered as an ARIA radiogroup. The
      // question text lives in the `<p>` immediately preceding the fieldset, not inside
      // it, so it must be read from the parent rather than the fieldset's own subtree.
      const radioGroupLocator = page.locator(SELECTORS.radioGroup);
      const radioGroupCount = await radioGroupLocator.count();
      for (let i = 0; i < radioGroupCount; i++) {
        const radioGroup = radioGroupLocator.nth(i);
        const alreadyAnswered = await radioGroup
          .locator(SELECTORS.radioOption)
          .evaluateAll((els) => els.some((el) => el.getAttribute('aria-checked') === 'true'));
        if (alreadyAnswered) continue;

        const questionText = (
          await radioGroup.evaluate((el) => el.previousElementSibling?.textContent ?? '')
        ).trim();
        if (!questionText) continue;

        const answer = await resolveAnswerHybrid(questionText, answers, fallback);
        if (typeof answer !== 'boolean') {
          // Either genuinely unanswerable (null) or answered by a non-boolean config
          // value that can't be mapped to a Yes/No choice — both are unsafe to guess.
          return recordAndReturn(
            database,
            job_id,
            'needs_answer',
            `unanswerable screening question: "${questionText}"`,
            questionText
          );
        }
        const targetText = answer ? 'Yes' : 'No';
        const optionLocator = radioGroup.locator(SELECTORS.radioOption).filter({ hasText: targetText });
        if ((await optionLocator.count()) > 0) {
          await optionLocator.first().click();
        }
      }

      const submitButtonLocator = page.locator(SELECTORS.submitButton);
      if ((await submitButtonLocator.count()) > 0) break;

      const nextButtonLocator = page.locator(SELECTORS.nextButton);
      const nextButtonCount = await nextButtonLocator.count();
      const reviewButtonLocator = page.locator(SELECTORS.reviewButton);
      const reviewButtonCount = nextButtonCount > 0 ? 0 : await reviewButtonLocator.count();
      if (nextButtonCount === 0 && reviewButtonCount === 0) {
        const clickedFallbackNav = await findAndClickControl(
          page,
          `${SELECTORS.nextButton}, ${SELECTORS.reviewButton}`,
          'Advance to the next step of the Easy Apply form (a "Next", "Continue", or "Review" button)',
          fallback
        );
        if (!clickedFallbackNav) {
          return recordAndReturn(
            database,
            job_id,
            'manual_review',
            'could not find a next/review/submit control on the Easy Apply form'
          );
        }
        await waitForFormControls(page);
        continue;
      }
      if (nextButtonCount > 0) {
        await nextButtonLocator.first().click();
      } else {
        await reviewButtonLocator.first().click();
      }
      await waitForFormControls(page);
    }

    // Fallback for the older single-page flow, where a plain `<input type="file">` is
    // already present in the DOM (as opposed to the newer flow's click-to-open-chooser
    // button, handled per-step in the loop above).
    const resumeUploadCount = await page.locator(SELECTORS.resumeUpload).count();
    if (resumeUploadCount > 0 && resumePath) {
      await page.setInputFiles(SELECTORS.resumeUpload, resumePath);
    }

    const clickedFinalSubmit = await findAndClickControl(
      page,
      SELECTORS.submitButton,
      'Submit the completed Easy Apply application (a "Submit application" button)',
      fallback
    );
    if (!clickedFinalSubmit) {
      const ariaLabeledInputs = page.locator(SELECTORS.ariaLabeledTextInput);
      const inputCount = await ariaLabeledInputs.count();
      const invalidEntries: Array<{ questionText: string; isInvalid: boolean }> = [];
      for (let i = 0; i < inputCount; i++) {
        const input = ariaLabeledInputs.nth(i);
        const questionText = (await input.getAttribute('aria-label')) ?? '';
        if (!questionText) continue;
        const isInvalid = await input.evaluate((el) => {
          const wrapper = el.parentElement?.parentElement;
          return wrapper ? /invalid input/i.test(wrapper.textContent ?? '') : false;
        });
        invalidEntries.push({ questionText, isInvalid });
      }
      const stuckReason = describeStuckValidationErrors(invalidEntries);
      return recordAndReturn(
        database,
        job_id,
        'manual_review',
        stuckReason ?? 'submit button not found on final step'
      );
    }

    // Don't trust the click alone — confirm the application actually went through
    // before reporting success (see SELECTORS.submissionConfirmation).
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
        'manual_review',
        'clicked submit but could not confirm the application was actually recorded — verify manually on LinkedIn'
      );
    }

    return recordAndReturn(database, job_id, 'submitted');
  } catch (err) {
    return recordAndReturn(database, job_id, 'failed', (err as Error).message ?? 'unknown error during easy apply');
  } finally {
    if (browser) await browser.close();
  }
}

