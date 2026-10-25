// Shared setup for the Wellfound engine tests: a db with one known founder thread and one wellfound job, a fake
// page over invented HTML, the engine with the Wellfound policy, and the arm deps. No real browser, no real send.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, saveJob } from '../../src/db.js';
import { upsertPerson } from '../../src/outreach/people.js';
import { createEngine, type Engine } from '../../src/browserctl/act.js';
import { armWellfoundApply, armWellfoundMessage, type WellfoundArmDeps } from '../../src/browserctl/arm/wellfound.js';
import { IntentStore } from '../../src/browserctl/intent.js';
import { WELLFOUND_POLICY } from '../../src/browserctl/policy.js';
import { loadOutreachConfig } from '../../src/outreach/config.js';
import { TUNING_DEFAULTS } from '../../src/outreach/tuning.js';
import { isDryRun } from '../../src/safety/dryRun.js';
import { gateOutbound, secretValuesFromEnv } from '../../src/safety/outputGate.js';
import type { ScreenVerdict } from '../../src/safety/screen.js';
import { setState } from '../../src/scheduler/runLog.js';
import { fakeBcPage, type FakeBc } from './fakeBc.js';

export const THREAD = 'thread-1';
export const THREAD_URL = `https://wellfound.com/jobs/messages/${THREAD}`;
export const JOB_URL = 'https://wellfound.com/jobs/3187261-full-stack-engineer';
export const JOB_ID = 'wellfound:3187261';
export const NOW = new Date('2026-10-14T10:00:00Z'); // 15:30 IST
export const MSG = 'Hi Pat, happy to share more about my React work.';
export const NOTE = 'I build React and TypeScript products and would like to help Acme ship faster.';
export const LIVE_ENV: Record<string, string> = { JOBBER_DRY_RUN: 'false' };

export interface WfWorld {
  db: ReturnType<typeof openDb>;
  page: FakeBc;
  engine: Engine;
  intents: IntentStore;
  clock: { t: number };
  stopFile: string;
  env: NodeJS.ProcessEnv;
  armDeps: WellfoundArmDeps;
  pid: number;
  armSend: (a?: Partial<Parameters<typeof armWellfoundMessage>[1]>) => ReturnType<typeof armWellfoundMessage>;
  armApply: (a?: { job_id: string; note?: string }) => ReturnType<typeof armWellfoundApply>;
  snap: () => Promise<string>;
  cleanup: () => void;
}

const okScreen = async (t: string): Promise<ScreenVerdict> => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' });

