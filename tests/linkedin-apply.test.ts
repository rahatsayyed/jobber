import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTempSession } from './helpers/tempSession.js';
import { resolveAnswer, applyEasyApply as realApplyEasyApply, type ApplyEasyApplyDeps, findPreparedResumePath, describeStuckValidationErrors, computeNumericFallbackCandidates, SELECTORS, type EasyApplyAnswers } from '../src/apply/linkedin.js';
import { openDb, saveJob, enqueueOutreach, saveOutreach } from '../src/db.js';
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';

// Hermetic: Easy Apply gets a temp burner session file, never the real secrets one.
let session = makeTempSession();
beforeEach(() => {
  session = makeTempSession();
});
afterEach(() => session.cleanup());
const applyEasyApply: typeof realApplyEasyApply = (a, d: ApplyEasyApplyDeps = {}) =>
  realApplyEasyApply(a, { burnerStatePath: session.path, ...d });

const answers: EasyApplyAnswers = {
  years_experience: 5,
  authorized_to_work: true,
  requires_sponsorship: false,
  willing_to_relocate: true,
  notice_period_days: 30,
  expected_salary: '25 LPA',
  phone: '+91-9999999999',
  linkedin_profile_url: 'https://linkedin.com/in/example',
};

describe('resolveAnswer unset and falsy values', () => {
  it('an UNSET fixed answer key resolves to null, not undefined', () => {
    const r = resolveAnswer('What is your notice period?', {} as EasyApplyAnswers);
    expect(r).toBeNull();
  });

  it('preserves empty string, 0 and false', () => {
    const a = { notice_period_days: 0, expected_salary: '', willing_to_relocate: false } as unknown as EasyApplyAnswers;
    expect(resolveAnswer('What is your notice period?', a)).toBe(0);
    expect(resolveAnswer('Expected salary?', a)).toBe('');
    expect(resolveAnswer('Are you willing to relocate?', a)).toBe(false);
  });
});

describe('resolveAnswer', () => {
  it('matches "years of experience" style questions', () => {
    expect(resolveAnswer('How many years of experience do you have with React?', answers)).toBe(5);
    expect(resolveAnswer('Years of experience', answers)).toBe(5);
  });

  it('matches "authorized to work" style questions', () => {
    expect(resolveAnswer('Are you legally authorized to work in this country?', answers)).toBe(true);
  });

  it('matches sponsorship questions', () => {
    expect(
      resolveAnswer('Will you now or in the future require sponsorship for employment visa status?', answers)
    ).toBe(false);
  });

  it('matches relocation questions', () => {
    expect(resolveAnswer('Are you willing to relocate for this role?', answers)).toBe(true);
  });

  it('matches notice period questions', () => {
    expect(resolveAnswer('What is your current notice period (in days)?', answers)).toBe(30);
  });

  it('matches expected salary questions', () => {
    expect(resolveAnswer('What are your salary expectations?', answers)).toBe('25 LPA');
  });

  it('matches phone questions', () => {
    expect(resolveAnswer('Mobile phone number', answers)).toBe('+91-9999999999');
  });

  it('matches LinkedIn profile URL questions', () => {
    expect(resolveAnswer('Please share your LinkedIn profile URL', answers)).toBe(
      'https://linkedin.com/in/example'
    );
  });

  it('matches "expected CTC" but not "current CTC" (no config value for the latter)', () => {
    expect(resolveAnswer('What is your expected CTC?', answers)).toBe('25 LPA');
    expect(resolveAnswer('What is your current CTC?', answers)).toBeNull();
  });

  it('returns null for unrecognized questions', () => {
    expect(resolveAnswer('What is your favorite color?', answers)).toBeNull();
    expect(resolveAnswer('Describe a time you overcame a challenge at work.', answers)).toBeNull();
  });

  it('falls back to the custom map for questions not covered by the fixed fields', () => {
    const withCustom: EasyApplyAnswers = {
      ...answers,
      custom: { 'What is your current CTC?': '18 LPA' },
    };
    expect(resolveAnswer('What is your current CTC?', withCustom)).toBe('18 LPA');
    // Match is case- and whitespace-insensitive, and tolerates a trailing '*' (as
    // rendered on the posting for required fields) that isn't part of the stored key.
    expect(resolveAnswer('what is your current ctc?*', withCustom)).toBe('18 LPA');
    expect(resolveAnswer('Some other unrelated question?', withCustom)).toBeNull();
  });
});

