import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detect as detectGreenhouse, fieldMap as greenhouseFieldMap } from '../src/ats/greenhouse.js';
import { detect as detectLever, fieldMap as leverFieldMap } from '../src/ats/lever.js';
import { detect as detectWorkday, fieldMap as workdayFieldMap } from '../src/ats/workday.js';
import { detect as detectAshby, fieldMap as ashbyFieldMap } from '../src/ats/ashby.js';
import { detectAts, splitName, applyExternal, SELECTORS } from '../src/apply/external.js';
import { openDb, saveJob, saveOutreach, enqueueOutreach } from '../src/db.js';
import type Database from 'better-sqlite3';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveLearnedPlatform } from '../src/ats/learned.js';

const REQUIRED_FIELD_KEYS = ['name', 'email', 'phone', 'resumeUpload', 'coverLetter'];

function expectFieldMapComplete(fieldMap: Record<string, unknown>) {
  for (const key of REQUIRED_FIELD_KEYS) {
    expect(fieldMap).toHaveProperty(key);
    expect(typeof fieldMap[key]).toBe('string');
    expect((fieldMap[key] as string).length).toBeGreaterThan(0);
  }
}

describe('greenhouse ATS', () => {
  it('detects greenhouse-hosted job board URLs', () => {
    expect(detectGreenhouse('https://boards.greenhouse.io/acme/jobs/123')).toBe('greenhouse');
    expect(detectGreenhouse('https://job-boards.greenhouse.io/acme/jobs/123')).toBe('greenhouse');
  });

  it('returns null for non-greenhouse URLs', () => {
    expect(detectGreenhouse('https://jobs.lever.co/acme/123')).toBeNull();
    expect(detectGreenhouse('not a url')).toBeNull();
  });

  it('fieldMap has all required selector keys', () => {
    expectFieldMapComplete(greenhouseFieldMap as unknown as Record<string, unknown>);
  });

  it('splits the name field into separate first/last selectors (Greenhouse form has both inputs)', () => {
    expect(greenhouseFieldMap.firstName).toBe('#first_name');
    expect(greenhouseFieldMap.lastName).toBe('#last_name');
    // firstName/lastName should be distinct from a combined-name selector.
    expect(greenhouseFieldMap.firstName).not.toBe(greenhouseFieldMap.lastName);
  });
});

describe('lever ATS', () => {
  it('detects lever-hosted job URLs', () => {
    expect(detectLever('https://jobs.lever.co/acme/abc-123')).toBe('lever');
  });

  it('returns null for non-lever URLs', () => {
    expect(detectLever('https://boards.greenhouse.io/acme/jobs/123')).toBeNull();
  });

  it('fieldMap has all required selector keys', () => {
    expectFieldMapComplete(leverFieldMap as unknown as Record<string, unknown>);
  });

  it('uses a single combined name field (Lever form has no separate first/last inputs)', () => {
    expect(leverFieldMap.firstName).toBeUndefined();
    expect(leverFieldMap.lastName).toBeUndefined();
  });
});

describe('workday ATS', () => {
  it('detects myworkdayjobs.com URLs', () => {
    expect(detectWorkday('https://acme.wd1.myworkdayjobs.com/en-US/acme_careers/job/Remote/Engineer_R123')).toBe(
      'workday'
    );
  });

  it('returns null for non-workday URLs', () => {
    expect(detectWorkday('https://jobs.ashbyhq.com/acme/abc')).toBeNull();
  });

  it('fieldMap has all required selector keys', () => {
    expectFieldMapComplete(workdayFieldMap as unknown as Record<string, unknown>);
  });

  it('splits the name field into separate first/last selectors (Workday form has both inputs)', () => {
    expect(workdayFieldMap.firstName).toBe('[data-automation-id="legalNameSection_firstName"]');
    expect(workdayFieldMap.lastName).toBe('[data-automation-id="legalNameSection_lastName"]');
    expect(workdayFieldMap.firstName).not.toBe(workdayFieldMap.lastName);
  });
});

