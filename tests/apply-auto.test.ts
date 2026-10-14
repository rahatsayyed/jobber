import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { dryRunApply, handleApplyAuto } from '../src/mcp/apply.js';

// apply.ts is an MCP server entrypoint (registers tools against a McpServer instance and
// calls server.connect() at import time unless VITEST=true is set) — so this test exercises
// the pure routing decision directly rather than spinning up the MCP server, mirroring how
// this project already avoids testing its other *.ts MCP entrypoints end-to-end.
import { routeApplyAuto } from '../src/mcp/applyAutoRouter.js';

describe('routeApplyAuto', () => {
  it('routes a Greenhouse URL to the greenhouse platform with expected_platform pinned', () => {
    expect(routeApplyAuto('https://boards.greenhouse.io/acme/jobs/123')).toEqual({
      kind: 'external',
      platform: 'greenhouse',
    });
  });

  it('routes a Lever URL to the lever platform with expected_platform pinned', () => {
    expect(routeApplyAuto('https://jobs.lever.co/acme/abc-123')).toEqual({
      kind: 'external',
      platform: 'lever',
    });
  });

  it('routes a LinkedIn URL to the linkedin (Easy Apply) path', () => {
    expect(routeApplyAuto('https://www.linkedin.com/jobs/view/123456')).toEqual({ kind: 'linkedin' });
  });

  it('does not treat look-alike LinkedIn hosts as LinkedIn (no burner-session Easy Apply)', () => {
    for (const url of ['https://evillinkedin.com/jobs/view/1', 'https://linkedin.com.evil.net/jobs/view/1', 'https://www.linkedin.com@evil.net/jobs/view/1']) {
      expect(routeApplyAuto(url)).toEqual({ kind: 'external', platform: null });
    }
    expect(routeApplyAuto('https://linkedin.com/jobs/view/1')).toEqual({ kind: 'linkedin' });
  });

  it('routes an unrecognized domain to the bootstrap path (external, no expected_platform)', () => {
    expect(routeApplyAuto('https://jobs.newats.example/apply/123')).toEqual({
      kind: 'external',
      platform: null,
    });
  });

  it('routes a malformed URL to the bootstrap path rather than throwing', () => {
    expect(routeApplyAuto('not a url')).toEqual({ kind: 'external', platform: null });
  });
});

describe('routeApplyAuto naukri', () => {
  it('routes naukri.com and subdomains over https to the agent', () => {
    expect(routeApplyAuto('https://www.naukri.com/job-listings-x')).toEqual({ kind: 'naukri_agent' });
    expect(routeApplyAuto('https://naukri.com/x')).toEqual({ kind: 'naukri_agent' });
  });

  it('does not match look-alikes, http or embedded credentials', () => {
    for (const url of [
      'https://evil-naukri.com/x',
      'https://naukri.com.evil.io/x',
      'http://naukri.com/x',
      'https://user:pw@naukri.com/x',
    ]) {
      expect(routeApplyAuto(url).kind).not.toBe('naukri_agent');
    }
  });
});

describe('apply tool dry run seam', () => {
  const saved = { db: process.env.JOBAPPLIER_DB, dry: process.env.SCHEDULER_DRY_RUN, jd: process.env.JOBBER_DRY_RUN };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apply-dry-'));
    process.env.JOBAPPLIER_DB = join(dir, 't.sqlite');
    delete process.env.SCHEDULER_DRY_RUN;
    delete process.env.JOBBER_DRY_RUN;
  });
  afterEach(() => {
    const restore: Array<[string, string | undefined]> = [
      ['JOBAPPLIER_DB', saved.db],
      ['SCHEDULER_DRY_RUN', saved.dry],
      ['JOBBER_DRY_RUN', saved.jd],
    ];
    for (const [k, v] of restore) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function rows(): Array<{ action: string; platform: string; payload: string }> {
    const db = openDb();
    try {
      return db.prepare('SELECT action, platform, payload FROM dry_run_actions').all() as never;
    } finally {
      db.close();
    }
  }

  it.each(['linkedin', 'greenhouse', 'lever', 'workday', 'ashby'])('%s tool returns dry_run and records a row', (platform) => {
    const r = dryRunApply(platform, { job_id: 'j1' });
    expect(r?.status).toBe('dry_run');
    const got = rows();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ action: 'apply', platform });
  });

  it('returns null when live', () => {
    process.env.SCHEDULER_DRY_RUN = 'false';
    expect(dryRunApply('lever', { job_id: 'j1' })).toBeNull();
    expect(rows()).toHaveLength(0);
  });

  it('apply.auto on a Naukri URL returns needs_agent and writes nothing, dry or live', async () => {
    const want = {
      status: 'needs_agent',
      platform: 'naukri',
      reason: 'naukri apply is agent-driven: dispatch the naukri-search worker or use naukri_open',
    };
    expect(await handleApplyAuto({ apply_url: 'https://www.naukri.com/job-listings-x', job_id: 'j1' })).toEqual(want);
    process.env.SCHEDULER_DRY_RUN = 'false';
    expect(await handleApplyAuto({ apply_url: 'https://www.naukri.com/job-listings-x', job_id: 'j1' })).toEqual(want);
    expect(rows()).toHaveLength(0);
  });

  it('apply.auto on another route in dry run records dry_run with the apply_url', async () => {
    const r = (await handleApplyAuto({ apply_url: 'https://jobs.lever.co/acme/1', job_id: 'j2' })) as { status: string };
    expect(r.status).toBe('dry_run');
    const got = rows();
    expect(got[0].platform).toBe('lever');
    expect(JSON.parse(got[0].payload)).toEqual({ job_id: 'j2', apply_url: 'https://jobs.lever.co/acme/1' });
  });
});
