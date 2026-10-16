// tests/web-settings-api.test.ts
// Settings API (plan 8H, Task 7): auth and header gates, check order, two-step apply with one-time tokens, friction
// (reauth, phrase, remote exposure), files, backups, rollback, rate limit and lock, audit. Hermetic: memFs, fake clock.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { refreshAuth } from '../src/dash/sessions.js';
import { listAudit } from '../src/dash/authStore.js';
import { ENV_PATH, fixtureText, ROOT, setupSettings, type SettingsSetup } from './helpers/settingsHarness.js';
import { installNoRealEnv } from './helpers/noRealEnv.js';

const guard = installNoRealEnv();
let s: SettingsSetup | null = null;
afterEach(async () => {
  if (s) await s.h.close();
  s = null;
  vi.restoreAllMocks();
});
afterAll(() => guard.restore());

const J = (r: { body: string }): any => JSON.parse(r.body);
const set = (key: string, value: string) => ({ key, op: 'set' as const, value });

async function preview(x: SettingsSetup, changes: unknown[], path = '/api/settings/env/preview') {
  const etag = await x.envEtag();
  const res = await x.post(path, { etag, changes });
  return { res, etag, j: res.status === 200 ? J(res) : null };
}
async function applyOk(x: SettingsSetup, changes: unknown[], extra: Record<string, unknown> = {}) {
  const p = await preview(x, changes);
  expect(p.res.status, p.res.body).toBe(200);
  const res = await x.post('/api/settings/env/apply', { token: p.j.token, etag: p.etag, changes, ...extra });
  return { p, res };
}
const staleAuth = (x: SettingsSetup) => { x.h.clock.t += 400_000; };
const freshen = (x: SettingsSetup) => refreshAuth(x.h.auth, x.sessionHash, x.h.now());
const auditRows = (x: SettingsSetup) => listAudit(x.h.auth, 200);