describe('ashby ATS', () => {
  it('detects ashbyhq.com URLs', () => {
    expect(detectAshby('https://jobs.ashbyhq.com/acme/abc-123')).toBe('ashby');
  });

  it('returns null for non-ashby URLs', () => {
    expect(detectAshby('https://acme.wd1.myworkdayjobs.com/job/1')).toBeNull();
  });

  it('fieldMap has all required selector keys', () => {
    expectFieldMapComplete(ashbyFieldMap as unknown as Record<string, unknown>);
  });

  it('uses a single combined name field (Ashby form has no separate first/last inputs)', () => {
    expect(ashbyFieldMap.firstName).toBeUndefined();
    expect(ashbyFieldMap.lastName).toBeUndefined();
  });
});

describe('detectAts', () => {
  it('routes a URL to the correct platform + fieldMap', () => {
    const result = detectAts('https://boards.greenhouse.io/acme/jobs/123');
    expect(result?.platform).toBe('greenhouse');
    expectFieldMapComplete(result!.fieldMap as unknown as Record<string, unknown>);
  });

  it('returns null when no platform matches', () => {
    expect(detectAts('https://example.com/careers/123')).toBeNull();
  });
});

describe('splitName', () => {
  it('splits a "First Last" string on the first whitespace boundary', () => {
    expect(splitName('Jane Doe')).toEqual({ first: 'Jane', last: 'Doe' });
  });

  it('splits a "First Middle Last" string keeping everything after the first space as last', () => {
    expect(splitName('Mary Jane Watson')).toEqual({ first: 'Mary', last: 'Jane Watson' });
  });

  it('treats a single-word name as first name only, with an empty last name', () => {
    expect(splitName('Cher')).toEqual({ first: 'Cher', last: '' });
  });

  it('handles undefined/empty input without throwing', () => {
    expect(splitName(undefined)).toEqual({ first: '', last: '' });
    expect(splitName('')).toEqual({ first: '', last: '' });
    expect(splitName('   ')).toEqual({ first: '', last: '' });
  });
});

