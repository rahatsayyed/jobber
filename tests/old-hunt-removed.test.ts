// Plan 8G Task 14: the batch hunt (discoverer, sender, scripted LinkedIn discovery) is gone.
// Hermetic: reads repository files and an in-memory database only.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { enqueueOutreach, isSeen, listQueuedOutreach, openDb, saveJob } from '../src/db.js';
import { buildSyntheticPostId, extractLinkedInJobId, linkedInJobDbId } from '../src/linkedin/jobIds.js';
import { parseSchedulerArgs } from '../src/scheduler/args.js';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${e}`;
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

describe('deleted paths', () => {
  for (const p of [
    '.claude/agents/discoverer.md',
    '.claude/agents/sender.md',
    'src/discover',
    'src/mcp/discover.ts',
    'config/discover-linkedin.json',
    'tests/discover-linkedin-jobs.test.ts',
    'tests/discover-linkedin-posts.test.ts',
  ]) {
    it(`${p} does not exist`, () => expect(existsSync(join(ROOT, p))).toBe(false));
  }
});

describe('registrations', () => {
  it('.mcp.json has no discover server', () => {
    expect(Object.keys(JSON.parse(read('.mcp.json')).mcpServers)).not.toContain('discover');
  });
  it('package.json has no mcp:discover script', () => {
    expect(JSON.parse(read('package.json')).scripts['mcp:discover']).toBeUndefined();
  });
  it('the hunt run profile is gone', () => {
    expect(JSON.parse(read('config/run-profiles.json')).profiles.hunt).toBeUndefined();
  });
  it('no mcp__discover__, discoverer or sender agent string in config/, .claude/ or tests/fixtures/', () => {
    const files = [...walk('config'), ...walk('.claude'), ...walk('tests/fixtures')].filter((f) => /\.(json|md|cjs|js|ts)$/.test(f) && !f.includes('settings.local'));
    for (const f of files) {
      const s = read(f);
      expect(s, f).not.toContain('mcp__discover__');
      expect(s, f).not.toMatch(/\bdiscoverer\b/);
      expect(s, f).not.toMatch(/subagent_type: sender|^name: sender|"sender":\s*\{/m);
    }
  });
});

describe('run-hunt.sh shim', () => {
  it('is at most 6 lines and execs the scheduler wake', () => {
    const s = read('run-hunt.sh').trimEnd().split('\n');
    expect(s.length).toBeLessThanOrEqual(6);
    expect(s.join('\n')).toContain('exec npm run scheduler -- --once --now');
  });
  it('the scheduler CLI accepts --now (one wake right now)', () => {
    expect(parseSchedulerArgs(['--once', '--now'])).toMatchObject({ mode: 'once', now: true });
    expect(parseSchedulerArgs(['--now'])).toMatchObject({ mode: 'once', now: true });
    expect(parseSchedulerArgs(['--daemon'])).toMatchObject({ mode: 'daemon', now: false });
    expect(parseSchedulerArgs(['--status']).mode).toBe('status');
    expect(parseSchedulerArgs([]).mode).toBe('usage');
  });
});

describe('queue drain after the upgrade', () => {
  it('a pre-upgrade row with email, connect and apply parts is still returned by list_queued_outreach unchanged', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'li-job:3891234567', source: 'linkedin-jobs', title: 'Dev', company: 'Acme', url: 'https://www.linkedin.com/jobs/view/3891234567/', apply_url: 'https://boards.greenhouse.io/acme/jobs/1', description: 'x' });
    db.prepare("INSERT INTO contacts (company, email, type, verified, source, confidence) VALUES ('Acme', 'a@acme.example', 'hr', 1, 't', 0.9)").run();
    const id = enqueueOutreach(db, {
      job_id: 'li-job:3891234567', resume_pdf_path: 'generated/r.pdf', email_subject: 'Hello', email_body: 'Body', email_to: 'a@acme.example',
      connect_note: 'Hi there', connect_profile_url: 'https://www.linkedin.com/in/pat/', connect_category: 'recruiter', connect_company: 'Acme',
      apply_platform: 'greenhouse', apply_url: 'https://boards.greenhouse.io/acme/jobs/1',
    });
    const rows = listQueuedOutreach(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id, job_id: 'li-job:3891234567', status: 'queued',
      email_subject: 'Hello', email_to: 'a@acme.example', connect_profile_url: 'https://www.linkedin.com/in/pat/', apply_platform: 'greenhouse',
    });
    db.close();
  });
});

describe('linkedin ids keep the old derivation', () => {
  it('job ids dedupe against rows stored before the upgrade', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'li-job:3891234567', source: 'linkedin-jobs', title: 'Dev', company: 'Acme', url: 'u', apply_url: 'u', description: 'x' });
    const id = linkedInJobDbId(extractLinkedInJobId('https://www.linkedin.com/jobs/view/3891234567/?trackingId=abc')!);
    expect(id).toBe('li-job:3891234567');
    expect(isSeen(db, id)).toBe(true);
    expect(extractLinkedInJobId('https://www.linkedin.com/jobs/search/?keywords=react')).toBeNull();
    db.close();
  });
  it('post ids keep the old hash inputs', () => {
    expect(buildSyntheticPostId('https://www.linkedin.com/in/x/', 'hi')).toBe('li-post:77a2c642b1f9e3ab');
  });
});