/**
 * A minimal fake Playwright element: `click`/`fill` are spies so tests can assert
 * whether a submit/click action was ever attempted.
 */
function makeFakeElement(overrides: Partial<{ textContent: () => Promise<string | null> }> = {}) {
  return {
    click: vi.fn().mockResolvedValue(undefined),
    fill: vi.fn().mockResolvedValue(undefined),
    textContent: overrides.textContent ?? vi.fn().mockResolvedValue(null),
  };
}

/**
 * A minimal fake Playwright `Locator`: wraps zero-or-one fake element(s) and exposes
 * the subset of the Locator API the implementation uses (`count`, `first`, `nth`,
 * `click`, `fill`, `textContent`, `locator`). `first()`/`nth()` return the same
 * locator object since these fakes only ever represent a single logical match.
 */
function makeFakeLocator(el: ReturnType<typeof makeFakeElement> | null): any {
  const locator: any = {
    count: vi.fn().mockResolvedValue(el ? 1 : 0),
    click: vi.fn(async () => {
      if (!el) throw new Error('no element matched by locator');
      return el.click();
    }),
    fill: vi.fn(async (value: string) => {
      if (!el) throw new Error('no element matched by locator');
      return el.fill(value);
    }),
    textContent: vi.fn(async () => (el ? el.textContent() : null)),
    locator: vi.fn(() => makeFakeLocator(null)),
    waitFor: vi.fn().mockResolvedValue(undefined),
  };
  locator.first = vi.fn(() => locator);
  locator.nth = vi.fn(() => locator);
  return locator;
}

/**
 * A fake "form grouping" locator: represents one `.nth(i)` result of the groupings
 * locator, and itself exposes `.locator(selector)` for the nested question-label /
 * text-input lookups within that grouping.
 */
function makeFakeGroupingLocator({
  label = null,
  input = null,
}: {
  label?: ReturnType<typeof makeFakeElement> | null;
  input?: ReturnType<typeof makeFakeElement> | null;
} = {}) {
  return {
    locator: vi.fn((selector: string) => {
      if (selector === 'label') return makeFakeLocator(label);
      return makeFakeLocator(input);
    }),
  };
}

/**
 * A fake locator representing multiple matches (e.g. `page.locator(formGrouping)`),
 * backed by an array of grouping-locator-like objects (see above).
 */
function makeFakeGroupingsLocator(groupings: ReturnType<typeof makeFakeGroupingLocator>[]) {
  return {
    count: vi.fn().mockResolvedValue(groupings.length),
    first: vi.fn(() => ({ ...groupings[0], waitFor: vi.fn().mockResolvedValue(undefined) })),
    nth: vi.fn((i: number) => groupings[i]),
  };
}

describe('computeNumericFallbackCandidates', () => {
  it('strips a unit suffix like "LPA" to a plain integer', () => {
    expect(computeNumericFallbackCandidates('25 LPA')).toEqual(['25']);
  });

  it('offers the ceiling (rounded-up) integer as a second candidate for a decimal value', () => {
    expect(computeNumericFallbackCandidates('3.5')).toEqual(['3.5', '4']);
  });

  it('returns an empty list for a fully non-numeric truthful answer (e.g. "None")', () => {
    expect(computeNumericFallbackCandidates('None')).toEqual([]);
  });

  it('does not add a ceiling duplicate for an already-whole number', () => {
    expect(computeNumericFallbackCandidates('45')).toEqual(['45']);
  });

  it('handles a decimal with no leading digit before the dot gracefully', () => {
    expect(computeNumericFallbackCandidates('.5')).toEqual(['.5', '1']);
  });
});

