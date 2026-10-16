// tests/settings-json-store.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SettingsError, etagOf, writeWithBackup } from '../src/settings/atomic.js';
import { createJsonStore, countChangedPaths } from '../src/settings/jsonStore.js';
import { installNoRealEnv, isForbiddenPath, repoRoot } from './helpers/noRealEnv.js';
import { MemFs, memFs } from './helpers/memFs.js';

const guard = installNoRealEnv();
afterAll(() => guard.restore());

const fx = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'settings', name), 'utf8');
const ROOT = '/proj';
const UD = '/proj/user-data';
const BK = '/proj/.jobber/settings-backups';
let clock = 0;
const now = () => new Date(Date.UTC(2026, 9, 16, 12, 0, clock++));

function setup(over: { keep?: number; files?: Record<string, string>; env?: NodeJS.ProcessEnv; userDataDir?: string } = {}) {
  const fs = memFs({
    [`${ROOT}/config/portals.json`]: fx('portals.json'),
    [`${ROOT}/config/target-regions.json`]: fx('target-regions.json'),
    [`${ROOT}/config/replies.json`]: fx('replies.json'),
    [`${ROOT}/config/deal-breakers.json`]: fx('deal-breakers.json'),
    [`${UD}/languages.json`]: fx('languages.json'),
    [`${UD}/fact-gate.json`]: fx('fact-gate.json'),
    ...(over.files ?? {}),
  });
  const store = createJsonStore({ fs, root: ROOT, userDataDir: over.userDataDir ?? UD, env: over.env ?? {}, backupDir: BK, keep: over.keep ?? 10, now });
  return { fs, store };
}

describe('noRealEnv', () => {
  it('knows the forbidden paths and blocks the repo .env on the default fs object', async () => {
    expect(isForbiddenPath(join(repoRoot, '.env'))).toBe(true);
    expect(isForbiddenPath(join(repoRoot, '.dashboard', 'auth.sqlite'))).toBe(true);
    expect(isForbiddenPath(join(repoRoot, '.jobber', 'STOP'))).toBe(true);
    expect(isForbiddenPath(join(repoRoot, '.env.example'))).toBe(false);
    expect(isForbiddenPath(join(repoRoot, 'config', 'portals.json'))).toBe(false);
    const fs = (await import('node:fs')).default;
    expect(() => fs.readFileSync(join(repoRoot, '.env'))).toThrow(/noRealEnv/);
    expect(() => fs.existsSync(join(repoRoot, '.jobber'))).toThrow(/noRealEnv/);
    expect(guard.blocked.length).toBeGreaterThanOrEqual(2);
  });
});

describe('read, list and path safety', () => {
  it('reads text with a stable etag and reports a missing file', () => {
    const { store } = setup();
    const r = store.read('replies');
    expect(r).toMatchObject({ exists: true, text: fx('replies.json'), etag: etagOf(fx('replies.json')) });
    const missing = store.read('profile');
    expect(missing).toMatchObject({ exists: false, text: '', etag: etagOf('') });
  });

  it('refuses unknown ids', () => {
    const { store } = setup();
    expect(() => store.read('../.env')).toThrow(SettingsError);
    expect(() => store.plan('resume', '{}', 'x')).toThrow(/unknown/);
  });

  it('refuses a symlink and a directory at the target', () => {
    const { fs, store } = setup();
    fs.symlink(`${ROOT}/config/replies.json`, '/elsewhere/secret.json');
    expect(() => store.read('replies')).toThrow(/symbolic link/);
    fs.mkdirp(`${ROOT}/config/deal-breakers.json.d`);
    fs.mkdirp(`${UD}/profile.json`);
    expect(() => store.read('profile')).toThrow(/not a regular file/);
    expect(() => store.apply({ ...store.plan('target-regions', fx('target-regions.json'), store.read('target-regions').etag), id: 'replies' }, fx('target-regions.json'))).toThrow();
    const listed = store.list().find((s) => s.id === 'replies')!;
    expect(listed.problem).toBe('symlink_refused');
  });

  it('a missing file needs its parent directory', () => {
    const { store } = setup({ userDataDir: '/nowhere' });
    expect(() => store.read('languages')).toThrow(/directory does not exist/);
  });

  it('JOBAPPLIER_USER_DATA resolves exactly the user-data files into that directory', () => {
    const fs = memFs({ '/ud-elsewhere/languages.json': fx('languages.json'), '/proj/config/replies.json': fx('replies.json') });
    const store = createJsonStore({ fs, root: ROOT, env: { JOBAPPLIER_USER_DATA: '/ud-elsewhere' }, backupDir: BK, keep: 10, now });
    expect(store.pathOf('languages')).toBe('/ud-elsewhere/languages.json');
    expect(store.pathOf('fact-gate')).toBe('/ud-elsewhere/fact-gate.json');
    expect(store.pathOf('profile')).toBe('/ud-elsewhere/profile.json');
    expect(store.pathOf('easy-apply-answers')).toBe('/ud-elsewhere/easy-apply-answers.json');
    expect(store.pathOf('replies')).toBe('/proj/config/replies.json');
    expect(store.read('languages').exists).toBe(true);
  });

  it('linkedin-discovery resolves to config/linkedin-discovery.json', () => {
    const { store } = setup();
    expect(store.pathOf('linkedin-discovery')).toBe('/proj/config/linkedin-discovery.json');
  });

  it('list summarizes every registry entry', () => {
    const { store } = setup();
    const l = store.list();
    expect(l.length).toBe(18);
    expect(l.find((s) => s.id === 'portals')).toMatchObject({ exists: true, edit: true });
    expect(l.find((s) => s.id === 'ai-tells')).toMatchObject({ exists: false, edit: false });
  });
});

