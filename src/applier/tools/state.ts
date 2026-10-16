// apply_state: the compact, screened form model (plan 8G-2 task 18). Every page-derived string that
// reaches a model goes through screenUntrusted here; a blocked screen returns no page text at all.
import { z } from 'zod';
import { screenUntrusted, type ScreenVerdict } from '../../safety/screen.js';
import { isDryRun } from '../../safety/dryRun.js';
import { formatState } from '../../webcore/state.js';
import type { FormModel } from '../../webcore/formModel.js';
import { envOf, inPage, preflight, refuse, type ApplierDeps, type ApplyResult } from './common.js';

export const StateInput = z.object({}).strict();

const STATE_MAX_CHARS = 12000;

export async function screenText(raw: string, purpose: 'read' | 'send', deps: ApplierDeps, maxChars = STATE_MAX_CHARS): Promise<ScreenVerdict> {
  const env = envOf(deps);
  return screenUntrusted(raw, purpose, { env, dryRun: isDryRun(env, { web: true }), classifier: deps.classifier, maxChars });
}

/** The model's compact state, or the screen verdict that withheld it. */
export async function screenedState(model: FormModel, purpose: 'read' | 'send', deps: ApplierDeps): Promise<{ ok: true; state: string } | { ok: false; result: ApplyResult }> {
  const v = await screenText(formatState(model), purpose, deps);
  if (v.blocked) return { ok: false, result: { status: 'blocked', code: v.code } };
  return { ok: true, state: v.unscreened ? `${v.text}\nclassifier=unscreened` : v.text };
}

/** A page label for a needs_owner result: screened, or a fixed marker when the screen withholds it. */
export async function questionText(label: string, deps: ApplierDeps): Promise<string> {
  const v = await screenText(String(label ?? '').slice(0, 300), 'read', deps, 400);
  return v.blocked ? '[question withheld]' : v.text.replace(/\s+/g, ' ').trim();
}

export async function handleState(deps: ApplierDeps): Promise<ApplyResult> {
  return inPage(deps, async ({ job, model }) => {
    const s = await screenedState(model, 'read', deps);
    if (!s.ok) return s.result;
    return { status: 'ok', code: 'state', platform: job.platform, host: job.host, state: s.state };
  });
}

// ---- apply_screenshot: exists only when APPLY_SCREENSHOT is exactly true; pixels are NOT screened ----

export const ScreenshotInput = z.object({}).strict();
export const screenshotEnabled = (env: NodeJS.ProcessEnv): boolean => env.APPLY_SCREENSHOT === 'true';

export interface ScreenshotResult extends ApplyResult { png_base64?: string }

export async function handleScreenshot(deps: ApplierDeps): Promise<ScreenshotResult> {
  if (!screenshotEnabled(envOf(deps))) return refuse('screenshot_off', 'APPLY_SCREENSHOT is not true');
  const g = preflight(deps);
  if (g) return g;
  if (!deps.state.cur) return refuse('no_job', 'call apply_open first');
  try {
    return await deps.runtime.serial(async (): Promise<ScreenshotResult> => {
      const page = deps.runtime.page();
      if (!page) return refuse('no_session', 'the page is closed; call apply_open again');
      const png = await page.screenshot({ type: 'png' });
      return { status: 'ok', code: 'screenshot', png_base64: Buffer.from(png).toString('base64') };
    });
  } catch {
    console.error('[applier] screenshot failed');
    return { status: 'failed', code: 'error', reason: 'page interaction failed' };
  }
}
