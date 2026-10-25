// Shared setup for the browserctl engine tests: db with one known person, fake page, engine and arm deps.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/db.js';
import { upsertPerson } from '../../src/outreach/people.js';
import { createEngine, type Engine } from '../../src/browserctl/act.js';
import { armLinkedinSend, type ArmDeps } from '../../src/browserctl/arm/linkedin.js';
import { IntentStore } from '../../src/browserctl/intent.js';
import { loadLinkedinConfig } from '../../src/linkedin/config.js';
import { profileKeyOf } from '../../src/linkedin/urls.js';
import { DEFAULT_STYLE_CONFIG } from '../../src/safety/styleGate.js';
import type { ScreenVerdict } from '../../src/safety/screen.js';
import type { BcPage } from '../../src/browserctl/driver.js';
import { fakeBcPage, type FakeBc } from './fakeBc.js';

export const URL_ = 'https://www.linkedin.com/in/jane-example/';
export const NOW = new Date('2026-10-14T10:00:00Z'); // 15:30 IST
export const NOTE = 'Hi Jane, I saw the platform team is hiring and would like to connect.';
export const MSG = 'Hi Jane, I saw the platform team is hiring. Would you be open to a short chat about the role?';
export const LIVE_ENV: Record<string, string> = { JOBBER_DRY_RUN: 'false' };

export interface World {
  db: ReturnType<typeof openDb>;
  page: FakeBc;
  engine: Engine;
  intents: IntentStore;
  clock: { t: number };
  stopFile: string;
  env: NodeJS.ProcessEnv;
  armDeps: ArmDeps;
  arm: (a: Parameters<typeof armLinkedinSend>[1]) => ReturnType<typeof armLinkedinSend>;
  snap: () => Promise<string>;
  cleanup: () => void;
}

const okScreen = async (t: string): Promise<ScreenVerdict> => ({ blocked: false, unscreened: false, text: t, flags: [], code: 'ok' });

export function world(o: {
  html: string; url?: string; env?: Record<string, string>; screen?: (t: string, p: string) => Promise<ScreenVerdict>;
  seed?: boolean; screenshot?: boolean; layoutFeed?: (t: unknown) => void;
  /** Wrap the fake page (e.g. the locator dialog layer) before the engine uses it; World.page stays the fake. */
  wrapPage?: (p: FakeBc) => BcPage;
}): World {
  const dir = mkdtempSync(path.join(tmpdir(), 'bc-'));
  const env = { ...(o.env ?? {}) } as NodeJS.ProcessEnv;
  const db = openDb(':memory:');
  if (o.seed !== false) {
    upsertPerson(db, { platform: 'linkedin', profileKey: profileKeyOf(URL_), name: 'Jane Example', headline: 'Technical Recruiter at Acme', company: 'Acme', category: 'recruiter' });
  }
  const page = fakeBcPage(o.html, o.url ?? URL_);
  const bcPage: BcPage = o.wrapPage ? o.wrapPage(page) : page;
  const clock = { t: NOW.getTime() };
  const intents = new IntentStore(() => clock.t);
  const stopFile = path.join(dir, 'STOP');
  const cfg = loadLinkedinConfig(env);
  const screen = o.screen ?? okScreen;
  const engine = createEngine({
    db, now: () => NOW, env, cfg, getPage: async () => bcPage, intents, screen: screen as never, stopFile,
    screenshotEnabled: o.screenshot === true, paceMs: () => 0, settleMs: 0, confirmTimeoutMs: 50, diagDir: path.join(dir, 'diag'),
    ...(o.layoutFeed ? { layoutFeed: o.layoutFeed as never } : {}),
  });
  const armDeps: ArmDeps = {
    engine, intents, db, now: () => NOW, env, cfg, screen: screen as never, stopFile,
    factCheck: (text) => ({ verdict: 'pass', normalized_text: text }), styleCfg: DEFAULT_STYLE_CONFIG,
  };
  return {
    db, page, engine, intents, clock, stopFile, env, armDeps,
    arm: (a) => armLinkedinSend(armDeps, a),
    snap: async () => { const r = await engine.snapshot(); return r.state ?? `ERR ${r.code}`; },
    cleanup: () => { rmSync(dir, { recursive: true, force: true }); },
  };
}

/** The ref of the nth (default first) node with this role and exact name in a rendered state. */
export function refOf(state: string, role: string, name: string, nth = 0): string {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(name === '' ? `\\[(s\\d+\\.\\d+)\\] ${role}(?= value=| secret| disabled|$)` : `\\[(s\\d+\\.\\d+)\\] ${role} "${esc}"`, 'gm');
  const all = [...state.matchAll(re)].map((m) => m[1]);
  if (!all[nth]) throw new Error(`no ${role} "${name}" in state:\n${state}`);
  return all[nth];
}

export const profileHtml = (o: { status?: 'not_connected' | 'connected'; dialog?: string; extra?: string; title?: string } = {}): string => `<html><head><title>${o.title ?? 'Jane Example | LinkedIn'}</title></head><body><main>
<h1>Jane Example</h1><p>${o.status === 'connected' ? '· 1st' : '· 3rd'}</p><p>Technical Recruiter at Acme</p>
${o.status === 'connected' ? '' : '<button>Connect</button>'}<button>Message</button><button>More</button><button>Follow</button>
${o.extra ?? ''}
${o.dialog ?? ''}
</main></body></html>`;

export const inviteDialog = (o: { name?: string | null; note?: string } = {}): string => `<dialog open aria-label="Add a note">
<h2>Add a note to your invitation?</h2>
${o.name === null ? '' : `<p>Personalize your invitation to ${o.name ?? 'Jane Example'} by adding a note</p>`}
<textarea>${o.note ?? NOTE}</textarea>
<footer><button>Cancel</button><button>Send</button></footer></dialog>`;

export const messageOverlay = (o: { name?: string; text?: string } = {}): string => `<div role="dialog" aria-label="Messaging" class="msg-overlay">
<h2>${o.name ?? 'Jane Example'}</h2>
<textarea>${o.text ?? MSG}</textarea>
<footer><button>Send</button></footer></div>`;