describe('describeStuckValidationErrors', () => {
  it('returns null when no fields are invalid (a genuinely missing submit button)', () => {
    const reason = describeStuckValidationErrors([
      { questionText: 'What is your Total Years of experience?', isInvalid: false },
      { questionText: 'What is your Notice Period?', isInvalid: false },
    ]);
    expect(reason).toBeNull();
  });

  it('names the stuck question(s) when one field is invalid', () => {
    const reason = describeStuckValidationErrors([
      { questionText: 'What is your Total Years of experience?', isInvalid: false },
      { questionText: 'What is your experience with Golang', isInvalid: true },
    ]);
    expect(reason).toBe(
      'form did not advance — validation error(s) on: What is your experience with Golang'
    );
  });

  it('names every stuck question when multiple fields are invalid', () => {
    const reason = describeStuckValidationErrors([
      { questionText: 'What is your Current CTC?', isInvalid: true },
      { questionText: 'What is your Expected CTC?', isInvalid: true },
    ]);
    expect(reason).toBe(
      'form did not advance — validation error(s) on: What is your Current CTC?, What is your Expected CTC?'
    );
  });

  it('returns null for an empty entry list', () => {
    expect(describeStuckValidationErrors([])).toBeNull();
  });
});

describe('SELECTORS next/review/submit buttons', () => {
  // These are pure string assertions on the selector VALUES, not proof the selector
  // actually resolves on a real LinkedIn page (that can only be verified live — see
  // .superpowers/sdd/task-6-selector-fix-report.md). What we CAN assert statically:
  // no dependence on aria-label/hashed classes anymore, and every selector is scoped
  // to the `footer` ancestor so it can't accidentally match an unrelated page button.
  it('scopes next/review/submit selectors to a footer ancestor with text-based matching', () => {
    expect(SELECTORS.nextButton).toMatch(/^footer /);
    expect(SELECTORS.reviewButton).toMatch(/^footer /);
    expect(SELECTORS.submitButton).toMatch(/^footer /);

    expect(SELECTORS.nextButton).toContain(':has-text("Next")');
    expect(SELECTORS.reviewButton).toContain(':has-text("Review")');
    expect(SELECTORS.submitButton).toContain(':has-text("Submit")');
  });

  it('no longer relies on aria-label attributes for next/review/submit', () => {
    expect(SELECTORS.nextButton).not.toContain('aria-label');
    expect(SELECTORS.reviewButton).not.toContain('aria-label');
    expect(SELECTORS.submitButton).not.toContain('aria-label');
  });
});