describe('applyExternal prepared-materials lookup (outreach_queue support)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  function seedJob(jobId: string) {
    saveJob(db, {
      id: jobId,
      source: 'greenhouse',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      apply_url: 'https://boards.greenhouse.io/acme/jobs/123',
      description: 'React role',
    });
  }

  function makeFakeSubmittingPage() {
    const submitButton = { click: vi.fn().mockResolvedValue(undefined) };
    return {
      goto: vi.fn().mockResolvedValue(undefined),
      evaluate: vi.fn().mockResolvedValue({ inputs: [], buttons: [] }),
      $: vi.fn().mockResolvedValue({}),
      fill: vi.fn().mockResolvedValue(undefined),
      setInputFiles: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockImplementation((selector: string) => {
        if (selector === greenhouseFieldMap.submitButton) {
          return { count: vi.fn().mockResolvedValue(1), first: vi.fn(() => submitButton) };
        }
        if (selector === SELECTORS.submissionConfirmation) {
          return { first: vi.fn(() => ({ waitFor: vi.fn().mockResolvedValue(undefined) })) };
        }
        return { count: vi.fn().mockResolvedValue(0), first: vi.fn(() => ({})) };
      }),
    };
  }

  it('finds a resume prepared only in outreach_queue (the autonomous-pipeline table), not just the legacy outreach table', async () => {
    seedJob('job-ext-queue-only');
    enqueueOutreach(db, {
      job_id: 'job-ext-queue-only',
      resume_pdf_path: '/tmp/queued-resume.pdf',
      email_subject: 'Application',
      email_body: 'Queued cover letter body',
      email_to: 'hiring@acme.com',
      connect_note: null,
      connect_profile_url: null,
      connect_category: null,
      connect_company: null,
      apply_platform: null,
      apply_url: null,
    });
    const page = makeFakeSubmittingPage();
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await applyExternal({ job_id: 'job-ext-queue-only' }, { db, chromium: { launch } });

    expect(result.status).toBe('submitted');
    expect(page.setInputFiles).toHaveBeenCalledWith(greenhouseFieldMap.resumeUpload, '/tmp/queued-resume.pdf');
  });

  it('still finds a resume prepared only in the legacy outreach table', async () => {
    seedJob('job-ext-legacy-only');
    saveOutreach(db, {
      job_id: 'job-ext-legacy-only',
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Legacy cover letter body',
      resume_path: '/tmp/legacy-resume.pdf',
    });
    const page = makeFakeSubmittingPage();
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await applyExternal({ job_id: 'job-ext-legacy-only' }, { db, chromium: { launch } });

    expect(result.status).toBe('submitted');
    expect(page.setInputFiles).toHaveBeenCalledWith(greenhouseFieldMap.resumeUpload, '/tmp/legacy-resume.pdf');
  });

  it('prefers whichever of legacy/queued rows is more recent when both exist', async () => {
    seedJob('job-ext-both-prefer-recent');
    saveOutreach(db, {
      job_id: 'job-ext-both-prefer-recent',
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Older legacy cover letter',
      resume_path: '/tmp/older-legacy-resume.pdf',
    });
    // Ensure a distinct, later created_at than the legacy row above.
    db.prepare("UPDATE outreach SET created_at = datetime('now', '-1 hour') WHERE job_id = ?").run(
      'job-ext-both-prefer-recent'
    );
    enqueueOutreach(db, {
      job_id: 'job-ext-both-prefer-recent',
      resume_pdf_path: '/tmp/newer-queued-resume.pdf',
      email_subject: 'Application',
      email_body: 'Newer queued cover letter',
      email_to: 'hiring@acme.com',
      connect_note: null,
      connect_profile_url: null,
      connect_category: null,
      connect_company: null,
      apply_platform: null,
      apply_url: null,
    });
    const page = makeFakeSubmittingPage();
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await applyExternal({ job_id: 'job-ext-both-prefer-recent' }, { db, chromium: { launch } });

    expect(result.status).toBe('submitted');
    expect(page.setInputFiles).toHaveBeenCalledWith(greenhouseFieldMap.resumeUpload, '/tmp/newer-queued-resume.pdf');
  });

  it('returns manual_review when neither outreach nor outreach_queue has a resume for this job', async () => {
    seedJob('job-ext-no-materials');
    const launch = vi.fn();

    const result = await applyExternal({ job_id: 'job-ext-no-materials' }, { db, chromium: { launch } });

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/no tailored resume\/cover letter prepared/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('ignores an outreach_queue row with a null resume_pdf_path, falling back to legacy outreach if present', async () => {
    seedJob('job-ext-queue-null-resume');
    saveOutreach(db, {
      job_id: 'job-ext-queue-null-resume',
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Legacy cover letter',
      resume_path: '/tmp/legacy-fallback-resume.pdf',
    });
    enqueueOutreach(db, {
      job_id: 'job-ext-queue-null-resume',
      resume_pdf_path: null,
      email_subject: 'Application',
      email_body: 'Queued cover letter with no resume yet',
      email_to: 'hiring@acme.com',
      connect_note: null,
      connect_profile_url: null,
      connect_category: null,
      connect_company: null,
      apply_platform: null,
      apply_url: null,
    });
    const page = makeFakeSubmittingPage();
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await applyExternal({ job_id: 'job-ext-queue-null-resume' }, { db, chromium: { launch } });

    expect(result.status).toBe('submitted');
    expect(page.setInputFiles).toHaveBeenCalledWith(greenhouseFieldMap.resumeUpload, '/tmp/legacy-fallback-resume.pdf');
  });
});