describe('plan', () => {
  it('validates, diffs and tiers', () => {
    const { store } = setup();
    const cur = store.read('replies');
    const p = store.plan('replies', '{\n  "auto_record_enabled": true\n}\n', cur.etag);
    expect(p.errors).toEqual([]);
    expect(p.diff.removed).toBe(1);
    expect(p.diff.added).toBe(1);
    expect(p.weakens).toBeTruthy();
    expect(p.tier).toBe('safety');
    expect(p.changedPaths).toBe(1);
    expect(p.restart).toBe('next_run');
    const plain = store.plan('replies', '{"auto_record_enabled": false, "x": 1}\n', cur.etag);
    expect(plain.tier).toBe('normal');
  });

  it('reports validation errors and a stale etag in the plan', () => {
    const { store } = setup();
    const cur = store.read('replies');
    expect(store.plan('replies', '{"auto_record_enabled":"no"}', cur.etag).errors[0]).toMatch(/^auto_record_enabled/);
    const stale = store.plan('replies', fx('replies.json'), 'old');
    expect(stale.stale).toBe(true);
    expect(stale.errors[0]).toBe('stale_etag');
  });

  it('refuses to plan an edit of a view-only file', () => {
    const { store } = setup({ files: { [`${ROOT}/config/ai-tells.json`]: '{}' } });
    const p = store.plan('ai-tells', '{"a":1}', store.read('ai-tells').etag);
    expect(p.errors[0]).toMatch(/view only/);
    expect(() => store.apply(p, '{"a":1}')).toThrow(/view only/);
  });

  it('cross-file warning comes through the store', () => {
    const { store } = setup();
    const t = JSON.parse(fx('target-regions.json'));
    t.remote_anywhere = false;
    const p = store.plan('target-regions', JSON.stringify(t, null, 2) + '\n', store.read('target-regions').etag);
    expect(p.errors).toEqual([]);
    expect(p.warnings.join()).toMatch(/keep the two in step/);
  });

  it('countChangedPaths counts leaves', () => {
    expect(countChangedPaths({ a: 1, b: [1, 2] }, { a: 2, b: [1, 3, 4] })).toBe(3);
    expect(countChangedPaths({ a: 1 }, { a: 1 })).toBe(0);
  });
});

