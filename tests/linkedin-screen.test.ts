import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { countSince } from '../src/outreach/limits.js';
import { profileKeyOf } from '../src/linkedin/urls.js';
import { DEFAULT_STYLE_CONFIG } from '../src/safety/styleGate.js';
import { IntentStore } from '../src/browserctl/intent.js';
import { buildHandlers } from '../src/mcp/linkedin.js';
import { SCREENED_SURFACES } from '../src/safety/screen.js';
import type { ClassifierPort } from '../src/safety/inputGate.js';
import type { Runtime } from '../src/linkedin/runtime.js';
import { fakeBcPage } from './helpers/fakeBc.js';
import { NOTE, profileHtml, URL_ } from './helpers/bcWorld.js';

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const LIVE = { JOBBER_DRY_RUN: 'false' };
const DRY = { JOBBER_DRY_RUN: 'true' };

const fake = (malicious: boolean): ClassifierPort => ({
  classify: vi.fn(async () => ({ malicious, score: 0.5, truncated: false })),
});
const rejecting = (): (() => Promise<ClassifierPort>) => () => Promise.reject(new Error('x'));

function make(env: NodeJS.ProcessEnv, classifier: ClassifierPort | (() => Promise<ClassifierPort>)) {
  const db = openDb(':memory:');
  upsertPerson(db, { platform: 'linkedin', profileKey: profileKeyOf(URL_), name: 'Jane Example', headline: 'Technical Recruiter at Acme', company: 'Acme', category: 'recruiter' });
  const page = fakeBcPage(profileHtml(), URL_);
  const rt = { page: () => ({}), touch: () => undefined, discard: async () => true, close: async () => true } as unknown as Runtime;
  const handlers = buildHandlers({
    db, rt, env, now: () => new Date('2026-10-14T10:00:00Z'), classifier, intents: new IntentStore(),
    factCheck: (t) => ({ verdict: 'pass', normalized_text: t }), styleCfg: DEFAULT_STYLE_CONFIG,
    bcPage: () => page, paceMs: () => 0, settleMs: 0,
  });
  return { handlers, db, page };
}

describe('linkedin classifier screen', () => {
  it('malicious classifier verdict: no page text, injection_suspected', async () => {
    const { handlers } = make(LIVE, fake(true));
    const out = (await handlers.linkedin_open({ url: URL_ })) as string;
    const r = JSON.parse(out);
    expect(r).toMatchObject({ ok: false, code: 'injection_suspected' });
    expect(out).not.toContain('PAGE_TEXT');
    expect(out).not.toContain('Jane');
    const s = JSON.parse((await handlers.linkedin_snapshot({})) as string);
    expect(s.code).toBe('injection_suspected');
  });

  it('benign verdict: text returned without the unscreened marker', async () => {
    const { handlers } = make(LIVE, fake(false));
    const out = (await handlers.linkedin_open({ url: URL_ })) as string;
    expect(out).toContain('<<<PAGE_TEXT');
    expect(out).not.toContain('screen: unscreened');
  });

  it('live + classifier unavailable: reads blocked, arming fails without consuming a ceiling', async () => {
    const { handlers, db } = make(LIVE, rejecting());
    const out = (await handlers.linkedin_open({ url: URL_ })) as string;
    expect(JSON.parse(out)).toMatchObject({ ok: false, code: 'classifier_unavailable' });
    expect(out).not.toContain('PAGE_TEXT');
    const a = JSON.parse((await handlers.linkedin_arm_send({ kind: 'connect_note', profile_url: URL_, text: NOTE })) as string);
    expect(a.status).toBe('failed');
    expect(a.code).toBe('classifier_unavailable');
    expect(countSince(db, 'linkedin_invite', new Date('2000-01-01T00:00:00Z'))).toBe(0);
  });

  it('dry run + classifier unavailable: text returned unscreened, arming stays a dry intent', async () => {
    const { handlers, page } = make(DRY, rejecting());
    const out = (await handlers.linkedin_open({ url: URL_ })) as string;
    expect(out).toContain('screen: unscreened');
    expect(out).toContain('<<<PAGE_TEXT');
    const a = JSON.parse((await handlers.linkedin_arm_send({ kind: 'connect_note', profile_url: URL_, text: NOTE })) as string);
    expect(a).toMatchObject({ status: 'armed', dry_run: true });
    expect(page.log.filter((l) => l.startsWith('click') || l.startsWith('fill'))).toEqual([]);
  });

  it('SCREENED_SURFACES: each linkedin_* file calls the screen', () => {
    const entries = SCREENED_SURFACES.filter(
      (s) => s.id.startsWith('linkedin_') && !['linkedin_find_profiles', 'linkedin_search_jobs', 'linkedin_search_posts', 'linkedin_manual_job'].includes(s.id),
    );
    expect(entries.map((e) => e.id).sort()).toEqual(['linkedin_arm_send', 'linkedin_check_status', 'linkedin_snapshot']);
    for (const e of entries) {
      const text = read(e.file);
      expect(text.includes('screenUntrusted') || text.includes('deps.screen('), e.id).toBe(true);
    }
  });
});