describe('applyExternal rate limiting (Finding 1)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  function seedApplicableJob(jobId: string) {
    saveJob(db, {
      id: jobId,
      source: 'greenhouse',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      apply_url: 'https://boards.greenhouse.io/acme/jobs/123',
      description: 'React role',
    });
    saveOutreach(db, {
      job_id: jobId,
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Cover letter body',
      resume_path: '/tmp/fake-resume.pdf',
    });
  }

  it('returns rate_limited and never touches Playwright when the daily apply limit is already reached', async () => {
    seedApplicableJob('job-ext-rl-1');
    const launch = vi.fn();

    const result = await applyExternal(
      { job_id: 'job-ext-rl-1' },
      { db, maxAppliesPerDay: 0, chromium: { launch } }
    );

    expect(result.status).toBe('rate_limited');
    expect(result.platform).toBe('greenhouse');
    // The rate-limit gate must be checked BEFORE any Playwright action — launch()
    // should never be invoked once the limit is already exhausted.
    expect(launch).not.toHaveBeenCalled();
  });

  it('shares the same "easy_apply" daily counter as linkedin.ts (documented shared cap)', async () => {
    seedApplicableJob('job-ext-shared-1');

    // Pre-exhaust the shared counter the way applyEasyApply would.
    db.prepare('INSERT INTO daily_counters (day, key, count) VALUES (date(\'now\'), ?, ?)').run(
      'easy_apply',
      1
    );

    const launch = vi.fn();
    const result = await applyExternal(
      { job_id: 'job-ext-shared-1' },
      { db, maxAppliesPerDay: 1, chromium: { launch } }
    );

    expect(result.status).toBe('rate_limited');
    expect(launch).not.toHaveBeenCalled();
  });

  it('does not burn a quota slot on a cheap pre-flight rejection (Finding 2: job not found)', async () => {
    const launch = vi.fn();

    const result = await applyExternal(
      { job_id: 'job-does-not-exist' },
      { db, maxAppliesPerDay: 5, chromium: { launch } }
    );

    expect(result.status).toBe('manual_review');
    expect(launch).not.toHaveBeenCalled();

    const row = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?")
      .get('easy_apply') as { count: number } | undefined;
    expect(row).toBeUndefined();
  });

  it('does not burn a quota slot on a cheap pre-flight rejection (Finding 2: no tailored resume prepared)', async () => {
    saveJob(db, {
      id: 'job-ext-no-outreach',
      source: 'greenhouse',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://boards.greenhouse.io/acme/jobs/456',
      apply_url: 'https://boards.greenhouse.io/acme/jobs/456',
      description: 'React role',
    });
    const launch = vi.fn();

    const result = await applyExternal(
      { job_id: 'job-ext-no-outreach' },
      { db, maxAppliesPerDay: 5, chromium: { launch } }
    );

    expect(result.status).toBe('manual_review');
    expect(launch).not.toHaveBeenCalled();

    const row = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?")
      .get('easy_apply') as { count: number } | undefined;
    expect(row).toBeUndefined();
  });

  it('rejects immediately without launching a browser when expected_platform is set and the URL matches no known/learned platform', async () => {
    // A caller invoking one of the 4 explicit per-platform tools always sets
    // expected_platform — an unrecognized domain there is a data problem (wrong apply_url),
    // not a bootstrap opportunity, so this stays a cheap pre-flight rejection.
    saveJob(db, {
      id: 'job-ext-unsupported-explicit',
      source: 'other',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://example.com/careers/123',
      apply_url: 'https://example.com/careers/123',
      description: 'React role',
    });
    saveOutreach(db, {
      job_id: 'job-ext-unsupported-explicit',
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Cover letter body',
      resume_path: '/tmp/fake-resume.pdf',
    });
    const launch = vi.fn();

    const result = await applyExternal(
      { job_id: 'job-ext-unsupported-explicit', expected_platform: 'greenhouse' },
      { db, maxAppliesPerDay: 5, chromium: { launch } }
    );

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/unsupported ATS platform/);
    expect(launch).not.toHaveBeenCalled();

    const row = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?")
      .get('easy_apply') as { count: number } | undefined;
    expect(row).toBeUndefined();
  });

  it('refuses a non-http(s) apply_url before any detection, bootstrap, browser or counter use', async () => {
    const launch = vi.fn();
    const runClaude = vi.fn();
    const learnedPlatformsPath = path.join(mkdtempSync(path.join(tmpdir(), 'scheme-')), 'learned-ats-platforms.json');
    const urls = ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', '//jobs.example.com/apply/1', 'not a url'];
    for (const [i, u] of urls.entries()) {
      saveJob(db, { id: `job-scheme-${i}`, source: 'other', title: 'T', company: 'C', url: 'https://example.com/x', apply_url: u, description: 'd' });
      saveOutreach(db, { job_id: `job-scheme-${i}`, contact_email: 'h@acme.com', subject: 's', body: 'b', resume_path: '/tmp/fake-resume.pdf' });
      const result = await applyExternal(
        { job_id: `job-scheme-${i}` },
        { db, maxAppliesPerDay: 5, chromium: { launch }, bootstrap: { runClaude }, learnedPlatformsPath }
      );
      expect(result.status).toBe('manual_review');
      expect(result.reason).toContain('not an http(s) URL');
    }
    expect(launch).not.toHaveBeenCalled();
    expect(runClaude).not.toHaveBeenCalled();
    expect(existsSync(learnedPlatformsPath)).toBe(false);
    const row = db.prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?").get('easy_apply');
    expect(row).toBeUndefined();
  });

  it('refuses a look-alike ATS host with no expected_platform before any bootstrap, browser launch or learned-platform write', async () => {
    saveJob(db, {
      id: 'job-ext-lookalike',
      source: 'other',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://evil-greenhouse.io/acme/jobs/1',
      apply_url: 'https://evil-greenhouse.io/acme/jobs/1',
      description: 'React role',
    });
    saveOutreach(db, {
      job_id: 'job-ext-lookalike',
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Cover letter body',
      resume_path: '/tmp/fake-resume.pdf',
    });
    const launch = vi.fn();
    const runClaude = vi.fn();
    const learnedPlatformsPath = path.join(mkdtempSync(path.join(tmpdir(), 'lookalike-')), 'learned-ats-platforms.json');

    const result = await applyExternal(
      { job_id: 'job-ext-lookalike' },
      { db, maxAppliesPerDay: 5, chromium: { launch }, bootstrap: { runClaude }, learnedPlatformsPath }
    );

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/look-alike/);
    expect(launch).not.toHaveBeenCalled();
    expect(runClaude).not.toHaveBeenCalled();
    expect(existsSync(learnedPlatformsPath)).toBe(false);
    const row = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?")
      .get('easy_apply') as { count: number } | undefined;
    expect(row).toBeUndefined();
  });

  it('attempts to bootstrap a new field map (no expected_platform) for an unrecognized domain, falling to manual_review when the bootstrap cannot resolve any required field', async () => {
    saveJob(db, {
      id: 'job-ext-unsupported-bootstrap',
      source: 'other',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://example.com/careers/123',
      apply_url: 'https://example.com/careers/123',
      description: 'React role',
    });
    saveOutreach(db, {
      job_id: 'job-ext-unsupported-bootstrap',
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Cover letter body',
      resume_path: '/tmp/fake-resume.pdf',
    });
    const { page } = makeFakeExternalApplyPage({
      submitButtonSelector: '#submit',
      rawSnapshot: { inputs: [], buttons: [] },
    });
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);
    const runClaude = vi.fn().mockResolvedValue(null); // simulates the bootstrap CLI call failing/finding nothing

    const result = await applyExternal(
      { job_id: 'job-ext-unsupported-bootstrap' },
      { db, maxAppliesPerDay: 5, chromium: { launch }, bootstrap: { runClaude } }
    );

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/could not learn a field map for this platform/);
    expect(result.platform).toBe('example.com');
    expect(launch).toHaveBeenCalled();

    // Unlike the cheap pre-flight rejections above, a bootstrap ATTEMPT is real work
    // (browser launch + a live Claude call) and burns a quota slot just like any other apply.
    const row = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?")
      .get('easy_apply') as { count: number } | undefined;
    expect(row?.count).toBe(1);
  });
});

