import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enqueueOutreach, openDb, saveJob } from '../src/db.js';
import { loadOutreachConfig } from '../src/outreach/config.js';
import { LINKEDIN_POLICY } from '../src/browserctl/policy.js';
import { createExternalState, resolveExternalApply, type ExternalDeps } from '../src/browserctl/externalApply.js';
import type { OverlayInfo } from '../src/browserctl/overlay.js';
import type { RawNode, RawTree } from '../src/browserctl/snapshot.js';

const PAGE = 'https://www.linkedin.com/jobs/view/4389741719/';
const JOB = 'li-job:4389741719';
const node = (o: Partial<RawNode>): RawNode => ({ n: 1, role: 'button', name: '', text: '', disabled: false, ...o });

const SHARE: OverlayInfo = {
  title: 'Share your profile?', text: 'The employer will see your profile', source: 'tree',
  buttons: [{ name: 'Dismiss', ref: 's4.101' }, { name: 'Test User', ref: 's4.102' }, { name: 'Continue', ref: 's4.103' }],
};

/** `overlay` is what the engine reports after each Apply click that found no popup (null: no dialog). */
function setup(overlay: () => OverlayInfo | null, opts: { popupWhen?: () => string | null } = {}) {
  const db = openDb(':memory:');
  saveJob(db, { id: JOB, source: 'linkedin', title: 'Full Stack Developer', company: 'Acme', url: PAGE, apply_url: PAGE, description: 'd', posted_at: null } as never);
  enqueueOutreach(db, { job_id: JOB, resume_pdf_path: '/x.pdf', email_subject: null, email_body: null, email_to: null, connect_note: null, connect_profile_url: null, connect_category: null, connect_company: null, apply_platform: 'linkedin', apply_tier: 'agent', apply_url: PAGE, resume_json: '{}' } as never);
  db.prepare("UPDATE outreach_queue SET apply_status = 'manual_review'").run();
  const clicks: string[] = [];
  const page = {
    url: () => PAGE,
    waitMs: async () => undefined,
    clickNode: async (n: number) => { clicks.push(`c${n}`); },
    diag: async () => null,
    goto: async () => undefined,
    watch: () => ({ popups: () => { const u = opts.popupWhen?.(); return u ? [{ url: u }] : []; }, responses: () => [], adopt: async () => false, closePopups: async () => undefined, stop: () => undefined }),
  };
  const t: RawTree = { url: PAGE, title: 't', nodes: [node({ n: 5, name: 'Apply on company website' })] };
  const engine = {
    page: async () => page, peek: async () => ({ ok: true, code: 'ok' }), lastTree: () => t, refs: { epoch: 1 },
    overlayState: async () => { const o = overlay(); return o ? { ok: false, code: o.human ? 'overlay_needs_human' : 'blocked_by_overlay', overlay: o } : { ok: true, code: 'no_overlay' }; },
  };
  const env = {} as NodeJS.ProcessEnv;
  const deps: ExternalDeps = {
    engine: engine as never, db, now: () => new Date('2026-11-12T10:00:00Z'), env, cfg: loadOutreachConfig(env), policy: LINKEDIN_POLICY,
    screen: async (text) => ({ blocked: false, unscreened: false, text, flags: [], code: 'ok' }) as never,
    state: createExternalState(), stopFile: join(mkdtempSync(join(tmpdir(), 'ext-')), 'STOP'), diagDir: mkdtempSync(join(tmpdir(), 'diag-')),
    sleep: async () => undefined, random: () => 0, popupWaitMs: 1000, popupPollMs: 500,
  };
  return { db, deps, clicks };
}
const row = (db: ReturnType<typeof openDb>) => db.prepare('SELECT apply_platform p, apply_url u, apply_status s, apply_note n FROM outreach_queue').get() as { p: string; u: string | null; s: string | null; n: string | null };

describe('linkedin_resolve_external with a blocking overlay', () => {
  it('Share your profile? comes back as blocked_by_overlay with the dialog and its refs; code clicks nothing more', async () => {
    const s = setup(() => SHARE);
    const r = await resolveExternalApply(s.deps, 'linkedin', { job_id: JOB });
    expect(r).toMatchObject({ status: 'blocked_by_overlay', code: 'blocked_by_overlay' });
    expect(r.overlay).toEqual({ title: 'Share your profile?', text: 'The employer will see your profile', buttons: SHARE.buttons });
    expect(r.reason).toContain('Share your profile?');
    expect(r.reason).toContain('Dismiss | Test User | Continue');
    expect(s.clicks).toEqual(['c5']);
    // the row carries the reason until a later resolve succeeds
    expect(row(s.db)).toMatchObject({ s: 'manual_review', n: 'external:blocked_by_overlay:share_your_profile' });
  });
  it('after the operator dismissed the dialog, resolving again continues the popup route', async () => {
    let dismissed = false;
    const s = setup(() => (dismissed ? null : SHARE), { popupWhen: () => (dismissed ? 'https://boards.greenhouse.io/acme/jobs/9' : null) });
    expect((await resolveExternalApply(s.deps, 'linkedin', { job_id: JOB })).status).toBe('blocked_by_overlay');
    dismissed = true; // the operator clicked Dismiss by ref
    const r = await resolveExternalApply(s.deps, 'linkedin', { job_id: JOB });
    expect(r).toMatchObject({ status: 'resolved', platform: 'greenhouse' });
    expect(row(s.db)).toMatchObject({ u: 'https://boards.greenhouse.io/acme/jobs/9' });
    expect(JSON.stringify(r)).not.toContain('greenhouse.io');
  });
  it('no dialog and no popup keeps the old code (no_popup)', async () => {
    const s = setup(() => null);
    expect(await resolveExternalApply(s.deps, 'linkedin', { job_id: JOB })).toMatchObject({ status: 'manual_review', code: 'no_popup' });
  });
  it('a captcha dialog parks for the owner with the reason and title', async () => {
    const s = setup(() => ({ title: 'Quick security check', text: 'captcha', source: 'tree', buttons: [{ name: 'Verify', ref: 's4.9' }], human: { rule: 'captcha', reason: 'captcha' } }));
    const r = await resolveExternalApply(s.deps, 'linkedin', { job_id: JOB });
    expect(r).toMatchObject({ status: 'manual_review', code: 'overlay_needs_human:captcha' });
    expect(r.reason).toContain('Quick security check');
    expect(row(s.db).n).toBe('external:overlay_needs_human:captcha');
    expect(s.clicks).toEqual(['c5']);
  });
});
