// Naukri apply click robustness: the post-click wait (confirmation by Applied control, disabled control,
// toast, chatbot, popup or a 2xx apply response), the apply_click_ignored result and the extended diag.
// Fake page over invented HTML; nothing is really applied.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { countSince } from '../src/outreach/limits.js';
import type { BcWatch } from '../src/browserctl/driver.js';
import { JOB_ID, JOB_URL, LIVE_ENV, jobHtml, nkWorld, refOf, type NkWorld } from './helpers/nkWorld.js';

const worlds: NkWorld[] = [];
const mk = (o: Parameters<typeof nkWorld>[0]) => { const w = nkWorld(o); worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });
const clicks = (w: NkWorld) => w.page.log.filter((l) => l.startsWith('click'));
const applyCount = (w: NkWorld) => countSince(w.db, 'naukri_apply' as never, new Date(0));
const appliedRows = (w: NkWorld) => w.db.prepare("SELECT status FROM applications WHERE job_id = ?").all(JOB_ID);
const diagOf = (reason: string | undefined): Record<string, unknown> => {
  const m = /\(diag: (.+)\)$/.exec(reason ?? '');
  expect(m, reason).toBeTruthy();
  return JSON.parse(readFileSync(m![1], 'utf8'));
};

function fakeWatch(o: { popups?: { url: string }[]; responses?: { path: string; status: number }[]; adopt?: (i: number) => void } = {}): { w: BcWatch; stopped: () => boolean; adopted: number[] } {
  let stopped = false;
  const adopted: number[] = [];
  return {
    w: {
      popups: () => o.popups ?? [], responses: () => o.responses ?? [],
      async adopt(i) { adopted.push(i); o.adopt?.(i); return true; }, stop: () => { stopped = true; },
    },
    stopped: () => stopped, adopted,
  };
}

async function armedClick(w: NkWorld) {
  expect((await w.armApply()).status).toBe('armed');
  return w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
}

describe('naukri apply click: confirmation signals within the wait', () => {
  it('the Apply control turning Applied after a few polls counts as applied, recorded once', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV, confirmMs: 8000 });
    let waits = 0;
    w.page.waitMs = async () => { waits++; if (waits === 3) w.page.setHtml(jobHtml({ applied: true })); };
    w.page.responseOk = false;
    const r = await armedClick(w);
    expect(r).toMatchObject({ ok: true, status: 'sent', code: 'applied' });
    expect(appliedRows(w)).toEqual([{ status: 'submitted' }]);
    expect(applyCount(w)).toBe(1);
  });

  it('a disabled Apply control counts as applied', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    w.page.onAct = (x) => x.startsWith('click') && w.page.setHtml(jobHtml().replace('<button id="apply-button">', '<button id="apply-button" disabled>'));
    expect(await armedClick(w)).toMatchObject({ ok: true, status: 'sent' });
  });

  it('a new toast mentioning applied counts, a lazy "people also applied" line does not', async () => {
    const a = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    a.page.onAct = (w) => { if (w.startsWith('click')) a.page.setHtml(jobHtml({ confirm: 'You have Applied' })); };
    expect(await armedClick(a)).toMatchObject({ ok: true, status: 'sent' });
    const b = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    b.page.onAct = (w) => w.startsWith('click') && b.page.setHtml(jobHtml({ confirm: 'People also applied to these jobs' }));
    expect(await armedClick(b)).toMatchObject({ ok: false, code: 'apply_click_ignored' });
  });

  it('a 2xx apply response counts, a failing one does not', async () => {
    const a = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    const fa = fakeWatch({ responses: [{ path: '/cloudgateway/v2/apply', status: 200 }] });
    a.page.watch = () => fa.w;
    expect(await armedClick(a)).toMatchObject({ ok: true, status: 'sent', code: 'applied' });
    expect(fa.stopped()).toBe(true);
    const b = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    b.page.watch = () => fakeWatch({ responses: [{ path: '/cloudgateway/v2/apply', status: 500 }] }).w;
    expect((await armedClick(b)).code).toBe('apply_click_ignored');
  });

  it('an off-site popup is manual_review, never adopted or typed into', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    const f = fakeWatch({ popups: [{ url: 'https://boards.greenhouse.io/acme/jobs/1?gh_src=x' }] });
    w.page.watch = () => f.w;
    const r = await armedClick(w);
    expect(r).toMatchObject({ ok: false, status: 'manual_review', code: 'external_apply' });
    expect(f.adopted).toEqual([]);
    expect(appliedRows(w)).toEqual([]);
    expect(w.intents.peek('naukri')).toBeNull();
    const d = diagOf(r.reason) as { popups: { path: string; host_kind: string }[] };
    expect(d.popups).toEqual([{ path: '/acme/jobs/1', host_kind: 'external' }]);
  });

  it('a naukri.com popup with a chatbot is followed and its steps are not job_mismatch', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    const f = fakeWatch({
      popups: [{ url: 'https://www.naukri.com/mnjuser/questionnaire?id=1' }],
      adopt: () => { w.page.currentUrl = 'https://www.naukri.com/mnjuser/questionnaire?id=1'; w.page.setHtml(jobHtml({ chat: true })); },
    });
    w.page.watch = () => f.w;
    const r = await armedClick(w);
    expect(r).toMatchObject({ ok: true, code: 'chatbot_opened' });
    expect(f.adopted).toEqual([0]);
    expect(w.intents.peek('naukri')).toMatchObject({ class: 'naukri_apply' });
    const step = await w.engine.click(refOf(await w.snap(), 'button', 'Save'));
    expect(step.code).not.toBe('job_mismatch');
  });

  it('a blank popup that never loads does not confirm anything', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    w.page.watch = () => fakeWatch({ popups: [{ url: 'about:blank' }] }).w;
    const r = await armedClick(w);
    expect(r).toMatchObject({ ok: false, status: 'unconfirmed', code: 'unconfirmed' });
    expect(appliedRows(w)).toEqual([]);
  });
});

