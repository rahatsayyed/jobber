import { afterEach, describe, expect, it } from 'vitest';
import { ESCALATE_REASONS, EscalateInput, handleEscalate } from '../src/applier/escalate.js';
import { handleOpen } from '../src/applier/tools/open.js';
import { handleFill } from '../src/applier/tools/fill.js';
import { listOpenEscalations } from '../src/outreach/service.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { count, makeApplier, WHY, type ApplierHarness, type HarnessOpts } from './helpers/applierHarness.js';

let h: ApplierHarness | null = null;
afterEach(async () => { await h?.close(); h = null; });

const notices: Array<{ title: string; detail?: string }> = [];
const x = () => ({ notify: (n: { title: string; detail?: string }) => { notices.push(n); }, styleCfg: DEFAULT_STYLE_CONFIG, runId: 'run-a' });
const esc = (hh: ApplierHarness, reason: (typeof ESCALATE_REASONS)[number], detail?: string) =>
  handleEscalate({ job_id: 'job-1', reason, ...(detail ? { detail } : {}) }, hh.deps, x());

async function opened(o: HarnessOpts = {}): Promise<ApplierHarness> {
  h = makeApplier(o);
  await handleOpen({ job_id: 'job-1' }, h.deps);
  return h;
}

describe('apply_escalate', () => {
  it('each reason writes exactly one escalation', async () => {
    for (const reason of ESCALATE_REASONS) {
      notices.length = 0;
      const hh = await opened();
      const r = await esc(hh, reason);
      expect(r, reason).toMatchObject({ status: 'needs_owner', code: 'escalated' });
      expect(count(hh.db, "SELECT COUNT(*) AS n FROM escalations WHERE platform = 'apply'"), reason).toBe(1);
      expect(listOpenEscalations(hh.db, 5)[0].reason).toBe(`apply:${reason}`);
      expect(notices.length, reason).toBe(1);
      expect(hh.db.prepare('SELECT apply_status FROM outreach_queue WHERE job_id = ?').get('job-1')).toEqual({ apply_status: 'needs_owner' });
      // the same call again writes nothing
      expect(await esc(hh, reason)).toMatchObject({ status: 'needs_owner', code: 'already_escalated' });
      expect(count(hh.db, "SELECT COUNT(*) AS n FROM escalations WHERE platform = 'apply'")).toBe(1);
      await hh.close(); h = null;
    }
  });

  it('only the closed reasons and a 100 char note are accepted', () => {
    expect(EscalateInput.safeParse({ job_id: 'job-1', reason: 'because' }).success).toBe(false);
    expect(EscalateInput.safeParse({ job_id: 'job-1', reason: 'other', detail: 'x'.repeat(101) }).success).toBe(false);
    expect(EscalateInput.safeParse({ job_id: 'job-1', reason: 'other', value: 'v' }).success).toBe(false);
  });

  it('captcha fixture ends needs_owner with nothing typed after', async () => {
    const hh = await opened();
    const r = await esc(hh, 'captcha');
    expect(r).toMatchObject({ status: 'needs_owner', code: 'escalated' });
    expect(hh.deps.state.cur).toBeNull();
    // nothing can be typed any more, and the job is not opened again in this run
    const f = await handleFill({ field: 'f1', ref: { kind: 'profile', field: 'name.first' } }, hh.deps);
    expect(f).toMatchObject({ status: 'refused', code: 'no_job' });
    expect(hh.site.fills.length).toBe(0);
    expect(await handleOpen({ job_id: 'job-1' }, hh.deps)).toMatchObject({ status: 'refused', code: 'escalated_this_run' });
    // a block reason is recorded against the host
    expect(count(hh.db, "SELECT COUNT(*) AS n FROM apply_host_blocks WHERE kind = 'captcha'")).toBe(1);
  });

  it('a captcha wall at open is blocked, and escalating it afterwards types nothing', async () => {
    const hh = await opened({ start: 'captcha-wall.html' });
    expect(hh.deps.state.cur).toBeNull();
    const r = await esc(hh, 'captcha');
    expect(r).toMatchObject({ status: 'needs_owner', code: 'escalated' });
    expect(hh.site.fills.length).toBe(0);
  });

  it('the note passes the style gate or is dropped; the escalation is still written', async () => {
    const hh = await opened();
    const r = await esc(hh, 'question', 'needs a salary figure — ask the owner');
    expect(r).toMatchObject({ status: 'needs_owner', code: 'escalated' });
    expect(r.reason).toContain('dropped');
    const row = listOpenEscalations(hh.db, 5)[0];
    expect(row.detail).not.toContain('salary');
    await hh.close(); h = null;
    const h2 = await opened();
    await esc(h2, 'question', 'needs a salary figure');
    expect(listOpenEscalations(h2.db, 5)[0].detail).toContain('note: needs a salary figure');
  });

  it('a blocked screen withholds the page text but still escalates', async () => {
    const hh = await opened();
    hh.classifier.classify.mockResolvedValue({ malicious: true, score: 0.99, truncated: false });
    // escalations are never dropped: the 'escalate' purpose does not require the classifier, a verdict still withholds text
    const r = await esc(hh, 'drift');
    expect(r).toMatchObject({ status: 'needs_owner', code: 'escalated' });
    expect(listOpenEscalations(hh.db, 5)[0].detail).not.toContain('First Name');
  });

  it('no canary secret or answer value appears in any result', async () => {
    const hh = await opened();
    const results = [
      await esc(hh, 'question', 'CANARY-NOTE-91'),
      await handleEscalate({ job_id: 'job-1', reason: 'other' }, hh.deps, x()),
      await handleEscalate({ job_id: 'no-such', reason: 'other' }, hh.deps, x()),
    ];
    const text = JSON.stringify(results);
    expect(text).not.toContain(WHY);
    expect(text).not.toContain('CANARY-NOTE-91');
    expect(text).not.toContain('First Name');
    expect(results[2]).toMatchObject({ status: 'refused', code: 'unknown_job' });
  });
});