describe('applyEasyApply control flow', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('returns rate_limited and never touches Playwright when the daily limit is already reached', async () => {
    const launch = vi.fn();
    const fakeChromium = { launch };

    saveJob(db, {
      id: 'job-rl-1',
      source: 'linkedin',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://linkedin.com/jobs/view/1',
      apply_url: 'https://linkedin.com/jobs/view/1',
      description: 'React role',
    });

    const result = await applyEasyApply(
      { job_id: 'job-rl-1' },
      { db, maxAppliesPerDay: 0, chromium: fakeChromium }
    );

    expect(result.status).toBe('rate_limited');
    // The rate-limit gate must be checked BEFORE any Playwright action — launch()
    // should never be invoked once the limit is already exhausted.
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses a non-linkedin job url before any browser, session or counter use', async () => {
    const launch = vi.fn();
    for (const [i, url] of ['https://evillinkedin.com/jobs/view/1', 'https://linkedin.com.evil.net/x', 'https://www.linkedin.com@evil.net/x', 'javascript:alert(1)'].entries()) {
      saveJob(db, { id: `job-nl-${i}`, source: 'linkedin', title: 'T', company: 'C', url, apply_url: url, description: 'd' });
      const result = await applyEasyApply({ job_id: `job-nl-${i}` }, { db, chromium: { launch } });
      expect(result.status).toBe('manual_review');
      expect(result.reason).toContain('not a linkedin.com host');
    }
    expect(launch).not.toHaveBeenCalled();
    const row = db.prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?").get('easy_apply');
    expect(row).toBeUndefined();
  });

  it('does not burn a quota slot on a cheap pre-flight rejection (Finding 2: job not found)', async () => {
    const launch = vi.fn();
    const fakeChromium = { launch };

    const result = await applyEasyApply(
      { job_id: 'job-does-not-exist' },
      { db, chromium: fakeChromium }
    );

    expect(result.status).toBe('manual_review');
    expect(launch).not.toHaveBeenCalled();

    const row = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?")
      .get('easy_apply') as { count: number } | undefined;
    expect(row).toBeUndefined();
  });

  it('returns needs_answer and never clicks submit when a screening question is unanswerable', async () => {
    saveJob(db, {
      id: 'job-mr-1',
      source: 'linkedin',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://linkedin.com/jobs/view/2',
      apply_url: 'https://linkedin.com/jobs/view/2',
      description: 'React role',
    });

    const easyApplyButton = makeFakeElement();
    const submitButton = makeFakeElement();
    const nextButton = makeFakeElement();

    const unrecognizedLabel = makeFakeElement({
      textContent: vi.fn().mockResolvedValue('What is your favorite color?'),
    });
    const grouping = makeFakeGroupingLocator({ label: unrecognizedLabel });

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector.includes('Easy Apply')) return makeFakeLocator(easyApplyButton);
        if (selector.includes('Submit')) return makeFakeLocator(submitButton);
        if (selector.includes('Next')) return makeFakeLocator(nextButton);
        if (selector.includes('jobs-easy-apply-form-section__grouping')) return makeFakeGroupingsLocator([grouping]);
        return makeFakeLocator(null);
      }),
      setInputFiles: vi.fn().mockResolvedValue(undefined),
    };

    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const launch = vi.fn().mockResolvedValue(browser);
    const fakeChromium = { launch };

    const result = await applyEasyApply(
      { job_id: 'job-mr-1' },
      { db, chromium: fakeChromium }
    );

    expect(result.status).toBe('needs_answer');
    expect(result.reason).toMatch(/unanswerable screening question/);
    expect(result.question).toBe('What is your favorite color?');
    // The easy-apply button click is expected (it happens before the screening
    // questions are read), but the submit button must never be clicked once an
    // unanswerable question forces an early return.
    expect(easyApplyButton.click).toHaveBeenCalledTimes(1);
    expect(submitButton.click).not.toHaveBeenCalled();
    expect(nextButton.click).not.toHaveBeenCalled();
  });

  it('falls through to the normal manual_review path when waitForFormControls times out after the Easy Apply click', async () => {
    // Regression test for the `.catch(() => {})` in `waitForFormControls` (src/apply/linkedin.ts).
    // That helper wraps a bounded `locator.waitFor(...)` in a swallowing catch so a timeout
    // falls through to the existing `.count()`-based manual_review fallbacks instead of
    // throwing. Every other test's fake `waitFor` resolves instantly, so none of them
    // actually exercise the rejection branch. This test forces `waitFor` to reject at the
    // FIRST call site (immediately after the Easy Apply button click) and asserts the run
    // still completes with `manual_review` (not `failed`, and not an uncaught throw).
    saveJob(db, {
      id: 'job-mr-timeout-1',
      source: 'linkedin',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://linkedin.com/jobs/view/3',
      apply_url: 'https://linkedin.com/jobs/view/3',
      description: 'React role',
    });

    const easyApplyButton = makeFakeElement();

    // No form groupings render at all (empty groupings locator) — combined with no
    // next/review/submit control found, this exercises the pre-existing
    // "could not find a next/review/submit control" manual_review fallback, proving
    // the timed-out waitFor() did not derail the rest of the flow.
    const emptyGroupingsLocator = {
      count: vi.fn().mockResolvedValue(0),
      first: vi.fn(() => ({ waitFor: vi.fn().mockResolvedValue(undefined) })),
      nth: vi.fn(() => makeFakeGroupingLocator()),
    };

    // waitForFormControls builds one joined selector string containing all four
    // candidate selectors (formGrouping, nextButton, reviewButton, submitButton) and
    // calls `.first().waitFor(...)` on it. That joined string is the only selector
    // containing a comma, so we can distinguish it from the individual selectors below
    // (which the rest of the implementation queries separately via `.count()`).
    const rejectingWaitForLocator = {
      count: vi.fn().mockResolvedValue(0),
      first: vi.fn(() => ({
        waitFor: vi.fn().mockRejectedValue(new Error('Timeout 8000ms exceeded waiting for locator')),
      })),
    };

    // The joined "any control" selector built inside `waitForFormControls` is the only
    // selector queried anywhere in the implementation that contains ALL of these four
    // substrings at once (formGrouping + nextButton + reviewButton + submitButton joined
    // by ', ') — every other individual selector query (Easy Apply button, bare Next
    // button, bare Review button, bare Submit button, bare form grouping) is missing at
    // least one of them. This lets the fake distinguish the joined wait-helper call from
    // the implementation's own separate `.count()` lookups.
    const isAnyControlsSelector = (selector: string) =>
      selector.includes('jobs-easy-apply-form-section__grouping') &&
      selector.includes('Next') &&
      selector.includes('Review') &&
      selector.includes('Submit');

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (isAnyControlsSelector(selector)) return rejectingWaitForLocator;
        if (selector.includes('Easy Apply')) return makeFakeLocator(easyApplyButton);
        // Bare Next/Review/Submit control lookups (used by the loop's own fallback
        // checks) are all absent, so after the timed-out wait, the loop correctly
        // falls through to "could not find a next/review/submit control".
        if (selector.includes('Submit')) return makeFakeLocator(null);
        if (selector.includes('Review')) return makeFakeLocator(null);
        if (selector.includes('Next')) return makeFakeLocator(null);
        if (selector.includes('jobs-easy-apply-form-section__grouping')) return emptyGroupingsLocator;
        return makeFakeLocator(null);
      }),
      setInputFiles: vi.fn().mockResolvedValue(undefined),
    };

    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const launch = vi.fn().mockResolvedValue(browser);
    const fakeChromium = { launch };

    const result = await applyEasyApply(
      { job_id: 'job-mr-timeout-1' },
      { db, chromium: fakeChromium }
    );

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/could not find a next\/review\/submit control/);
    // The Easy Apply click itself must still have happened before the timed-out wait.
    expect(easyApplyButton.click).toHaveBeenCalledTimes(1);
  });

  /**
   * Builds a minimal page mock for the "submit button found immediately" happy path
   * (no form groupings, no aria-label questions, no radio groups), parameterized on
   * whether the post-click confirmation text ever appears. Live-verified 2026-07-15:
   * a submit click can silently no-op on LinkedIn's end with no thrown error and no
   * application actually recorded, which is exactly the gap these two tests cover —
   * every other test's fake `waitFor` resolves instantly, so none of them exercised
   * whether a real confirmation check gates the `submitted` status.
   */
  function makeSubmitConfirmationPage(confirmationAppears: boolean) {
    const easyApplyButton = makeFakeElement();
    const submitButton = makeFakeElement();
    const confirmationLocator = {
      first: vi.fn(() => ({
        waitFor: confirmationAppears
          ? vi.fn().mockResolvedValue(undefined)
          : vi.fn().mockRejectedValue(new Error('Timeout 10000ms exceeded')),
      })),
    };

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector.includes('Easy Apply')) return makeFakeLocator(easyApplyButton);
        if (selector === SELECTORS.submissionConfirmation) return confirmationLocator;
        if (selector.includes('Submit')) return makeFakeLocator(submitButton);
        return makeFakeLocator(null);
      }),
      setInputFiles: vi.fn().mockResolvedValue(undefined),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    return { launch: vi.fn().mockResolvedValue(browser), submitButton };
  }

  it('returns submitted only once the post-click confirmation text actually appears', async () => {
    saveJob(db, {
      id: 'job-submitted-1',
      source: 'linkedin',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://linkedin.com/jobs/view/4',
      apply_url: 'https://linkedin.com/jobs/view/4',
      description: 'React role',
    });

    const { launch, submitButton } = makeSubmitConfirmationPage(true);

    const result = await applyEasyApply({ job_id: 'job-submitted-1' }, { db, chromium: { launch } });

    expect(result.status).toBe('submitted');
    expect(submitButton.click).toHaveBeenCalledTimes(1);
  });

  it('returns manual_review (not submitted) when the submit click cannot be confirmed', async () => {
    // This is the regression test for the false-positive bug: a submit click that
    // silently no-ops must never be reported as `submitted`.
    saveJob(db, {
      id: 'job-unconfirmed-1',
      source: 'linkedin',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://linkedin.com/jobs/view/5',
      apply_url: 'https://linkedin.com/jobs/view/5',
      description: 'React role',
    });

    const { launch, submitButton } = makeSubmitConfirmationPage(false);

    const result = await applyEasyApply({ job_id: 'job-unconfirmed-1' }, { db, chromium: { launch } });

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/could not confirm the application was actually recorded/);
    // The click still happens — it's the unverifiable *outcome* that's unsafe to trust.
    expect(submitButton.click).toHaveBeenCalledTimes(1);
  });
});