describe('naukri apply click: ignored click', () => {
  it('the same enabled Apply after the wait is apply_click_ignored, with a diag; no retry for the job', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    w.page.watch = () => fakeWatch({ responses: [{ path: '/x/applystatus?token=abc', status: 404 }] }).w;
    const r = await armedClick(w);
    expect(r).toMatchObject({ ok: false, status: 'unconfirmed', code: 'apply_click_ignored' });
    expect(applyCount(w)).toBe(1);
    expect(appliedRows(w)).toEqual([]);
    expect(w.intents.peek('naukri')).toBeNull();
    const d = diagOf(r.reason) as { code: string; apply_responses: { path: string; status: number }[]; near_buttons: string[]; popups: unknown[] };
    expect(d.code).toBe('apply_click_ignored');
    expect(d.apply_responses).toEqual([{ path: '/x/applystatus', status: 404 }]);
    expect(d.popups).toEqual([]);
    expect(d.near_buttons).toContain('Apply');
    expect(d.near_buttons.length).toBeLessThanOrEqual(10);

    const before = clicks(w).length;
    expect((await w.armApply()).status).toBe('armed');
    const again = await w.engine.click(refOf(await w.snap(), 'button', 'Apply'));
    expect(again.code).toBe('apply_click_ignored');
    expect(clicks(w).length).toBe(before);
    expect(applyCount(w)).toBe(1);
  });
});

describe('naukri apply click: pointer click', () => {
  it('uses robustClick for the Apply control and consumes the counters once', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    const seen: number[] = [];
    w.page.robustClick = async (n) => { seen.push(n); w.page.setHtml(jobHtml({ applied: true })); };
    const r = await armedClick(w);
    expect(r).toMatchObject({ ok: true, status: 'sent' });
    expect(seen.length).toBe(1);
    expect(clicks(w)).toEqual([]);
    expect(applyCount(w)).toBe(1);
  });

  it('a throw inside the click is unconfirmed, counters stay spent, intent disarmed', async () => {
    const w = mk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    w.page.robustClick = async () => { throw new Error('boom'); };
    const r = await armedClick(w);
    expect(r).toMatchObject({ ok: false, status: 'unconfirmed', code: 'unconfirmed' });
    expect(applyCount(w)).toBe(1);
    expect(w.intents.peek('naukri')).toBeNull();
  });
});
