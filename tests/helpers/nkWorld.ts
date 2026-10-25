// Shared setup for the Naukri engine tests: a db with one known recruiter thread and one naukri job, a fake
// page over invented HTML, the engine with the Naukri policy, and the arm deps. No real browser, no real send.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb, saveJob } from '../../src/db.js';
import { upsertPerson } from '../../src/outreach/people.js';
import { createEngine, type Engine } from '../../src/browserctl/act.js';
import { armNaukriApply, armNaukriMessage, type NaukriArmDeps } from '../../src/browserctl/arm/naukri.js';
import { IntentStore } from '../../src/browserctl/intent.js';
import { NAUKRI_POLICY } from '../../src/browserctl/policy.js';
import { loadOutreachConfig } from '../../src/outreach/config.js';
import { TUNING_DEFAULTS } from '../../src/outreach/tuning.js';
import { isDryRun } from '../../src/safety/dryRun.js';
import { gateOutbound, secretValuesFromEnv } from '../../src/safety/outputGate.js';
import type { ScreenVerdict } from '../../src/safety/screen.js';
import { setState } from '../../src/scheduler/runLog.js';
import { fakeBcPage, type FakeBc } from './fakeBc.js';

export const THREAD = 'thread-1';
export const THREAD_URL = `https://www.naukri.com/mnjuser/inbox?threadId=${THREAD}`;
export const JOB_URL = 'https://www.naukri.com/job-listings-software-engineer-acme-bengaluru-5-to-8-years-081026050522';
export const JOB_ID = 'naukri:081026050522';
export const NOW = new Date('2026-10-14T10:00:00Z'); // 15:30 IST
export const MSG = 'Hi Pat, happy to share more about my React work.';
export const LIVE_ENV: Record<string, string> = { JOBBER_DRY_RUN: 'false' };

export interface NkWorld {
  db: ReturnType<typeof openDb>;
  page: FakeBc;
  engine: Engine;
  intents: IntentStore;
  clock: { t: number };
  stopFile: string;
  env: NodeJS.ProcessEnv;
  armDeps: NaukriArmDeps;
  pid: number;
  armSend: (a?: Partial<Parameters<typeof armNaukriMessage>[1]>) => ReturnType<typeof armNaukriMessage>;
  armApply: (a?: { job_id: string }) => ReturnType<typeof armNaukriApply>;
  snap: () => Promise<string>;
  cleanup: () => void;
}

const okScreen = async (t: string): Promise<ScreenVerdict> => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' });

export function nkWorld(o: {
  html: string; url?: string; env?: Record<string, string>; screen?: (t: string, p: string) => Promise<ScreenVerdict>;
  seed?: boolean; screenshot?: boolean; layoutFeed?: (t: unknown) => void;
  checkText?: NaukriArmDeps['checkText']; style?: NaukriArmDeps['style'];
}): NkWorld {
  const dir = mkdtempSync(path.join(tmpdir(), 'nk-'));
  const env = { ...(o.env ?? {}) } as NodeJS.ProcessEnv;
  const db = openDb(':memory:');
  let pid = 0;
  if (o.seed !== false) {
    pid = upsertPerson(db, { platform: 'naukri', profileKey: 'naukri:pat-recruiter', name: 'Pat Recruiter', company: 'Acme', category: 'recruiter' });
    setState(db, `naukri_thread_${pid}`, THREAD, NOW);
    saveJob(db, {
      id: JOB_ID, source: 'naukri', title: 'Software Engineer', company: 'Acme', url: JOB_URL, apply_url: JOB_URL,
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
      recipientKey: 'naukri', expectedRecipientKey: 'naukri', allowedUrls: [], allowedEmails: [],
      secretValues: secretValuesFromEnv(env), factVerdict: 'pass',
    });
    return g.ok ? null : g.reasons.join(',');
  };
  const engine = createEngine({
    db, now: () => NOW, env, cfg: { dryRun: isDryRun(env), maxAcceptsPerDay: 0 }, policy: NAUKRI_POLICY,
    getPage: async () => page, intents, screen: screen as never, stopFile, textGate,
    screenshotEnabled: o.screenshot === true, paceMs: () => 0, settleMs: 0, confirmTimeoutMs: 50, diagDir: path.join(dir, 'diag'),
    ...(o.layoutFeed ? { layoutFeed: o.layoutFeed as never } : {}),
  });
  const armDeps: NaukriArmDeps = {
    engine, intents, db, now: () => NOW, env, cfg: loadOutreachConfig({}), screen: screen as never, stopFile,
    tuning: TUNING_DEFAULTS,
    checkText: o.checkText ?? (async (t) => ({ ok: true, normalized: t.trim(), verdict: 'pass' })),
    style: o.style ?? (() => ({ ok: true, hits: [] })),
  };
  return {
    db, page, engine, intents, clock, stopFile, env, armDeps, pid,
    armSend: (a = {}) => armNaukriMessage(armDeps, { person_id: pid, thread_ref: THREAD, text: MSG, kind: 'role_ask', ...a }),
    armApply: (a = { job_id: JOB_ID }) => armNaukriApply(armDeps, a),
    snap: async () => { const r = await engine.snapshot(); return r.state ?? `ERR ${r.code}`; },
    cleanup: () => { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A recruiter thread page: header name, one inbound message, the composer with its Send button. */
export const threadHtml = (o: { name?: string | null; text?: string; sent?: string; extra?: string } = {}): string => `<html><head><title>Inbox | Naukri</title></head><body><main>
${o.name === null ? '' : `<h2>${o.name ?? 'Pat Recruiter'}</h2>`}<p>Acme</p>
<ul><li><p>Hi, we have an opening for a React developer. Are you open to a chat?</p></li>${o.sent ? `<li><p>${o.sent}</p></li>` : ''}</ul>
${o.extra ?? ''}
<div class="chat-composer"><textarea placeholder="Type a message">${o.text ?? MSG}</textarea><button class="sendMsg">Send</button></div>
</main></body></html>`;

/** A naukri job page. `chat` adds the apply chatbot drawer; `body` is the posting text. */
export const jobHtml = (o: { chat?: boolean; answer?: string; body?: string; applied?: boolean; confirm?: string } = {}): string => `<html><head><title>Software Engineer - Acme | Naukri</title></head><body><main>
<h1>Software Engineer</h1><p>Acme</p><p>${o.body ?? 'Build React apps for Acme.'}</p>
<button id="save-job">Save job</button>${o.applied ? '<button>Applied</button>' : '<button id="apply-button">Apply</button>'}<button class="company-site-button">Apply on company site</button>
${o.confirm ? `<p>${o.confirm}</p>` : ''}
${o.chat ? `<div class="chatbot_Drawer"><ul><li><p>How many years of experience do you have in React?</p></li></ul>
<div contenteditable="true" data-placeholder="Type message here">${o.answer ?? ''}</div><button class="sendMsg">Save</button></div>` : ''}
</main></body></html>`;

/** The ref of the nth (default first) node with this role and exact name in a rendered state. */
export function refOf(state: string, role: string, name: string, nth = 0): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(name === '' ? `\\[(s\\d+\\.\\d+)\\] ${role}(?= value=| secret| disabled|$)` : `\\[(s\\d+\\.\\d+)\\] ${role} "${esc}"`, 'gm');
  const all = [...state.matchAll(re)].map((m) => m[1]);
  if (!all[nth]) throw new Error(`no ${role} "${name}" in state:\n${state}`);
  return all[nth];
}