export function wfWorld(o: {
  html: string; url?: string; env?: Record<string, string>; screen?: (t: string, p: string) => Promise<ScreenVerdict>;
  seed?: boolean; screenshot?: boolean; layoutFeed?: (t: unknown) => void;
  checkText?: WellfoundArmDeps['checkText']; style?: WellfoundArmDeps['style'];
}): WfWorld {
  const dir = mkdtempSync(path.join(tmpdir(), 'wf-'));
  const env = { ...(o.env ?? {}) } as NodeJS.ProcessEnv;
  const db = openDb(':memory:');
  let pid = 0;
  if (o.seed !== false) {
    pid = upsertPerson(db, { platform: 'wellfound', profileKey: 'wellfound:pat-founder', name: 'Pat Founder', company: 'Acme', category: 'recruiter' });
    setState(db, `wellfound_thread_${pid}`, THREAD, NOW);
    saveJob(db, {
      id: JOB_ID, source: 'wellfound', title: 'Full Stack Engineer', company: 'Acme', url: JOB_URL, apply_url: JOB_URL,
      description: 'Build React apps for Acme.',
    });
  }
  const page = fakeBcPage(o.html, o.url ?? THREAD_URL);
  const clock = { t: NOW.getTime() };
  const intents = new IntentStore(() => clock.t);
  const stopFile = path.join(dir, 'STOP');
  const screen = o.screen ?? okScreen;
  const textGate = (text: string): string | null => {
    const g = gateOutbound(text, {
      recipientKey: 'wellfound', expectedRecipientKey: 'wellfound', allowedUrls: [], allowedEmails: [],
      secretValues: secretValuesFromEnv(env), factVerdict: 'pass',
    });
    return g.ok ? null : g.reasons.join(',');
  };
  const engine = createEngine({
    db, now: () => NOW, env, cfg: { dryRun: isDryRun(env), maxAcceptsPerDay: 0 }, policy: WELLFOUND_POLICY,
    getPage: async () => page, intents, screen: screen as never, stopFile, textGate,
    screenshotEnabled: o.screenshot === true, paceMs: () => 0, settleMs: 0, confirmTimeoutMs: 50, diagDir: path.join(dir, 'diag'),
    ...(o.layoutFeed ? { layoutFeed: o.layoutFeed as never } : {}),
  });
  const armDeps: WellfoundArmDeps = {
    engine, intents, db, now: () => NOW, env, cfg: loadOutreachConfig({}), screen: screen as never, stopFile,
    tuning: TUNING_DEFAULTS,
    checkText: o.checkText ?? (async (t) => ({ ok: true, normalized: t.trim(), verdict: 'pass' })),
    style: o.style ?? (() => ({ ok: true, hits: [] })),
  };
  return {
    db, page, engine, intents, clock, stopFile, env, armDeps, pid,
    armSend: (a = {}) => armWellfoundMessage(armDeps, { person_id: pid, thread_ref: THREAD, text: MSG, kind: 'role_ask', ...a }),
    armApply: (a = { job_id: JOB_ID }) => armWellfoundApply(armDeps, a),
    snap: async () => { const r = await engine.snapshot(); return r.state ?? `ERR ${r.code}`; },
    cleanup: () => { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A founder thread page: header name, one inbound message, the composer with its Send button. */
export const threadHtml = (o: { name?: string | null; text?: string; sent?: string; extra?: string } = {}): string => `<html><head><title>Messages | Wellfound</title></head><body><main>
${o.name === null ? '' : `<h2>${o.name ?? 'Pat Founder'}</h2>`}<p>Acme</p>
<ul><li><p>Hi, we are hiring a React engineer. Open to a chat?</p></li>${o.sent ? `<li><p>${o.sent}</p></li>` : ''}</ul>
${o.extra ?? ''}
<div class="chat-composer"><textarea placeholder="Write a message">${o.text ?? MSG}</textarea><button>Send</button></div>
</main></body></html>`;

/**
 * A wellfound job page. `form` adds the open application dialog with the note field; `note` is the field value;
 * `confirm` adds a confirmation sentence; `applied` swaps Apply for an Applied control.
 */
export const jobHtml = (o: { form?: boolean; note?: string; body?: string; applied?: boolean; confirm?: string; extra?: string } = {}): string => `<html><head><title>Full Stack Engineer at Acme | Wellfound</title></head><body><main>
<h1>Full Stack Engineer</h1><p>Acme</p><p>${o.body ?? 'Build React apps for Acme.'}</p>
<button>Save</button>${o.applied ? '<button>Applied</button>' : '<button>Apply</button>'}<a href="https://acme.example/careers">Apply on company site</a>
${o.confirm ? `<p>${o.confirm}</p>` : ''}
${o.extra ?? ''}
${o.form ? `<dialog open aria-label="Apply to Acme"><h3>Apply to Acme</h3><textarea placeholder="Write a note to the team">${o.note ?? ''}</textarea><footer><button>Cancel</button><button>Submit application</button></footer></dialog>` : ''}
</main></body></html>`;

/** The ref of the nth (default first) node with this role and exact name in a rendered state. */
export function refOf(state: string, role: string, name: string, nth = 0): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(name === '' ? `\\[(s\\d+\\.\\d+)\\] ${role}(?= value=| secret| disabled|$)` : `\\[(s\\d+\\.\\d+)\\] ${role} "${esc}"`, 'gm');
  const all = [...state.matchAll(re)].map((m) => m[1]);
  if (!all[nth]) throw new Error(`no ${role} "${name}" in state:\n${state}`);
  return all[nth];
}