describe('apply', () => {
  const NEW = '{\n  "auto_record_enabled": true\n}\n';

  it('writes the backup first (0600 in a 0700 directory), then temp + rename', () => {
    const { fs, store } = setup();
    const before = fx('replies.json');
    const cur = store.read('replies');
    const out = store.apply(store.plan('replies', NEW, cur.etag), NEW);
    expect(out.newEtag).toBe(etagOf(NEW));
    expect(fs.text(`${ROOT}/config/replies.json`)).toBe(NEW);
    const dir = `${BK}/files/replies`;
    expect(fs.modeOf(dir)).toBe(0o700);
    expect(fs.files(dir)).toEqual([out.backupId]);
    expect(out.backupId).toMatch(/^2026-10-16T12-00-\d\dZ-[0-9a-f]{8}\.json$|^2026-10-16T12-00-\d\d-\d{3}Z-[0-9a-f]{8}\.json$/);
    expect(out.backupId.endsWith(`${etagOf(before).slice(0, 8)}.json`)).toBe(true);
    expect(fs.modeOf(`${dir}/${out.backupId}`)).toBe(0o600);
    expect(fs.text(`${dir}/${out.backupId}`)).toBe(before);
    const ops = fs.log.filter((l) => l.startsWith('write:') || l.startsWith('rename:'));
    expect(ops[0]).toContain(`${dir}/`);
    expect(ops[1]).toMatch(/^write:.*replies\.json\.tmp-/);
    expect(ops[2]).toMatch(/^rename:.*->\/proj\/config\/replies\.json$/);
    expect(fs.paths().some((p) => p.includes('.tmp-'))).toBe(false);
    expect(store.read('replies').etag).toBe(out.newEtag);
  });

  it('writes user-data files with mode 0600', () => {
    const { fs, store } = setup();
    const t = JSON.parse(fx('languages.json'));
    t.confirmed = true;
    const text = JSON.stringify(t, null, 2) + '\n';
    const p = store.plan('languages', text, store.read('languages').etag);
    expect(p.tier).toBe('guarded');
    store.apply(p, text);
    expect(fs.modeOf(`${UD}/languages.json`)).toBe(0o600);
  });

  it('creates a missing file without a backup', () => {
    const { fs, store } = setup();
    const text = fx('profile.json');
    const out = store.apply(store.plan('profile', text, store.read('profile').etag), text);
    expect(out.backupId).toBe('');
    expect(fs.text(`${UD}/profile.json`)).toBe(text);
    expect(fs.files(`${BK}/files/profile`)).toEqual([]);
  });

  it('a failing rename leaves the original and removes the temp file', () => {
    const { fs, store } = setup();
    const cur = store.read('replies');
    const plan = store.plan('replies', NEW, cur.etag);
    fs.failOn('rename');
    expect(() => store.apply(plan, NEW)).toThrow(/original is unchanged/);
    expect(fs.text(`${ROOT}/config/replies.json`)).toBe(fx('replies.json'));
    expect(fs.paths().some((p) => p.includes('.tmp-'))).toBe(false);
  });

  it('a failing backup aborts before any change', () => {
    const { fs, store } = setup();
    const plan = store.plan('replies', NEW, store.read('replies').etag);
    fs.failOn('write', /settings-backups/);
    expect(() => store.apply(plan, NEW)).toThrow(/nothing was changed/);
    expect(fs.text(`${ROOT}/config/replies.json`)).toBe(fx('replies.json'));
    expect(fs.paths().some((p) => p.includes('.tmp-'))).toBe(false);
  });

  it('a stale etag returns stale_etag without writing', () => {
    const { fs, store } = setup();
    const plan = store.plan('replies', NEW, store.read('replies').etag);
    fs.put(`${ROOT}/config/replies.json`, '{"auto_record_enabled": false, "edited": "elsewhere"}');
    const writes = fs.log.length;
    let err: unknown;
    try {
      store.apply(plan, NEW);
    } catch (e) {
      err = e;
    }
    expect((err as SettingsError).code).toBe('stale_etag');
    expect(fs.text(`${ROOT}/config/replies.json`)).toContain('edited');
    expect(fs.log.slice(writes).some((l) => l.startsWith('write:') || l.startsWith('rename:'))).toBe(false);
    expect(fs.files(`${BK}/files/replies`)).toEqual([]);
  });

  it('refuses a plan with errors, a changed text and a plan marked stale', () => {
    const { store } = setup();
    const cur = store.read('replies');
    const bad = store.plan('replies', '{"auto_record_enabled":1}', cur.etag);
    expect(() => store.apply(bad, '{"auto_record_enabled":1}')).toThrow(/errors/);
    const ok = store.plan('replies', NEW, cur.etag);
    expect(() => store.apply(ok, NEW.replace('true', 'false'))).toThrow(/does not match/);
    const stale = store.plan('replies', NEW, 'old');
    let code = '';
    try {
      store.apply(stale, NEW);
    } catch (e) {
      code = (e as SettingsError).code;
    }
    expect(code).toBe('stale_etag');
  });

  it('retention keeps the newest SETTINGS_BACKUP_KEEP backups', () => {
    const { fs, store } = setup({ keep: 3 });
    let text = fx('deal-breakers.json');
    for (let i = 0; i < 6; i++) {
      const next = JSON.stringify({ keywords: ['k' + i] }) + '\n';
      store.apply(store.plan('deal-breakers', next, etagOf(text)), next);
      text = next;
    }
    const names = fs.files(`${BK}/files/deal-breakers`);
    expect(names.length).toBe(3);
    const newest = names[names.length - 1];
    expect(fs.text(`${BK}/files/deal-breakers/${newest}`)).toBe(JSON.stringify({ keywords: ['k4'] }) + '\n');
  });

  it('no-op when the text is unchanged', () => {
    const { fs, store } = setup();
    const t = fx('replies.json');
    const out = store.apply(store.plan('replies', t, etagOf(t)), t);
    expect(out.backupId).toBe('');
    expect(fs.files(`${BK}/files/replies`)).toEqual([]);
  });

  it('never touches the repo .env (guard installed, memFs only)', () => {
    const { store } = setup();
    store.list();
    expect(guard.blocked.every((p) => p.startsWith(repoRoot))).toBe(true);
  });
});

