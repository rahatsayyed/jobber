import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { observeAts, bucket } from '../src/layout/fingerprint.js';
import { ATS_KINDS, ATS_LANDMARKS, COUNT_KEYS, ID_RE, isAtsPlatform, kindsFor, landmarksFor } from '../src/layout/vocab.js';
import { createLayoutObserver } from '../src/layout/runtime.js';
import { loadLayoutConfig, type LayoutConfig } from '../src/layout/config.js';
import { loadLayout, parseLayoutText } from '../src/layout/store.js';
import { extractFormModel } from '../src/webcore/formModel.js';
import { loadFixture } from './helpers/fixtureSite.js';
import { main, type CliDeps } from '../scripts/layout.js';

const FIXTURES = fs.readdirSync(path.join(__dirname, 'fixtures', 'web')).filter((f) => f.endsWith('.html'));
const NOW = new Date('2026-10-16T10:00:00.000Z');

describe('observeAts', () => {
  it('there are fixtures to test', () => { expect(FIXTURES.length).toBeGreaterThan(15); });

  it('observeAts output has only vocabulary ids (property test over every fixture)', () => {
    for (const name of FIXTURES) {
      const snap = loadFixture(name, 'https://boards.greenhouse.io/acme/jobs/1');
      const model = extractFormModel(snap);
      const o = observeAts(model, 'ats_greenhouse');
      expect(o.platform, name).toBe('ats_greenhouse');
      expect(ATS_KINDS, name).toContain(o.kind);
      for (const l of o.landmarks) { expect(ATS_LANDMARKS, `${name} ${l}`).toContain(l); expect(l).toMatch(ID_RE); }
      expect([...o.landmarks]).toEqual([...o.landmarks].sort());
      for (const [k, v] of Object.entries(o.counts)) { expect(COUNT_KEYS).toContain(k); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(4); }
      // no page text: no label, option, notice, title or url survives in the serialized observation
      const text = JSON.stringify(o);
      const words = [snap.title, ...snap.fields.map((f) => f.label), ...snap.controls.map((c) => c.label), ...snap.notices, snap.url]
        .map((s) => (s ?? '').trim()).filter((s) => s.length >= 5);
      for (const w of words) expect(text.includes(w), `${name}: ${w}`).toBe(false);
      expect(['blocked', 'unloaded', null]).toContain(o.nonDrift);
    }
  });

  it('maps step kinds, blocks and roles', () => {
    const form = observeAts(extractFormModel(loadFixture('ats-a-form.html')), 'ats_greenhouse');
    expect(form).toMatchObject({ kind: 'form', shell: true, nonDrift: null });
    expect(form.landmarks).toEqual(expect.arrayContaining(['field:name.first', 'field:email', 'field:resume', 'control:submit']));
    expect(form.landmarks).not.toContain('field:unknown_role');
    const wall = observeAts(extractFormModel(loadFixture('captcha-wall.html')), 'ats_greenhouse');
    expect(wall.nonDrift).toBe('blocked');
    expect(observeAts(extractFormModel(loadFixture('ats-a-confirmation.html')), 'ats_greenhouse').kind).toBe('confirmation');
    // a platform name outside the grammar is folded, never copied
    expect(observeAts(extractFormModel(loadFixture('ats-a-form.html')), '../evil' as never).platform).toBe('ats_other');
    expect(bucket(5)).toBe(3);
  });

  it('platform grammar and per-platform vocabulary', () => {
    expect(isAtsPlatform('ats_greenhouse')).toBe(true);
    for (const bad of ['ats_', 'ats_UP', 'ats_a b', 'linkedin', 'ats_../x', 'ats_' + 'a'.repeat(40)]) expect(isAtsPlatform(bad), bad).toBe(false);
    expect(kindsFor('ats_x')).toEqual(ATS_KINDS);
    expect(kindsFor('linkedin')).toContain('profile');
    expect(landmarksFor('ats_x')).toEqual(ATS_LANDMARKS);
  });
});

describe('ats layout memory', () => {
  let dir: string;
  let cfg: LayoutConfig;
  beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-atsl-'))); cfg = { ...loadLayoutConfig({}), dir: path.join(dir, 'layout') }; });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const model = () => extractFormModel(loadFixture('ats-a-form.html', 'https://boards.greenhouse.io/acme/jobs/1'));

  it('learns a variant after N observations over R runs and then matches', () => {
    const verdicts = ['ra', 'rb', 'ra', 'rb'].map((run) => createLayoutObserver({ platform: 'ats_greenhouse', cfg, now: () => NOW, runId: run }).observeAts(model()));
    expect(verdicts.slice(0, 3).map((v) => v.class)).toEqual(['unknown', 'unknown', 'unknown']);
    expect(verdicts[3].class).toBe('match');
    const file = path.join(cfg.dir, 'ats_greenhouse.json');
    const text = fs.readFileSync(file, 'utf8');
    expect(parseLayoutText(text, 'ats_greenhouse').ok).toBe(true);
    expect(loadLayout(file, 'ats_greenhouse', NOW).note).toBeNull();
    // a file written for one platform is not valid for another
    expect(parseLayoutText(text, 'ats_lever').ok).toBe(false);
    expect(parseLayoutText(text, 'linkedin').ok).toBe(false);
  });

  it('the observer ignores snapshots of other kinds of platform', () => {
    const li = createLayoutObserver({ platform: 'linkedin', cfg, now: () => NOW, runId: 'r' });
    expect(li.observeAts(model()).class).toBe('unknown');
    expect(fs.existsSync(path.join(cfg.dir, 'linkedin.json'))).toBe(false);
  });

  it('layout CLI lists ats_ platforms', async () => {
    for (const run of ['ra', 'rb', 'ra']) createLayoutObserver({ platform: 'ats_greenhouse', cfg, now: () => NOW, runId: run }).observeAts(model());
    const out: string[] = []; const errs: string[] = [];
    const db = openDb(':memory:');
    const d: CliDeps = { cfg, now: () => NOW, db: () => db, prompt: async () => 'yes', out: (l) => out.push(l), err: (l) => errs.push(l) };
    expect(await main(['status'], d)).toBe(0);
    expect(out.join('\n')).toMatch(/^ats_greenhouse: enforce=/m);
    expect(out.join('\n')).toContain('form: ');
    out.length = 0;
    expect(await main(['show', 'ats_greenhouse'], d)).toBe(0);
    expect(out.join('\n')).toContain('form');
    out.length = 0;
    expect(await main(['learn', 'ats_greenhouse'], d)).toBe(0);
    expect(await main(['reset', 'ats_greenhouse', '--kind', 'form', '--yes'], d)).toBe(0);
    expect(await main(['show', 'ats_not valid'], d)).toBe(2);
    expect(await main(['reset', 'ats_greenhouse', '--kind', 'profile', '--yes'], d)).toBe(2);   // a LinkedIn kind is not an ATS kind
  });
});