/**
 * A minimal fake Playwright `Page` covering both APIs applyExternal uses: `page.$()`
 * (ElementHandle, for the required-field checks/fills, all treated as present by default so
 * these tests can focus on the submit-button/confirmation/fallback behavior) and
 * `page.locator()` (for the submit button, the post-submit confirmation text, and the hybrid
 * fallback's real-clickable-candidates query).
 */
function makeFakeExternalApplyPage({
  submitButtonSelector,
  submitButtonFound = true,
  confirmationAppears = true,
  clickableCandidates = [] as string[],
  clickableElementsByText = {} as Record<string, { click: ReturnType<typeof vi.fn> }>,
  rawSnapshot = { inputs: [], buttons: [] } as { inputs: unknown[]; buttons: unknown[] },
}: {
  submitButtonSelector: string;
  submitButtonFound?: boolean;
  confirmationAppears?: boolean;
  clickableCandidates?: string[];
  clickableElementsByText?: Record<string, { click: ReturnType<typeof vi.fn> }>;
  rawSnapshot?: { inputs: unknown[]; buttons: unknown[] };
}) {
  const submitButton = { click: vi.fn().mockResolvedValue(undefined) };

  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(rawSnapshot),
    $: vi.fn().mockResolvedValue({}), // every required-field/optional-field lookup "found"
    fill: vi.fn().mockResolvedValue(undefined),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn().mockImplementation((selector: string) => {
      if (selector === submitButtonSelector) {
        return {
          count: vi.fn().mockResolvedValue(submitButtonFound ? 1 : 0),
          first: vi.fn(() => submitButton),
        };
      }
      if (selector.includes('[role="button"]')) {
        return {
          evaluateAll: vi.fn().mockResolvedValue(clickableCandidates),
          filter: vi.fn(({ hasText }: { hasText: string }) => ({
            count: vi.fn().mockResolvedValue(clickableElementsByText[hasText] ? 1 : 0),
            first: vi.fn(() => clickableElementsByText[hasText]),
          })),
        };
      }
      if (selector === SELECTORS.submissionConfirmation) {
        return {
          first: vi.fn(() => ({
            waitFor: confirmationAppears
              ? vi.fn().mockResolvedValue(undefined)
              : vi.fn().mockRejectedValue(new Error('Timeout 10000ms exceeded')),
          })),
        };
      }
      return { count: vi.fn().mockResolvedValue(0), first: vi.fn(() => ({})) };
    }),
  };

  return { page, submitButton };
}