describe('gates', () => {
  it('401 without a session on reads and writes', async () => {
    s = await setupSettings();
    expect((await s.h.call('GET', '/api/settings/meta')).status).toBe(401);
    expect((await s.h.call('POST', '/api/settings/env/preview', { headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
  it('missing CSRF, wrong Origin, missing or cross Sec-Fetch-Site are 403', async () => {
    s = await setupSettings();
    const body = { etag: await s.envEtag(), changes: [] };
    expect((await s.post('/api/settings/env/preview', body, { 'x-csrf-token': undefined })).status).toBe(403);
    expect((await s.post('/api/settings/env/preview', body, { origin: 'http://evil.test' })).status).toBe(403);
    expect((await s.post('/api/settings/env/preview', body, { 'sec-fetch-site': undefined })).status).toBe(403);
    expect((await s.post('/api/settings/env/preview', body, { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await s.post('/api/settings/env/preview', body, { 'sec-fetch-site': 'same-site' })).status).toBe(403);
  });
  it('GET on write routes is 405; other methods 405', async () => {
    s = await setupSettings();
    for (const p of ['/api/settings/env/preview', '/api/settings/env/apply', '/api/settings/files/portals/preview', '/api/settings/rollback/apply']) {
      expect((await s.get(p)).status, p).toBe(405);
    }
    expect((await s.h.call('PUT', '/api/settings/env', { headers: { cookie: s.cookie } })).status).toBe(405);
  });
  it('wrong content type 415; body over 64 KiB 413', async () => {
    s = await setupSettings();
    expect((await s.post('/api/settings/env/preview', '{}', { 'content-type': 'text/plain' })).status).toBe(415);
    const big = JSON.stringify({ etag: 'x', changes: [], pad: 'a'.repeat(70_000) });
    expect((await s.post('/api/settings/env/preview', big)).status).toBe(413);
  });
  it('no settings deps: the routes do not exist (404)', async () => {
    const { makeHarness } = await import('./helpers/webHarness.js');
    const h = await makeHarness();
    try {
      const { cookie } = await h.login();
      expect((await h.call('GET', '/api/settings/meta', { headers: { cookie } })).status).toBe(404);
    } finally {
      await h.close();
    }
  });
  it('editEnabled=false: every write is 403 settings_disabled, reads still work', async () => {
    s = await setupSettings({ editEnabled: false });
    const body = { etag: await s.envEtag(), changes: [set('FX_MODE', 'oidc')] };
    for (const p of ['/api/settings/env/preview', '/api/settings/env/apply', '/api/settings/rollback/preview', '/api/settings/files/languages/preview']) {
      const r = await s.post(p, body);
      expect(r.status, p).toBe(403);
      expect(J(r).error).toBe('settings_disabled');
    }
    expect((await s.get('/api/settings/env')).status).toBe(200);
    expect(J(await s.get('/api/settings/meta')).editEnabled).toBe(false);
    expect((await s.get('/api/settings/files')).status).toBe(200);
  });
  it('security headers on every kind of response', async () => {
    s = await setupSettings();
    const rs = [
      await s.get('/api/settings/meta'),
      await s.get('/api/settings/env/preview'),
      await s.post('/api/settings/env/preview', '{}', { 'sec-fetch-site': undefined }),
      await s.h.call('GET', '/api/settings/meta'),
    ];
    for (const r of rs) {
      expect(r.headers['content-security-policy']).toBeTruthy();
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['cache-control']).toBe('no-store');
    }
  });
});

describe('reads', () => {
  it('meta shape; pendingRestart is [] without the seam', async () => {
    s = await setupSettings();
    const m = J(await s.get('/api/settings/meta'));
    expect(m).toMatchObject({
      editEnabled: true, remoteExposure: false, modeChangedSinceStart: false, pendingRestart: [], reauthFresh: true, backupKeep: 10,
    });
    expect(m.mode.mode).toBe('DRY RUN');
    expect(m.restartCommands.mcp).toBeTruthy();
    expect(typeof m.catalogVersion).toBe('string');
  });
  it('modeChangedSinceStart follows the file, not the start snapshot', async () => {
    s = await setupSettings({ startMode: { mode: 'LIVE', flags: {} } });
    expect(J(await s.get('/api/settings/meta')).modeChangedSinceStart).toBe(true);
  });
  it('env list: secrets never carry a value, unknown keys listed by name, q and section filter', async () => {
    s = await setupSettings({ shellEnv: { FX_MAX_PER_DAY: '7' } });
    const text = (await s.get('/api/settings/env')).body;
    expect(text).not.toContain('FIXTURE-SECRET-');
    expect(text).not.toContain('keep-me-as-is');
    const j = JSON.parse(text);
    const items = j.sections.flatMap((x: any) => x.items);
    const key = items.find((i: any) => i.key === 'FX_API_KEY');
    expect(key.secret).toBe(true);
    expect(key.state).toMatchObject({ set: true, source: 'file' });
    expect('value' in key.state).toBe(false);
    expect(items.find((i: any) => i.key === 'FX_MAX_PER_DAY').state).toMatchObject({ set: true, value: '5', shellOverride: true });
    expect(items.find((i: any) => i.key === 'FX_PORT').state).toMatchObject({ set: false, source: 'default' });
    expect(j.unknownKeys).toEqual(['ANOTHER_UNKNOWN', 'UNKNOWN_FIXTURE_KEY']);
    const q = J(await s.get('/api/settings/env?q=weekly'));
    expect(q.sections.flatMap((x: any) => x.items).map((i: any) => i.key)).toEqual(['FX_LINKEDIN_WEEKLY']);
    const sec = J(await s.get('/api/settings/env?section=telegram'));
    expect(sec.sections.map((x: any) => x.id)).toEqual(['telegram']);
  });
  it('files list and read; unknown and traversal ids are 404', async () => {
    s = await setupSettings();
    const list = J(await s.get('/api/settings/files'));
    expect(list.find((f: any) => f.id === 'languages')).toMatchObject({ edit: true, exists: true, tier: 'normal' });
    const f = J(await s.get('/api/settings/files/languages'));
    expect(f.text).toBe(fixtureText('languages.json'));
    expect(f.entry).toMatchObject({ id: 'languages', edit: true });
    for (const id of ['nope', '..%2F..%2Fetc%2Fpasswd', '%2e%2e', 'languages.json', 'LANGUAGES']) {
      expect((await s.get(`/api/settings/files/${id}`)).status, id).toBe(404);
    }
  });
});

describe('env two-step apply', () => {
  it('normal key: preview then apply writes, backs up, audits names and pair', async () => {
    s = await setupSettings();
    const { p, res } = await applyOk(s, [set('FX_MODE', 'oidc')]);
    expect(p.j.expiresInSec).toBe(120);
    expect(p.j.plan.diffs).toEqual([{ key: 'FX_MODE', before: expect.stringContaining('alpha'), after: 'oidc', secret: false }]);
    expect(p.j.plan.restart).toEqual([{ key: 'FX_MODE', scope: 'dashboard' }]);
    expect(p.j.plan.newText).toBeUndefined();
    expect(res.status, res.body).toBe(200);
    const j = J(res);
    expect(j.ok).toBe(true);
    expect(j.backupId).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{8}$/);
    expect(s.fs.text(ENV_PATH)).toContain('FX_MODE=oidc');
    expect(s.fs.files(`${ROOT}/.jobber/settings-backups/env`)).toHaveLength(1);
    expect(await s.envEtag()).toBe(j.newEtag);
    const rows = auditRows(s).filter((r) => r.kind === 'settings_env_apply');
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toContain('FX_MODE');
    expect(rows[0].note).toMatch(/FX_MODE:alpha.*->oidc/);
  });
  it('audit never records string values or secrets', async () => {
    s = await setupSettings();
    const { res } = await applyOk(s, [set('FX_NAME', 'personal string value'), set('FX_API_KEY', 'FIXTURE-SECRET-77')]);
    expect(res.status, res.body).toBe(200);
    const rows = JSON.stringify(auditRows(s));
    expect(rows).toContain('FX_NAME');
    expect(rows).toContain('FX_API_KEY');
    expect(rows).not.toContain('personal string value');
    expect(rows).not.toContain('FIXTURE-SECRET-');
    expect(res.body).not.toContain('FIXTURE-SECRET-');
  });
  it('a newly written secret is added to the redaction list', async () => {
    s = await setupSettings();
    await applyOk(s, [set('FX_OAUTH_SECRET', 'FIXTURE-SECRET-88')]);
    expect(s.deps.secrets).toContain('FIXTURE-SECRET-88');
  });
  it('validation errors are 422 with key names and no values', async () => {
    s = await setupSettings();
    const { res } = await preview(s, [set('FX_MAX_PER_DAY', 'FIXTURE-SECRET-5'), { key: 'NOT_A_KEY', op: 'clear' }]);
    expect(res.status).toBe(422);
    expect(res.body).toContain('FX_MAX_PER_DAY');
    expect(res.body).not.toContain('FIXTURE-SECRET-5');
  });
  it('never tier: 403 tier_never', async () => {
    s = await setupSettings();
    const { res } = await preview(s, [set('FX_KILL', 'true')]);
    expect(res.status).toBe(403);
    expect(J(res).error).toBe('tier_never');
  });
  it('guarded key needs fresh auth: stale 401 reauth_required, then passes after refreshAuth', async () => {
    s = await setupSettings();
    staleAuth(s);
    const stale = await preview(s, [set('FX_MAX_PER_DAY', '50')]);
    expect(stale.res.status).toBe(401);
    expect(J(stale.res)).toMatchObject({ error: 'reauth_required', url: expect.stringContaining('reauth=1') });
    freshen(s);
    const { res } = await applyOk(s, [set('FX_MAX_PER_DAY', '50')]);
    expect(res.status, res.body).toBe(200);
  });
  it('stale session is fine for a normal key', async () => {
    s = await setupSettings();
    staleAuth(s);
    expect((await applyOk(s, [set('FX_MODE', 'oidc')])).res.status).toBe(200);
  });
  it('safety weakening: preview shows the phrase, wrong or missing phrase 403, right phrase passes', async () => {
    s = await setupSettings();
    const changes = [set('FX_DRY_RUN', 'false')];
    const p = await preview(s, changes);
    expect(p.j.plan.friction).toEqual({ reauth: true, phrase: 'CHANGE FX_DRY_RUN' });
    const a = { token: p.j.token, etag: p.etag, changes };
    for (const phrase of [undefined, 'change fx_dry_run', 'CHANGE FX_DRY_RUN please']) {
      const r = await s.post('/api/settings/env/apply', { ...a, phrase });
      expect(r.status).toBe(403);
      expect(J(r).error).toBe('phrase_mismatch');
    }
    expect(s.fs.text(ENV_PATH)).toContain('FX_DRY_RUN=1');
    // a wrong phrase does not burn the token
    const ok = await s.post('/api/settings/env/apply', { ...a, phrase: 'CHANGE FX_DRY_RUN' });
    expect(ok.status, ok.body).toBe(200);
    expect(s.fs.text(ENV_PATH)).toContain('FX_DRY_RUN=false');
  });
  it('strengthening a safety key needs no phrase', async () => {
    s = await setupSettings();
    const p = await preview(s, [set('FX_ENABLE_SEND', 'false')]);
    expect(p.j.plan.friction.phrase).toBeNull();
    const { res } = await applyOk(s, [set('FX_ENABLE_SEND', 'false')]);
    expect(res.status, res.body).toBe(200);
  });
  it('remote exposure refuses safety weakening; the override allows it', async () => {
    s = await setupSettings({ remoteExposure: true });
    const r = await preview(s, [set('FX_DRY_RUN', 'false')]);
    expect(r.res.status).toBe(403);
    expect(J(r.res).error).toBe('remote_exposure');
    await s.h.close();
    s = await setupSettings({ remoteExposure: true, remoteSafetyAllowed: true });
    const { res } = await applyOk(s, [set('FX_DRY_RUN', 'false')], { phrase: 'CHANGE FX_DRY_RUN' });
    expect(res.status, res.body).toBe(200);
  });
});

describe('tokens', () => {
  it('single use, consumed even after success', async () => {
    s = await setupSettings();
    const changes = [set('FX_MODE', 'oidc')];
    const { p, res } = await applyOk(s, changes);
    expect(res.status).toBe(200);
    const again = await s.post('/api/settings/env/apply', { token: p.j.token, etag: await s.envEtag(), changes });
    expect(again.status).toBe(403);
    expect(J(again).error).toBe('token_used');
  });
  it('a token from another session is refused', async () => {
    s = await setupSettings();
    const changes = [set('FX_MODE', 'oidc')];
    const p = await preview(s, changes);
    const o = await s.second();
    const r = await s.post('/api/settings/env/apply', { token: p.j.token, etag: p.etag, changes }, { cookie: o.cookie, 'x-csrf-token': o.csrf });
    expect(r.status).toBe(403);
    expect(J(r).error).toBe('token_session');
  });
  it('expires after 120 s', async () => {
    s = await setupSettings();
    const changes = [set('FX_MODE', 'oidc')];
    const p = await preview(s, changes);
    s.h.clock.t += 121_000;
    const r = await s.post('/api/settings/env/apply', { token: p.j.token, etag: p.etag, changes });
    expect(r.status).toBe(403);
    expect(J(r).error).toBe('token_expired');
  });
  it('changed changes between preview and apply: plan_mismatch, and the token is consumed', async () => {
    s = await setupSettings();
    const p = await preview(s, [set('FX_MODE', 'oidc')]);
    const bad = await s.post('/api/settings/env/apply', { token: p.j.token, etag: p.etag, changes: [set('FX_MODE', 'token')] });
    expect(bad.status).toBe(403);
    expect(J(bad).error).toBe('plan_mismatch');
    const good = await s.post('/api/settings/env/apply', { token: p.j.token, etag: p.etag, changes: [set('FX_MODE', 'oidc')] });
    expect(J(good).error).toBe('token_used');
    expect(s.fs.text(ENV_PATH)).toContain('FX_MODE=alpha');
  });
  it('etag changed on disk between preview and apply: 409 stale_etag', async () => {
    s = await setupSettings();
    const changes = [set('FX_MODE', 'oidc')];
    const p = await preview(s, changes);
    s.fs.put(ENV_PATH, s.fs.text(ENV_PATH) + '\nEXTERNAL=1\n');
    const r = await s.post('/api/settings/env/apply', { token: p.j.token, etag: p.etag, changes });
    expect(r.status).toBe(409);
    expect(J(r).error).toBe('stale_etag');
    expect(s.fs.text(ENV_PATH)).not.toContain('FX_MODE=oidc');
  });
  it('stale etag at preview is 409 too; bad bodies are 400', async () => {
    s = await setupSettings();
    expect((await s.post('/api/settings/env/preview', { etag: 'deadbeef', changes: [] })).status).toBe(409);
    expect((await s.post('/api/settings/env/preview', { etag: 5, changes: [] })).status).toBe(400);
    expect((await s.post('/api/settings/env/preview', [])).status).toBe(400);
    const p = await preview(s, [set('FX_MODE', 'oidc')]);
    expect((await s.post('/api/settings/env/apply', { etag: p.etag, changes: [set('FX_MODE', 'oidc')] })).status).toBe(403);
  });
  it('settings_pending stores hashes only', async () => {
    s = await setupSettings();
    const p = await preview(s, [set('FX_MODE', 'oidc')]);
    const rows = JSON.stringify(s.h.auth.prepare('SELECT * FROM settings_pending').all());
    expect(rows).not.toContain(p.j.token);
    expect(rows).not.toContain('oidc');
  });
});

describe('rate limit and lock', () => {
  it('10 writes per minute per session, then 429; recovers after a minute', async () => {
    s = await setupSettings();
    const etag = await s.envEtag();
    for (let i = 0; i < 10; i++) expect((await s.post('/api/settings/env/preview', { etag, changes: [] })).status).toBe(200);
    const r = await s.post('/api/settings/env/preview', { etag, changes: [] });
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeTruthy();
    s.h.clock.t += 61_000;
    expect((await s.post('/api/settings/env/preview', { etag, changes: [] })).status).toBe(200);
    expect(auditRows(s).filter((a) => a.kind === 'settings_reject' && a.note === 'rate_limited')).toHaveLength(1);
  });
  it('5 failed applies lock the session for 5 minutes (audited once)', async () => {
    s = await setupSettings();
    const changes = [set('FX_MODE', 'oidc')];
    const etag = await s.envEtag();
    for (let i = 0; i < 5; i++) {
      s.h.clock.t += 7000; // keep under the 10 writes per minute budget
      const r = await s.post('/api/settings/env/apply', { token: 'x'.repeat(40), etag, changes });
      expect(r.status).toBe(403);
    }
    s.h.clock.t += 1000;
    const locked = await s.post('/api/settings/env/preview', { etag, changes });
    expect(locked.status).toBe(429);
    expect((await s.post('/api/settings/env/preview', { etag, changes })).status).toBe(429);
    expect(auditRows(s).filter((a) => a.note === 'locked')).toHaveLength(1);
    s.h.clock.t += 5 * 60_000;
    expect((await s.post('/api/settings/env/preview', { etag, changes })).status).toBe(200);
  });
});

describe('files', () => {
  const languagesWith = (confirmed: boolean) => JSON.stringify({ ...JSON.parse(fixtureText('languages.json')), confirmed }, null, 2) + '\n';

  it('preview then apply a normal file edit, audit has the id and path count only', async () => {
    s = await setupSettings();
    const cur = J(await s.get('/api/settings/files/portals'));
    const next = fixtureText('portals.json').replace(/\n$/, '') + '\n';
    const edited = JSON.stringify({ ...JSON.parse(cur.text), title_filter: JSON.parse(cur.text).title_filter }, null, 2) + '\n';
    const text = edited === cur.text ? next + ' ' : edited;
    const p = await s.post('/api/settings/files/portals/preview', { etag: cur.etag, text });
    expect(p.status, p.body).toBe(200);
    const pj = J(p);
    const a = await s.post('/api/settings/files/portals/apply', { token: pj.token, etag: cur.etag, text });
    expect(a.status, a.body).toBe(200);
    const rows = auditRows(s).filter((r) => r.kind === 'settings_file_apply');
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toMatch(/^file=portals n=\d+$/);
  });
  it('weakening a file (languages confirmed true) is guarded: reauth, then passes', async () => {
    s = await setupSettings();
    const cur = J(await s.get('/api/settings/files/languages'));
    const text = languagesWith(true);
    staleAuth(s);
    expect((await s.post('/api/settings/files/languages/preview', { etag: cur.etag, text })).status).toBe(401);
    freshen(s);
    const p = await s.post('/api/settings/files/languages/preview', { etag: cur.etag, text });
    expect(p.status, p.body).toBe(200);
    expect(J(p).plan.friction.reauth).toBe(true);
    const a = await s.post('/api/settings/files/languages/apply', { token: J(p).token, etag: cur.etag, text });
    expect(a.status, a.body).toBe(200);
    expect(s.fs.text(`${ROOT}/user-data/languages.json`)).toBe(text);
  });
  it('safety-weakening file (replies auto_record) needs the phrase', async () => {
    s = await setupSettings();
    const cur = J(await s.get('/api/settings/files/replies'));
    const text = JSON.stringify({ ...JSON.parse(cur.text), auto_record_enabled: true }, null, 2) + '\n';
    const p = await s.post('/api/settings/files/replies/preview', { etag: cur.etag, text });
    expect(p.status, p.body).toBe(200);
    expect(J(p).plan.friction.phrase).toBe('CHANGE replies');
    const body = { token: J(p).token, etag: cur.etag, text };
    expect((await s.post('/api/settings/files/replies/apply', body)).status).toBe(403);
    const q = await s.post('/api/settings/files/replies/preview', { etag: cur.etag, text });
    expect((await s.post('/api/settings/files/replies/apply', { token: J(q).token, etag: cur.etag, text, phrase: 'CHANGE replies' })).status).toBe(200);
  });
  it('invalid JSON is 422; stale etag 409; view-only 403; oversize 413; unknown 404', async () => {
    s = await setupSettings();
    const cur = J(await s.get('/api/settings/files/languages'));
    expect((await s.post('/api/settings/files/languages/preview', { etag: cur.etag, text: '{nope' })).status).toBe(422);
    expect((await s.post('/api/settings/files/languages/preview', { etag: 'old', text: languagesWith(false) })).status).toBe(409);
    expect((await s.post('/api/settings/files/permission-sets/preview', { etag: 'x', text: '{}' })).status).toBe(403);
    expect((await s.post('/api/settings/files/languages/preview', { etag: cur.etag, text: 'a'.repeat(262_145) })).status).toBe(413);
    expect((await s.post('/api/settings/files/nope/preview', { etag: 'x', text: '{}' })).status).toBe(404);
    expect((await s.post('/api/settings/files/..%2F..%2Fx/apply', { token: 'x'.repeat(40), etag: 'x', text: '{}' })).status).toBe(404);
  });
});

describe('backups and rollback', () => {
  it('lists backups and rolls the env back (preview, apply)', async () => {
    s = await setupSettings();
    const before = s.fs.text(ENV_PATH)!;
    const { res } = await applyOk(s, [set('FX_MODE', 'oidc')]);
    const backupId = J(res).backupId;
    const list = J(await s.get('/api/settings/backups?target=env'));
    expect(list).toEqual([{ id: backupId, at: expect.any(String), size: Buffer.byteLength(before) }]);
    const etag = await s.envEtag();
    const p = await s.post('/api/settings/rollback/preview', { target: 'env', backupId });
    expect(p.status, p.body).toBe(200);
    expect(J(p).plan.diffs.map((d: any) => d.key)).toEqual(['FX_MODE']);
    const a = await s.post('/api/settings/rollback/apply', { token: J(p).token, target: 'env', backupId });
    expect(a.status, a.body).toBe(200);
    expect(s.fs.text(ENV_PATH)).toBe(before);
    expect(await s.envEtag()).not.toBe(etag);
    expect(auditRows(s).filter((r) => r.kind === 'settings_rollback')).toHaveLength(1);
  });
  it('rollback apply is stale when the env changed after the preview', async () => {
    s = await setupSettings();
    const { res } = await applyOk(s, [set('FX_MODE', 'oidc')]);
    const backupId = J(res).backupId;
    const p = await s.post('/api/settings/rollback/preview', { target: 'env', backupId });
    s.fs.put(ENV_PATH, s.fs.text(ENV_PATH) + '\nEXTERNAL=2\n');
    const a = await s.post('/api/settings/rollback/apply', { token: J(p).token, target: 'env', backupId });
    expect(a.status).toBe(409);
  });
  it('file rollback; bad ids and targets', async () => {
    s = await setupSettings();
    const cur = J(await s.get('/api/settings/files/languages'));
    const text = JSON.stringify({ ...JSON.parse(cur.text), confirmed: true }, null, 2) + '\n';
    const p = J(await s.post('/api/settings/files/languages/preview', { etag: cur.etag, text }));
    const a = J(await s.post('/api/settings/files/languages/apply', { token: p.token, etag: cur.etag, text }));
    const target = 'file:languages';
    const list = J(await s.get(`/api/settings/backups?target=${encodeURIComponent(target)}`));
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(a.backupId);
    const rp = await s.post('/api/settings/rollback/preview', { target, backupId: a.backupId });
    expect(rp.status, rp.body).toBe(200);
    const ra = await s.post('/api/settings/rollback/apply', { token: J(rp).token, target, backupId: a.backupId });
    expect(ra.status, ra.body).toBe(200);
    expect(s.fs.text(`${ROOT}/user-data/languages.json`)).toBe(cur.text);
    expect((await s.post('/api/settings/rollback/preview', { target: 'nope', backupId: 'x' })).status).toBe(400);
    expect((await s.post('/api/settings/rollback/preview', { target: 'env', backupId: '../../etc/passwd' })).status).toBe(400);
    expect((await s.post('/api/settings/rollback/preview', { target: 'env', backupId: '20260101T000000Z-abcdef12' })).status).toBe(404);
    expect((await s.get('/api/settings/backups?target=file:nope')).status).toBe(404);
    expect((await s.get('/api/settings/backups?target=../x')).status).toBe(400);
  });
});

describe('pending restart seam', () => {
  it('apply marks restart entries; meta lists them', async () => {
    const marked: unknown[] = [];
    s = await setupSettings({
      pendingRestart: {
        mark: (e) => { marked.push(...e); },
        list: () => [{ key: 'FX_MODE', scope: 'dashboard', command: 'restart' }],
      },
    });
    await applyOk(s, [set('FX_MODE', 'oidc')]);
    expect(marked).toEqual([{ key: 'FX_MODE', scope: 'dashboard' }]);
    expect(J(await s.get('/api/settings/meta')).pendingRestart).toEqual([{ key: 'FX_MODE', scope: 'dashboard', command: 'restart' }]);
  });
});

describe('write failures', () => {
  it('a failed rename returns a short code, leaves the original, and is not a success audit row', async () => {
    s = await setupSettings();
    const before = s.fs.text(ENV_PATH);
    s.fs.failOn('rename', ENV_PATH);
    const { res } = await applyOk(s, [set('FX_MODE', 'oidc')]);
    expect(res.status).toBe(500);
    expect(J(res).error).toBe('write_failed');
    expect(s.fs.text(ENV_PATH)).toBe(before);
    expect(auditRows(s).filter((r) => r.kind === 'settings_env_apply')).toHaveLength(0);
  });
});
