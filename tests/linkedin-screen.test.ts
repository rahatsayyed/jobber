import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { countSince } from '../src/outreach/limits.js';
import { createRuntime, type Runtime } from '../src/linkedin/runtime.js';
import { buildSnapshotFromHtml } from '../src/linkedin/snapshot.js';
import { SELECTORS } from '../src/linkedin/selectors.js';
import { profileKeyOf } from '../src/linkedin/urls.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { buildHandlers } from '../src/mcp/linkedin.js';
import { SCREENED_SURFACES } from '../src/safety/screen.js';
import type { ClassifierPort } from '../src/safety/inputGate.js';
import { makeFakeLauncher } from './helpers/fakeLinkedin.js';

const STATE = { cookies: [{ name: 'li_at', value: 'SENTINEL-NOT-REAL', domain: '.linkedin.com', path: '/' }], origins: [] };
const PROFILE = 'https://www.linkedin.com/in/jane-example/';
const NOTE = 'Hi Jane, I saw the platform team is hiring and would like to connect.';
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const LIVE = { LINKEDIN_DRY_RUN: 'false', SCHEDULER_DRY_RUN: 'false' };
const DRY = { LINKEDIN_DRY_RUN: 'true' };
let dir: string;
const runtimes: Runtime[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'li-screen-'));
  writeFileSync(path.join(dir, 'state.json'), JSON.stringify(STATE), { mode: 0o600 });
  chmodSync(path.join(dir, 'state.json'), 0o600);
});
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close();
  rmSync(dir, { recursive: true, force: true });
});

const fake = (malicious: boolean): ClassifierPort => ({
  classify: vi.fn(async () => ({ malicious, score: 0.5, truncated: false })),
});
const rejecting = (): (() => Promise<ClassifierPort>) => () => Promise.reject(new Error('x'));

function make(env: NodeJS.ProcessEnv, classifier: ClassifierPort | (() => Promise<ClassifierPort>), fixture = 'profile-not-connected.html') {
  const db = openDb(':memory:');
  upsertPerson(db, { platform: 'linkedin', profileKey: profileKeyOf(PROFILE), name: 'Jane Example', headline: 'Technical Recruiter at Acme', company: 'Acme', category: 'recruiter' });
  const snap = buildSnapshotFromHtml(read(`tests/fixtures/linkedin/${fixture}`), PROFILE);
  const els = { [SELECTORS.nameHeadings]: [{ text: 'Jane Example', box: { x: 100, y: 100, height: 30 } }] };
  const log: string[] = [];
  const launcher = makeFakeLauncher({ pages: { '/in/jane-example/': { ...snap, elements: els } } } as any, log);
  const rt = createRuntime({
    db, launcher, sessionPath: path.join(dir, 'state.json'), lockPath: path.join(dir, 'l.lock'), settleMs: 0, env,
  });
  runtimes.push(rt);
  const handlers = buildHandlers({
    db, rt, env, now: () => new Date('2026-10-14T10:00:00Z'), classifier,
    factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG,
    sessionPath: path.join(dir, 'state.json'),
  });
  return { handlers, db, log };
}

describe('linkedin classifier screen', () => {
  it('malicious classifier verdict: no page text, injection_suspected', async () => {
    const { handlers } = make(LIVE, fake(true), 'profile-injection.html');
    const out = (await handlers.linkedin_open({ url: PROFILE })) as string;
    const r = JSON.parse(out);
    expect(r).toMatchObject({ ok: false, code: 'injection_suspected' });
    expect(out).not.toContain('PAGE_TEXT');
    expect(out).not.toContain('Jane');
    const s = JSON.parse((await handlers.linkedin_state({})) as string);
    expect(s.code).toBe('injection_suspected');
  });

  it('benign verdict: text returned without the unscreened marker', async () => {
    const { handlers } = make(LIVE, fake(false));
    const out = (await handlers.linkedin_open({ url: PROFILE })) as string;
    expect(out).toContain('<<<PAGE_TEXT');
    expect(out).not.toContain('classifier=unscreened');
  });

  it('live + classifier unavailable: reads blocked, send fails without consuming a ceiling', async () => {
    const { handlers, db } = make(LIVE, rejecting());
    const out = (await handlers.linkedin_open({ url: PROFILE })) as string;
    expect(JSON.parse(out)).toMatchObject({ ok: false, code: 'classifier_unavailable' });
    expect(out).not.toContain('PAGE_TEXT');
    const st = JSON.parse((await handlers.linkedin_check_connection_status({ profile_url: PROFILE })) as string);
    expect(st).toMatchObject({ status: 'failed', code: 'classifier_unavailable' });
    expect(st.name).toBeUndefined();
    const c = JSON.parse((await handlers.linkedin_connect_send({ profile_url: PROFILE, note: NOTE })) as string);
    expect(c.status).toBe('failed');
    expect(c.code).toBe('classifier_unavailable');
    expect(countSince(db, 'linkedin_invite', new Date('2000-01-01T00:00:00Z'))).toBe(0);
  });

  it('dry run + classifier unavailable: text returned unscreened, connect_send stays dry_run', async () => {
    const { handlers } = make(DRY, rejecting());
    const out = (await handlers.linkedin_open({ url: PROFILE })) as string;
    expect(out).toContain('classifier=unscreened');
    expect(out).toContain('<<<PAGE_TEXT');
    const c = JSON.parse((await handlers.linkedin_connect_send({ profile_url: PROFILE, note: NOTE })) as string);
    expect(c.status).toBe('dry_run');
  });

  it('SCREENED_SURFACES: each linkedin_* file calls the screen', () => {
    const entries = SCREENED_SURFACES.filter(
      (s) => s.id.startsWith('linkedin_') && !['linkedin_find_profiles', 'linkedin_search_jobs', 'linkedin_search_posts'].includes(s.id),
    );
    expect(entries).toHaveLength(5);
    for (const e of entries) {
      const text = read(e.file);
      expect(text.includes('screenUntrusted') || text.includes('deps.screen('), e.id).toBe(true);
    }
  });
});