describe('applyExternal submission confirmation (parity with linkedin.ts false-positive fix)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  function seedApplicableJob(jobId: string) {
    saveJob(db, {
      id: jobId,
      source: 'greenhouse',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      apply_url: 'https://boards.greenhouse.io/acme/jobs/123',
      description: 'React role',
    });
    saveOutreach(db, {
      job_id: jobId,
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Cover letter body',
      resume_path: '/tmp/fake-resume.pdf',
    });
  }

  it('returns submitted only once the post-click confirmation text actually appears', async () => {
    seedApplicableJob('job-ext-submitted-1');
    const { page, submitButton } = makeFakeExternalApplyPage({
      submitButtonSelector: greenhouseFieldMap.submitButton,
      confirmationAppears: true,
    });
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await applyExternal({ job_id: 'job-ext-submitted-1' }, { db, chromium: { launch } });

    expect(result.status).toBe('submitted');
    expect(submitButton.click).toHaveBeenCalledTimes(1);
  });

  it('returns manual_review (not submitted) when the submit click cannot be confirmed', async () => {
    // Regression test for the same false-positive class of bug fixed in linkedin.ts:
    // a submit click can silently no-op, so the click alone must never be trusted.
    seedApplicableJob('job-ext-unconfirmed-1');
    const { page, submitButton } = makeFakeExternalApplyPage({
      submitButtonSelector: greenhouseFieldMap.submitButton,
      confirmationAppears: false,
    });
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    const result = await applyExternal({ job_id: 'job-ext-unconfirmed-1' }, { db, chromium: { launch } });

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/could not confirm the application was actually recorded/);
    expect(submitButton.click).toHaveBeenCalledTimes(1);
  });
});

describe('applyExternal hybrid fallback (submit-button escalation only)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  function seedApplicableJob(jobId: string) {
    saveJob(db, {
      id: jobId,
      source: 'greenhouse',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://boards.greenhouse.io/acme/jobs/123',
      apply_url: 'https://boards.greenhouse.io/acme/jobs/123',
      description: 'React role',
    });
    saveOutreach(db, {
      job_id: jobId,
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Cover letter body',
      resume_path: '/tmp/fake-resume.pdf',
    });
  }

  it('escalates to the Claude fallback and clicks + confirms the control it chooses when the submit selector misses', async () => {
    seedApplicableJob('job-ext-hybrid-1');
    const fallbackSubmitButton = { click: vi.fn().mockResolvedValue(undefined) };
    const { page } = makeFakeExternalApplyPage({
      submitButtonSelector: greenhouseFieldMap.submitButton,
      submitButtonFound: false,
      confirmationAppears: true,
      clickableCandidates: ['Save for later', 'Submit application'],
      clickableElementsByText: { 'Submit application': fallbackSubmitButton },
    });
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);
    const runClaude = vi.fn().mockResolvedValue(JSON.stringify({ matchedText: 'Submit application' }));

    const result = await applyExternal(
      { job_id: 'job-ext-hybrid-1' },
      { db, chromium: { launch }, fallbackEnabled: true, fallback: { runClaude } }
    );

    expect(fallbackSubmitButton.click).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('submitted');
  });

  it('returns manual_review (submit button not found) when the fallback also finds no match', async () => {
    seedApplicableJob('job-ext-hybrid-2');
    const { page } = makeFakeExternalApplyPage({
      submitButtonSelector: greenhouseFieldMap.submitButton,
      submitButtonFound: false,
      clickableCandidates: ['Save for later'],
    });
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);
    const runClaude = vi.fn().mockResolvedValue(JSON.stringify({ matchedText: null }));

    const result = await applyExternal(
      { job_id: 'job-ext-hybrid-2' },
      { db, chromium: { launch }, fallbackEnabled: true, fallback: { runClaude } }
    );

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/submit button not found/);
    expect(runClaude).toHaveBeenCalled();
  });

  it('never invokes the fallback client when hybrid mode is not enabled (default off)', async () => {
    seedApplicableJob('job-ext-hybrid-3');
    const { page } = makeFakeExternalApplyPage({
      submitButtonSelector: greenhouseFieldMap.submitButton,
      submitButtonFound: false,
    });
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);

    // No fallbackEnabled, no injected fallback client — must behave exactly as before this
    // change: immediate manual_review, no escalation attempted.
    const result = await applyExternal({ job_id: 'job-ext-hybrid-3' }, { db, chromium: { launch } });

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/submit button not found/);
  });
});

