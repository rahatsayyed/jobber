import { describe, expect, it } from 'vitest';
import { enqueueOutreach, openDb, saveJob } from '../src/db.js';
import { channelsFor } from '../src/lib/channels.js';
import { classifyApplyUrl } from '../src/apply/registry.js';
import { loadPortals } from '../src/sources/boards/filters.js';
import { loadRegistry } from '../src/sources/registry.js';
import { customSites } from '../src/scout/targets.js';
import { recordRun, sourceStatusPayload } from '../src/sources/status.js';

// Wellfound is an agent-tier custom site (no script provider, no dedicated MCP). Nothing here touches the network.
describe('wellfound config', () => {
  it('portals.json carries an enabled https custom entry on wellfound.com and the board loader skips it silently', () => {
    const sites = customSites().filter((s) => s.name === 'Wellfound');
    expect(sites).toHaveLength(1);
    expect(new URL(sites[0]!.url).protocol).toBe('https:');
    expect(new URL(sites[0]!.url).hostname).toBe('wellfound.com');
    const r = loadPortals();
    expect(r.error).toBeNull();
    expect((r.config?.tracked_companies ?? []).some((c) => c.name === 'Wellfound')).toBe(false);
    expect((r.warnings ?? []).filter((w) => w.includes('Wellfound'))).toEqual([]);
  });

  it('the registry row loads without errors', () => {
    const { platforms, errors } = loadRegistry();
    expect(errors).toEqual([]);
    expect(platforms.find((p) => p.id === 'wellfound')).toMatchObject({ kind: 'generated', tier: 'agent', provider: null, enabled: true, stability: 'unverified' });
  });

  it('source_status lists wellfound as an agent-tier generated row once it has a recorded run', () => {
    const db = openDb(':memory:');
    recordRun(db, 'wellfound', { fetched: 12, kept: 4, new: 4 });
    const row = sourceStatusPayload(db).rows.find((r) => r.source === 'wellfound');
    expect(row).toMatchObject({ source: 'wellfound', kind: 'agent', group: 'generated', fetched: 12, kept: 4, new: 4 });
  });
});

describe('a wellfound job is never an apply target', () => {
  const url = 'https://boards.greenhouse.io/acme/jobs/1';
  const item = (job_id: string, apply_platform: string | null) => ({
    job_id, resume_pdf_path: null, email_subject: 'S', email_body: 'B', email_to: 'a@b.co',
    connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform, apply_url: url,
  });

  it('classifyApplyUrl returns none for the bare id and for gen:custom, even on a Greenhouse URL', () => {
    for (const source of ['wellfound', 'gen:custom']) {
      expect(classifyApplyUrl(url, source, {} as NodeJS.ProcessEnv).platform, source).toBe('none');
      expect(classifyApplyUrl('https://wellfound.com/jobs/1', source, { APPLY_ALLOW_UNKNOWN_HOSTS: 'true' } as NodeJS.ProcessEnv).platform, source).toBe('none');
    }
  });

  it('channelsFor closes apply, and a gen:custom job is held for owner review', () => {
    expect(channelsFor({ source: 'wellfound', company: 'Acme', apply_url: url }).find((v) => v.channel === 'apply')?.eligible).toBe(false);
    for (const v of channelsFor({ source: 'gen:custom', company: 'Acme', apply_url: url })) {
      expect(v).toMatchObject({ eligible: false, reason: 'held_review' });
    }
  });

  it('enqueue_outreach stores apply_platform none whatever the preparer passed, and a gen:custom row is held', () => {
    const db = openDb(':memory:');
    for (const [id, source] of [['wf:1', 'wellfound'], ['wf:2', 'gen:custom']] as const) {
      saveJob(db, { id, source, title: 'Full Stack Engineer', company: 'Acme', url, apply_url: url, description: 'React' });
      enqueueOutreach(db, item(id, 'greenhouse'));
      const row = db.prepare('SELECT apply_platform, apply_tier, status FROM outreach_queue WHERE job_id = ?').get(id) as { apply_platform: string; apply_tier: string; status: string };
      expect(row.apply_platform, source).toBe('none');
      expect(row.apply_tier, source).toBe('never');
      if (source === 'gen:custom') expect(row.status).not.toBe('queued');
    }
  });
});
