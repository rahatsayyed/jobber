import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { handleOpen } from '../src/applier/tools/open.js';
import { handleState, handleScreenshot, screenshotEnabled } from '../src/applier/tools/state.js';
import { SCREENED_SURFACES, callsScreen } from '../src/safety/screen.js';
import { makeApplier, type ApplierHarness, type HarnessOpts } from './helpers/applierHarness.js';

let h: ApplierHarness | null = null;
afterEach(async () => { await h?.close(); h = null; });
async function opened(o: HarnessOpts = {}): Promise<ApplierHarness> {
  h = makeApplier(o);
  await handleOpen({ job_id: 'job-1' }, h.deps);
  return h;
}

describe('apply_state screen', () => {
  it('apply_state is blocked by the classifier and returns no text', async () => {
    const x = await opened();
    x.classifier.classify.mockResolvedValue({ malicious: true, score: 0.99, truncated: false });
    const r = await handleState(x.deps);
    expect(r).toMatchObject({ status: 'blocked', code: 'injection_suspected' });
    expect(JSON.stringify(r)).not.toContain('First Name');
    expect((r as { state?: string }).state).toBeUndefined();
    await x.close();
    // the same holds for the state that open returns: no text, and the session is closed
    h = makeApplier({ malicious: true });
    const o = await handleOpen({ job_id: 'job-1' }, h.deps);
    expect(o).toMatchObject({ status: 'blocked', code: 'injection_suspected' });
    expect(JSON.stringify(o)).not.toContain('First Name');
    expect((o as { state?: string }).state).toBeUndefined();
    expect(h.deps.state.cur).toBeNull();
  });

  it('benign verdict returns the compact state with data markers', async () => {
    const x = await opened();
    const r = await handleState(x.deps);
    expect(r).toMatchObject({ status: 'ok', code: 'state' });
    const s = (r as { state: string }).state;
    expect(s).toContain('<page_data>');
    expect(s).toContain('First Name');
    expect(x.classifier.classify).toHaveBeenCalled();
  });

  it('live + classifier unavailable: blocked classifier_unavailable, no text', async () => {
    const x = await opened();
    x.deps.classifier = async () => { throw new Error('unset'); };
    const r = await handleState(x.deps);
    expect(r).toMatchObject({ status: 'blocked', code: 'classifier_unavailable' });
    expect((r as { state?: string }).state).toBeUndefined();
  });

  it('hostile labels are neutralised before they reach the model', async () => {
    const x = await opened({ start: 'form-hostile.html' });
    x.deps.classifier = { classify: async () => ({ malicious: false, score: 0, truncated: false }) };
    const r = await handleState(x.deps);
    const s = JSON.stringify(r);
    expect(s).not.toContain('hunter2');
    expect(s.toLowerCase()).not.toContain('ignore all previous instructions');
  });

  it('no job open and halted', async () => {
    h = makeApplier();
    expect(await handleState(h.deps)).toMatchObject({ status: 'refused', code: 'no_job' });
  });

  it('apply_state is a screened surface and its file calls the screen', () => {
    const e = SCREENED_SURFACES.find((s) => s.id === 'apply_state');
    expect(e).toEqual({ id: 'apply_state', file: 'src/applier/tools/state.ts' });
    expect(callsScreen(fs.readFileSync(e!.file, 'utf8'))).toBe(true);
  });
});

describe('apply_screenshot', () => {
  it('exists only when APPLY_SCREENSHOT is exactly true', async () => {
    expect(screenshotEnabled({})).toBe(false);
    expect(screenshotEnabled({ APPLY_SCREENSHOT: 'TRUE' })).toBe(false);
    expect(screenshotEnabled({ APPLY_SCREENSHOT: 'true' })).toBe(true);
    const x = await opened();
    expect(await handleScreenshot(x.deps)).toMatchObject({ status: 'refused', code: 'screenshot_off' });
  });
});