describe('applyExternal self-extending ATS bootstrap (success + reuse)', () => {
  let db: Database.Database;
  let tmpDir: string;
  let learnedPlatformsPath: string;

  beforeEach(() => {
    db = openDb(':memory:');
    tmpDir = mkdtempSync(path.join(tmpdir(), 'ats-bootstrap-test-'));
    learnedPlatformsPath = path.join(tmpDir, 'learned-ats-platforms.json');
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedApplicableJob(jobId: string, applyUrl: string) {
    saveJob(db, {
      id: jobId,
      source: 'other',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: applyUrl,
      apply_url: applyUrl,
      description: 'React role',
    });
    saveOutreach(db, {
      job_id: jobId,
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Cover letter body',
      resume_path: '/tmp/fake-resume.pdf',
    });
  }

  it('learns a FieldMap for a new platform, persists it, and submits through it in the same run', async () => {
    seedApplicableJob('job-ext-bootstrap-success', 'https://jobs.newats.example/apply/123');
    const rawSnapshot = {
      inputs: [
        { tag: 'input', id: 'full_name', indexAmongSameTag: 0 },
        { tag: 'input', id: 'email_addr', indexAmongSameTag: 1 },
        { tag: 'input', name: 'resume', indexAmongSameTag: 2 },
      ],
      buttons: [{ tag: 'button', id: 'submit_btn', text: 'Submit', indexAmongSameTag: 0 }],
    };
    const { page, submitButton } = makeFakeExternalApplyPage({
      submitButtonSelector: '#submit_btn',
      confirmationAppears: true,
      rawSnapshot,
    });
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);
    const runClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        fieldMap: {
          name: '#full_name',
          email: '#email_addr',
          resumeUpload: 'input[name="resume"]',
          submitButton: '#submit_btn',
        },
      })
    );

    const result = await applyExternal(
      { job_id: 'job-ext-bootstrap-success' },
      { db, chromium: { launch }, bootstrap: { runClaude }, learnedPlatformsPath }
    );

    expect(result.status).toBe('submitted');
    expect(result.platform).toBe('jobs.newats.example');
    expect(submitButton.click).toHaveBeenCalledTimes(1);

    const registry = JSON.parse(readFileSync(learnedPlatformsPath, 'utf8'));
    expect(registry['jobs.newats.example'].name).toBe('#full_name');
  });

  it('reuses a previously learned platform on a later call without invoking the bootstrap Claude fallback again', async () => {
    seedApplicableJob('job-ext-bootstrap-reuse', 'https://jobs.newats.example/apply/456');
    saveLearnedPlatform(
      'jobs.newats.example',
      {
        name: '#full_name',
        email: '#email_addr',
        phone: '#phone',
        resumeUpload: 'input[name="resume"]',
        coverLetter: '#cover',
        submitButton: '#submit_btn',
      },
      learnedPlatformsPath
    );
    const { page, submitButton } = makeFakeExternalApplyPage({
      submitButtonSelector: '#submit_btn',
      confirmationAppears: true,
    });
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);
    const runClaude = vi.fn();

    const result = await applyExternal(
      { job_id: 'job-ext-bootstrap-reuse' },
      { db, chromium: { launch }, bootstrap: { runClaude }, learnedPlatformsPath }
    );

    expect(result.status).toBe('submitted');
    expect(submitButton.click).toHaveBeenCalledTimes(1);
    expect(runClaude).not.toHaveBeenCalled();
  });
});