/**
 * A fake locator representing the "any clickable control" query the hybrid fallback
 * issues when a primary selector misses (`page.locator('button, [role="button"], a[role="button"]')`):
 * `evaluateAll` returns the given candidate texts, `filter({ hasText })` resolves to the
 * matching fake element (or nothing, if the text isn't in `elementsByText`).
 */
function makeFakeClickableLocator(
  candidates: string[],
  elementsByText: Record<string, ReturnType<typeof makeFakeElement>> = {}
): any {
  return {
    evaluateAll: vi.fn().mockResolvedValue(candidates),
    filter: vi.fn(({ hasText }: { hasText: string }) => makeFakeLocator(elementsByText[hasText] ?? null)),
  };
}

describe('applyEasyApply hybrid fallback (option 3)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('escalates to the Claude fallback and clicks the control it chooses when the Easy Apply selector misses', async () => {
    saveJob(db, {
      id: 'job-hybrid-1',
      source: 'linkedin',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://linkedin.com/jobs/view/6',
      apply_url: 'https://linkedin.com/jobs/view/6',
      description: 'React role',
    });

    const fallbackEasyApplyButton = makeFakeElement();
    // First call (Easy Apply button escalation) matches; every later call (next/review
    // control escalation) finds nothing, so the run still ends in manual_review — this
    // test only asserts that the FIRST escalation was used and clicked.
    const runClaude = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ matchedText: 'Easy Apply' }))
      .mockResolvedValue(JSON.stringify({ matchedText: null }));

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector.includes('[role="button"]')) {
          return makeFakeClickableLocator(['Sign in', 'Easy Apply'], { 'Easy Apply': fallbackEasyApplyButton });
        }
        // The primary Easy Apply selector (and everything else) misses.
        return makeFakeLocator(null);
      }),
      setInputFiles: vi.fn().mockResolvedValue(undefined),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await applyEasyApply(
      { job_id: 'job-hybrid-1' },
      { db, chromium: { launch }, fallbackEnabled: true, fallback: { runClaude } }
    );

    expect(fallbackEasyApplyButton.click).toHaveBeenCalledTimes(1);
    // Got past the Easy Apply step via the fallback; only failed later on the
    // next/review/submit control (also escalated, also found nothing real to click).
    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/next\/review\/submit/);
  });

  it('returns manual_review (Easy Apply button not found) when the fallback also finds no match', async () => {
    saveJob(db, {
      id: 'job-hybrid-2',
      source: 'linkedin',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://linkedin.com/jobs/view/7',
      apply_url: 'https://linkedin.com/jobs/view/7',
      description: 'React role',
    });

    const runClaude = vi.fn().mockResolvedValue(JSON.stringify({ matchedText: null }));
    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector.includes('[role="button"]')) return makeFakeClickableLocator(['Sign in']);
        return makeFakeLocator(null);
      }),
      setInputFiles: vi.fn().mockResolvedValue(undefined),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await applyEasyApply(
      { job_id: 'job-hybrid-2' },
      { db, chromium: { launch }, fallbackEnabled: true, fallback: { runClaude } }
    );

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/Easy Apply button not found/);
    expect(runClaude).toHaveBeenCalled();
  });

  it('uses the Claude answer-topic fallback to resolve a rephrased screening question instead of giving up with needs_answer', async () => {
    saveJob(db, {
      id: 'job-hybrid-3',
      source: 'linkedin',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://linkedin.com/jobs/view/8',
      apply_url: 'https://linkedin.com/jobs/view/8',
      description: 'React role',
    });

    const easyApplyButton = makeFakeElement();
    // Deliberately doesn't contain any QUESTION_PATTERNS keyword ("salary"/"ctc"/etc.) so
    // the fast, free resolveAnswer() genuinely returns null and the fallback is exercised.
    const rephrasedLabel = makeFakeElement({
      textContent: vi.fn().mockResolvedValue('Kindly state your compensation ask'),
    });
    const input = makeFakeElement();
    const grouping = makeFakeGroupingLocator({ label: rephrasedLabel, input });

    const runClaude = vi.fn().mockResolvedValue(JSON.stringify({ matchedKey: 'expected_salary' }));

    const page = {
      goto: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector.includes('[role="button"]')) return makeFakeClickableLocator([]);
        if (selector.includes('Easy Apply')) return makeFakeLocator(easyApplyButton);
        if (selector.includes('jobs-easy-apply-form-section__grouping')) return makeFakeGroupingsLocator([grouping]);
        return makeFakeLocator(null);
      }),
      setInputFiles: vi.fn().mockResolvedValue(undefined),
    };
    const context = { newPage: vi.fn().mockResolvedValue(page) };
    const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await applyEasyApply(
      { job_id: 'job-hybrid-3' },
      { db, chromium: { launch }, fallbackEnabled: true, fallback: { runClaude } }
    );

    expect(result.status).not.toBe('needs_answer');
    // The already-truthful expected_salary value from the answers config (the user-data template
    // under test) — never a fabricated new figure.
    const configured = JSON.parse(readFileSync('user-data.example/easy-apply-answers.json', 'utf8')) as {
      expected_salary: string;
    };
    expect(input.fill).toHaveBeenCalledWith(configured.expected_salary);
  });
});

