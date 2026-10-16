// tests/helpers/settingsHarness.ts
// Shared setup for the settings API tests: in-process dashboard with a memFs-backed settings dependency set, the
// fixture catalog, the fixture env text and the fixture config files. Nothing touches the real .env or disk config.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_CATALOG } from '../fixtures/settings/catalog.fixture.js';
import type { SettingsDeps } from '../../src/web/settingsRoutes.js';
import { memFs, type MemFs } from './memFs.js';
import { makeHarness, type Harness, type Res } from './webHarness.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'settings');
export const fixtureText = (name: string): string => readFileSync(join(FIX, name), 'utf8');

export const ROOT = '/proj';
export const ENV_PATH = `${ROOT}/.env`;
export const BACKUPS = `${ROOT}/.jobber/settings-backups`;

export interface SettingsSetup {
  h: Harness;
  fs: MemFs;
  deps: SettingsDeps;
  cookie: string;
  csrf: string;
  sessionHash: string;
  /** POST JSON with valid session headers; `hdr` overrides/removes (undefined removes) */
  post: (path: string, body: unknown, hdr?: Record<string, string | undefined>) => Promise<Res>;
  get: (path: string, cookie?: string) => Promise<Res>;
  /** second independent session */
  second: () => Promise<{ cookie: string; csrf: string }>;
  envEtag: () => Promise<string>;
}

export async function setupSettings(over: Partial<SettingsDeps> = {}): Promise<SettingsSetup> {
  const fs = memFs({
    [ENV_PATH]: fixtureText('env.fixture'),
    [`${ROOT}/config/portals.json`]: fixtureText('portals.json'),
    [`${ROOT}/config/target-regions.json`]: fixtureText('target-regions.json'),
    [`${ROOT}/config/deal-breakers.json`]: fixtureText('deal-breakers.json'),
    [`${ROOT}/config/replies.json`]: fixtureText('replies.json'),
    [`${ROOT}/user-data/languages.json`]: fixtureText('languages.json'),
    [`${ROOT}/user-data/easy-apply-answers.json`]: fixtureText('easy-apply-answers.json'),
    [`${ROOT}/user-data/profile.json`]: fixtureText('profile.json'),
    [`${ROOT}/user-data/fact-gate.json`]: fixtureText('fact-gate.json'),
  });
  fs.mkdirp(BACKUPS, 0o700);
  const deps: SettingsDeps = {
    root: ROOT,
    envPath: ENV_PATH,
    backupDir: BACKUPS,
    userDataDir: `${ROOT}/user-data`,
    catalog: FIXTURE_CATALOG,
    fs,
    editEnabled: true,
    remoteExposure: false,
    remoteSafetyAllowed: false,
    backupKeep: 10,
    startMode: { mode: 'DRY RUN', flags: {} },
    secrets: [],
    ...over,
  };
  const h = await makeHarness({ settings: deps });
  const login = async (): Promise<{ cookie: string; csrf: string }> => {
    const { cookie } = await h.login();
    const s = JSON.parse((await h.call('GET', '/api/session', { headers: { cookie } })).body);
    return { cookie, csrf: s.csrf as string };
  };
  const { cookie, csrf } = await login();
  const row = h.auth.prepare('SELECT id_hash FROM sessions ORDER BY rowid DESC LIMIT 1').get() as { id_hash: string };

  const post: SettingsSetup['post'] = (path, body, hdr = {}) => {
    const headers: Record<string, string | undefined> = {
      cookie, 'x-csrf-token': csrf, origin: `http://127.0.0.1:${h.port}`, 'content-type': 'application/json',
      'sec-fetch-site': 'same-origin', ...hdr,
    };
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) if (v !== undefined) clean[k] = v;
    return h.call('POST', path, { headers: clean, body: typeof body === 'string' ? body : JSON.stringify(body) });
  };
  const get: SettingsSetup['get'] = (path, c = cookie) => h.call('GET', path, { headers: { cookie: c } });
  return {
    h, fs, deps, cookie, csrf, sessionHash: row.id_hash, post, get, second: login,
    envEtag: async () => JSON.parse((await get('/api/settings/env')).body).etag as string,
  };
}
