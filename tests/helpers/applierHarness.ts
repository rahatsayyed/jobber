// Hermetic harness for the typed applier tools (plan 8G-2 task 18): in-memory db, invented job and
// queue rows, a temp resume PDF, the fixture fake site behind a real web runtime, an answer book built
// from the fixture files and a fake classifier. No network, no Chrome, no real user data.
import { vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../../src/db.js';
import { createWebRuntime, type WebRuntime } from '../../src/webcore/runtime.js';
import { loadAnswerBook } from '../../src/apply/answers.js';
import { createApplierState, type ApplierDeps } from '../../src/applier/tools/common.js';
import { resetSiteBlocks } from '../../src/webcore/signup.js';
import type { ClassifierPort } from '../../src/safety/inputGate.js';
import { createFakeSite, type FakeSite, type FakeSiteOpts } from './fakeSitePage.js';
import { fixtureHtml } from './fixtureSite.js';

export const APPLY_URL = 'https://boards.greenhouse.io/acme/jobs/1';
export const HOST = 'boards.greenhouse.io';
export const WHY = 'Because the product is interesting and the team ships.';

export const LIVE: NodeJS.ProcessEnv = {
  JOBBER_DRY_RUN: 'false',
  APPLY_SUBMIT_MODE: 'submit', WEB_MIN_GAP_SEC: '0',
};

export interface ApplierHarness {
  db: BetterSqlite3.Database;
  deps: ApplierDeps;
  site: FakeSite;
  runtime: WebRuntime;
  dir: string;
  resumePath: string;
  stopFile: string;
  env: NodeJS.ProcessEnv;
  classifier: ClassifierPort & { classify: ReturnType<typeof vi.fn> };
  escalations: Array<[string, string]>;
  close(): Promise<void>;
}

export interface HarnessOpts extends Partial<FakeSiteOpts> {
  env?: NodeJS.ProcessEnv;
  jobId?: string;
  applyUrl?: string;
  source?: string;
  resume?: boolean;
  queue?: boolean;
  malicious?: boolean;
  why?: boolean;
  description?: string;
  platform?: string;
  tier?: string;
}

export function makeApplier(o: HarnessOpts = {}): ApplierHarness {
  resetSiteBlocks();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-applier-')));
  fs.chmodSync(dir, 0o700);
  const db = openDb(':memory:');
  const jobId = o.jobId ?? 'job-1';
  const applyUrl = o.applyUrl ?? APPLY_URL;
  db.prepare('INSERT INTO jobs (id, source, title, company, url, apply_url, description) VALUES (?,?,?,?,?,?,?)')
    .run(jobId, o.source ?? 'adzuna', 'Senior Engineer', 'Acme', applyUrl, applyUrl, o.description ?? 'Location: Pune, India\n\nBuild things.');
  const resumeRoot = path.join(dir, 'renderer', 'automation');
  const resumeDir = path.join(resumeRoot, 'abc');
  fs.mkdirSync(resumeDir, { recursive: true });
  const resumePath = path.join(resumeDir, 'resume.pdf');
  fs.writeFileSync(resumePath, '%PDF-1.4 invented');
  if (o.queue !== false) {
    db.prepare('INSERT INTO outreach_queue (job_id, resume_pdf_path, apply_platform, apply_tier, apply_url, status) VALUES (?,?,?,?,?,?)')
      .run(jobId, o.resume === false ? null : resumePath, o.platform ?? 'greenhouse', o.tier ?? 'fast', applyUrl, 'queued');
  }
  const answersPath = path.join(dir, 'answers.json');
  const answers = JSON.parse(fixtureHtml('answers.json')) as Record<string, unknown>;
  if (o.why !== false) (answers.custom as Record<string, string>)['Why do you want to work here?'] = WHY;
  fs.writeFileSync(answersPath, JSON.stringify(answers));
  const profilePath = path.join(dir, 'resume.json');
  fs.writeFileSync(profilePath, fixtureHtml('resume.json'));
  const book = loadAnswerBook({ answersPath, profilePath });

  const env: NodeJS.ProcessEnv = { ...LIVE, ...(o.env ?? {}) };
  const site = createFakeSite({ start: 'ats-a-form.html', url: applyUrl, ...o });
  const runtime = createWebRuntime({
    db, launcher: site.launcher, lockPath: path.join(dir, 'l.lock'), sessionDir: path.join(dir, 's'),
    config: { minGapSec: 0, settleMs: 0 }, env,
  });
  const classifier = { classify: vi.fn(async () => ({ malicious: !!o.malicious, score: 0.1, truncated: false })) };
  const escalations: Array<[string, string]> = [];
  const stopFile = path.join(dir, 'STOP');
  const deps: ApplierDeps = {
    db, runtime, env, answers: book, classifier, stopFile, resumeRoot, state: createApplierState(),
    escalate: (k, d) => { escalations.push([k, d]); },
  };
  return { db, deps, site, runtime, dir, resumePath, stopFile, env, classifier, escalations, close: async () => { await runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

export function count(db: BetterSqlite3.Database, sql: string, ...args: unknown[]): number {
  return (db.prepare(sql).get(...args) as { n: number }).n;
}