describe('findPreparedResumePath', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('finds a resume from outreach_queue when there is no legacy outreach row (the autonomous-pipeline case)', () => {
    enqueueOutreach(db, {
      job_id: 'job-q-1',
      resume_pdf_path: '/tmp/queue-resume.pdf',
      email_subject: null,
      email_body: null,
      email_to: null,
      connect_note: 'note',
      connect_profile_url: 'https://linkedin.com/in/someone/',
      connect_category: 'recruiter',
      connect_company: 'Acme',
      apply_platform: 'linkedin',
      apply_url: 'https://linkedin.com/jobs/view/123',
    });

    expect(findPreparedResumePath(db, 'job-q-1')).toBe('/tmp/queue-resume.pdf');
  });

  it('finds a resume from the legacy outreach table when there is no outreach_queue row (the old manual-email-flow case)', () => {
    saveOutreach(db, {
      job_id: 'job-legacy-1',
      contact_email: 'hr@acme.com',
      subject: 'subj',
      body: 'body',
      resume_path: '/tmp/legacy-resume.pdf',
    });

    expect(findPreparedResumePath(db, 'job-legacy-1')).toBe('/tmp/legacy-resume.pdf');
  });

  it('prefers whichever row is more recent when both a legacy outreach row and an outreach_queue row exist for the same job', () => {
    saveOutreach(db, {
      job_id: 'job-both-1',
      contact_email: 'hr@acme.com',
      subject: 'subj',
      body: 'body',
      resume_path: '/tmp/legacy-resume.pdf',
    });
    // outreach_queue row is inserted after, so its created_at (via default datetime('now'))
    // should be the same second or later — SQLite's datetime('now') has 1-second resolution,
    // so this test only asserts the queue row is picked when its timestamp is >= the legacy
    // row's, which the natural insert order guarantees here.
    enqueueOutreach(db, {
      job_id: 'job-both-1',
      resume_pdf_path: '/tmp/queue-resume.pdf',
      email_subject: null,
      email_body: null,
      email_to: null,
      connect_note: null,
      connect_profile_url: null,
      connect_category: null,
      connect_company: null,
      apply_platform: 'linkedin',
      apply_url: 'https://linkedin.com/jobs/view/456',
    });

    expect(findPreparedResumePath(db, 'job-both-1')).toBe('/tmp/queue-resume.pdf');
  });

  it('returns undefined when no resume is prepared for this job in either table', () => {
    expect(findPreparedResumePath(db, 'job-nothing-1')).toBeUndefined();
  });

  it('ignores an outreach_queue row whose resume_pdf_path is null (apply-only or connect-only rows)', () => {
    enqueueOutreach(db, {
      job_id: 'job-null-resume-1',
      resume_pdf_path: null,
      email_subject: null,
      email_body: null,
      email_to: null,
      connect_note: 'note',
      connect_profile_url: 'https://linkedin.com/in/someone/',
      connect_category: 'peer',
      connect_company: 'Acme',
      apply_platform: 'none',
      apply_url: null,
    });

    expect(findPreparedResumePath(db, 'job-null-resume-1')).toBeUndefined();
  });
});