describe('user-data realpath and file modes', () => {
  it('follows a symlinked user-data directory consistently for existing and missing files', () => {
    const fs = memFs({ '/real-ud/languages.json': fx('languages.json'), '/proj/config/replies.json': fx('replies.json') });
    fs.symlink('/proj/user-data', '/real-ud');
    const store = createJsonStore({ fs, root: ROOT, userDataDir: '/proj/user-data', backupDir: BK, keep: 10, now });
    expect(store.pathOf('languages')).toBe('/real-ud/languages.json');
    expect(store.pathOf('profile')).toBe('/real-ud/profile.json');
    expect(store.read('languages').exists).toBe(true);
    expect(store.read('profile').exists).toBe(false);
    const text = fx('profile.json');
    store.apply(store.plan('profile', text, store.read('profile').etag), text);
    expect(fs.text('/real-ud/profile.json')).toBe(text);
  });

  it('JOBAPPLIER_USER_DATA through a symlink resolves to the real directory', () => {
    const fs = memFs({ '/data/ud/fact-gate.json': fx('fact-gate.json') });
    fs.symlink('/link-ud', '/data/ud');
    const store = createJsonStore({ fs, root: ROOT, env: { JOBAPPLIER_USER_DATA: '/link-ud' }, backupDir: BK, keep: 10, now });
    expect(store.pathOf('fact-gate')).toBe('/data/ud/fact-gate.json');
    expect(store.read('fact-gate').exists).toBe(true);
  });

  it('a file symlink inside the directory is still refused', () => {
    const fs = memFs({});
    fs.mkdirp('/real-ud');
    fs.symlink('/real-ud/profile.json', '/x.json');
    fs.symlink('/ud', '/real-ud');
    const store = createJsonStore({ fs, root: ROOT, userDataDir: '/ud', backupDir: BK, keep: 10, now });
    expect(() => store.read('profile')).toThrow(/symbolic link/);
  });

  it('keeps an existing config file mode (0600 stays 0600); new config files get 0644', () => {
    const { fs, store } = setup();
    fs.chmod(`${ROOT}/config/replies.json`, 0o600);
    const NEW = '{"auto_record_enabled": false, "x": 1}\n';
    store.apply(store.plan('replies', NEW, store.read('replies').etag), NEW);
    expect(fs.modeOf(`${ROOT}/config/replies.json`)).toBe(0o600);
    const t = fx('replies.json');
    const s2 = createJsonStore({ fs, root: ROOT, userDataDir: UD, backupDir: BK, keep: 10, now });
    fs.put(`${ROOT}/config/linkedin-discovery.json`, '{}', 0o640);
    const d = JSON.stringify({ jobs: [], posts: [] });
    s2.apply(s2.plan('linkedin-discovery', d, s2.read('linkedin-discovery').etag), d);
    expect(fs.modeOf(`${ROOT}/config/linkedin-discovery.json`)).toBe(0o640);
    expect(t).toBeTruthy();
    const f2 = memFs({ '/proj/config/x': '' });
    const s3 = createJsonStore({ fs: f2, root: ROOT, userDataDir: UD, backupDir: BK, keep: 10, now });
    s3.apply(s3.plan('replies', t, s3.read('replies').etag), t);
    expect(f2.modeOf(`${ROOT}/config/replies.json`)).toBe(0o644);
  });
});

describe('writeWithBackup (generic, also used for .env)', () => {
  it('works for an .env style target with its own extension', () => {
    const fs = new MemFs({ '/p/.env': 'A=1\n' });
    const out = writeWithBackup({ fs, path: '/p/.env', text: 'A=2\n', expectEtag: etagOf('A=1\n'), backupDir: '/p/.jobber/settings-backups/env', backupExt: '.env', keep: 2, now });
    expect(out.backupId).toMatch(/\.env$/);
    expect(fs.text('/p/.env')).toBe('A=2\n');
    expect(fs.modeOf('/p/.env')).toBe(0o600);
    expect(fs.text(`/p/.jobber/settings-backups/env/${out.backupId}`)).toBe('A=1\n');
  });
});
