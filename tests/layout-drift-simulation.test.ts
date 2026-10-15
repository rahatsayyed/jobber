// Plan 8B task 4: end-to-end drift simulation over synthetic HTML fixtures.
// LinkedIn fixtures go through buildSnapshotFromHtml + detectBlock; Naukri has no HTML builder, so
// the fixture is reduced to a NaukriRawSnapshot structurally with the shared HTML parser below.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSnapshotFromHtml } from '../src/linkedin/snapshot.js';
import { parseHtml, findAll, textOf, type HtmlNode } from '../src/linkedin/htmlVisible.js';
import { detectBlock } from '../src/linkedin/state.js';
import { observeLinkedin, observeNaukri, type NaukriRawSnapshot } from '../src/layout/fingerprint.js';
import { applyObservation } from '../src/layout/classify.js';
import { loadLayoutConfig } from '../src/layout/config.js';
import { loadLayout, saveLayout } from '../src/layout/store.js';
import { detectLoginRequired } from '../src/mcp/naukri.js';
import type { Observation, Platform } from '../src/layout/types.js';

const cfg = loadLayoutConfig({}, '/proj');
const T0 = new Date('2026-10-15T00:00:00.000Z');

const li = (n: string) => fs.readFileSync(new URL(`./fixtures/layout/linkedin/${n}.html`, import.meta.url), 'utf8');
const nk = (n: string) => fs.readFileSync(new URL(`./fixtures/layout/naukri/${n}.html`, import.meta.url), 'utf8');

const PROFILE = 'https://www.linkedin.com/in/alex-example/';
const SEARCH = 'https://www.linkedin.com/search/results/people/';

function liObs(name: string, url: string): Observation {
  const raw = buildSnapshotFromHtml(li(name), url);
  return observeLinkedin(raw, detectBlock(raw));
}

function naukriRaw(html: string, url: string): NaukriRawSnapshot {
  const root = parseHtml(html);
  const text = (n: HtmlNode) => textOf(n).replace(/\s+/g, ' ').trim();
  const chat = findAll(root, (n) => (n.attrs['class'] ?? '').split(/\s+/).includes('chatbot'))[0];
  const inChat = (n: HtmlNode) => !!chat && findAll(chat, (m) => m === n).length > 0;
  const hasClass = (n: HtmlNode, c: string) => (n.attrs['class'] ?? '').split(/\s+/).includes(c);
  const title = findAll(root, (n) => n.tag === 'title')[0];
  const input = chat ? findAll(chat, (n) => n.tag === 'input')[0] : undefined;
  const send = chat ? findAll(chat, (n) => n.tag === 'button' && hasClass(n, 'send'))[0] : undefined;
  return {
    title: title ? text(title) : '',
    url,
    buttons: findAll(root, (n) => n.tag === 'button' && !inChat(n)).map(text).filter(Boolean),
    chatbot: {
      open: !!chat,
      messages: chat
        ? findAll(chat, (n) => hasClass(n, 'msg')).map((n) => ({ from: hasClass(n, 'user') ? 'user' as const : 'bot' as const, text: text(n) }))
        : [],
      placeholder: input ? (input.attrs['placeholder'] ?? '') : null,
      sendLabel: send ? text(send) : null,
      options: chat ? findAll(chat, (n) => hasClass(n, 'opt')).map(text) : [],
    },
    notices: findAll(root, (n) => n.attrs['role'] === 'alert').map(text).filter(Boolean),
    hasPasswordInput: findAll(root, (n) => n.tag === 'input' && (n.attrs['type'] ?? '').toLowerCase() === 'password').length > 0,
  };
}
const JOB = 'https://www.naukri.com/job-listings-react-developer-example-labs-pune-2-to-5-years-111222333';
function nkObs(name: string, url: string): Observation {
  const raw = naukriRaw(nk(name), url);
  return observeNaukri(raw, { loginRequired: detectLoginRequired(raw) });
}

let dir: string;
let tick: number;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-sim-'));
  tick = 0;
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

// One persisted step: load, apply, save (what a tool call will do), 1 hour apart.
function feeder(platform: Platform) {
  const file = path.join(dir, `${platform}.json`);
  return {
    file,
    feed(o: Observation, runId: string) {
      const now = new Date(T0.getTime() + tick++ * 3_600_000);
      const { file: f } = loadLayout(file, platform, now, cfg.maxBytes);
      const r = applyObservation(f, o, { now, runId }, cfg);
      saveLayout(file, r.file, cfg.maxBytes, platform);
      return r;
    },
    read: () => loadLayout(file, platform, T0, cfg.maxBytes).file,
  };
}

function learnProfileV1(f: ReturnType<typeof feeder>) {
  const v1 = liObs('profile-v1', PROFILE);
  expect(f.feed(v1, 'r1').verdict.class).toBe('unknown');
  f.feed(v1, 'r1');
  const third = f.feed(v1, 'r2');
  expect(third.events).toContain('promoted');
  return v1;
}

describe('fixtures produce the expected landmark sets', () => {
  it('profile v1 / v2 / search', () => {
    expect(liObs('profile-v1', PROFILE).landmarks).toEqual(expect.arrayContaining(['profile.name', 'profile.headline', 'profile.bell']));
    const v2 = liObs('profile-v2', PROFILE);
    expect(v2.landmarks).toEqual(expect.arrayContaining(['profile.name', 'profile.headline']));
    expect(v2.landmarks).not.toContain('profile.bell');
    expect(liObs('search-v1', SEARCH).landmarks).toContain('results.cards');
    expect(liObs('search-v2', SEARCH).landmarks).not.toContain('results.cards');
    expect(liObs('search-v2', SEARCH).shell).toBe(true);
  });
});

describe('linkedin profile drift simulation', () => {
  it('learns v1, flags v2 as drift, then learns v2 as a second variant (A/B)', () => {
    const f = feeder('linkedin');
    const v1 = learnProfileV1(f);
    expect(f.feed(v1, 'r3').verdict.class).toBe('match');
    const promotedBefore = f.read().kinds.profile.variants.filter((v) => v.promoted);
    expect(promotedBefore).toHaveLength(1);

    const v2 = liObs('profile-v2', PROFILE);
    const once = f.feed(v2, 'r4');
    expect(once.verdict.class).toBe('drift');
    const afterOnce = f.read().kinds.profile;
    // the promoted v1 variant is untouched; v2 is only a learning candidate
    const stillPromoted = afterOnce.variants.filter((v) => v.promoted);
    expect(stillPromoted).toEqual(promotedBefore);
    expect(afterOnce.variants.some((v) => !v.promoted)).toBe(true);
    expect(afterOnce.state).toBe('drifted');

    f.feed(v2, 'r4');
    const prom = f.feed(v2, 'r5');
    expect(prom.events).toContain('promoted');
    expect(f.feed(v2, 'r5').verdict.class).toBe('match');
    expect(f.feed(v1, 'r6').verdict.class).toBe('match');
    const km = f.read().kinds.profile;
    expect(km.variants.filter((v) => v.promoted)).toHaveLength(2);
    expect(km.state).toBe('stable');
    expect(km.drift_streak).toBe(0);
  });

  it('search v2 (card container changed) is drift and is never learned', () => {
    const f = feeder('linkedin');
    const s1 = liObs('search-v1', SEARCH);
    f.feed(s1, 'r1'); f.feed(s1, 'r1'); f.feed(s1, 'r2');
    expect(f.feed(s1, 'r3').verdict.class).toBe('match');
    const s2 = liObs('search-v2', SEARCH);
    expect(f.feed(s2, 'r4').verdict.class).toBe('drift');
    expect(f.read().kinds.search.variants.filter((v) => v.promoted)).toHaveLength(1);
    expect(f.read().kinds.search.variants).toHaveLength(1);
  });
});

describe('non-drift pages never move counters', () => {
  it('logged-out, blocked and unloaded pages leave the stored file unchanged', () => {
    const f = feeder('linkedin');
    learnProfileV1(f);
    const before = fs.readFileSync(f.file, 'utf8');
    const cases: Array<[string, string, string]> = [
      ['profile-logged-out', 'https://www.linkedin.com/login', 'logged_out'],
      ['block-captcha', 'https://www.linkedin.com/checkpoint/challenge/', 'blocked'],
      ['unloaded', PROFILE, 'unloaded'],
    ];
    for (const [name, url, cls] of cases) {
      const r = f.feed(liObs(name, url), 'r9');
      expect(r.verdict.class).toBe(cls);
      expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
      const k = f.read().kinds.profile;
      expect(k.counters).toEqual({ match: 0, partial: 0, drift: 0 });
      expect(k.drift_streak).toBe(0);
      expect(k.variants[0].obs).toBe(3);
      expect(k.variants[0].runs).toBe(2);
    }
  });

  it('a blocked or logged-out page on an empty store creates nothing', () => {
    const f = feeder('linkedin');
    f.feed(liObs('block-captcha', 'https://www.linkedin.com/checkpoint/challenge/'), 'r1');
    f.feed(liObs('profile-logged-out', 'https://www.linkedin.com/login'), 'r1');
    f.feed(liObs('unloaded', PROFILE), 'r1');
    expect(f.read().kinds).toEqual({});
  });
});

describe('corruption mid-sequence', () => {
  it('resets to learning without throwing, then relearns', () => {
    const f = feeder('linkedin');
    const v1 = learnProfileV1(f);
    fs.writeFileSync(f.file, '{ not json');
    let r!: ReturnType<typeof f.feed>;
    expect(() => { r = f.feed(v1, 'r7'); }).not.toThrow();
    expect(r.verdict.class).toBe('unknown');
    const km = f.read().kinds.profile;
    expect(km.state).toBe('learning');
    expect(km.variants.every((v) => !v.promoted)).toBe(true);
    f.feed(v1, 'r7'); f.feed(v1, 'r8');
    expect(f.feed(v1, 'r8').verdict.class).toBe('match');
  });
});

describe('injected page text', () => {
  it('never reaches the stored JSON', () => {
    const f = feeder('linkedin');
    const o = liObs('profile-injected', PROFILE);
    expect(o.landmarks).toContain('action:other');
    f.feed(o, 'r1'); f.feed(o, 'r1'); f.feed(o, 'r2');
    const text = fs.readFileSync(f.file, 'utf8');
    expect(text).not.toContain('SYSTEM');
    expect(text).not.toContain('a@b.c');
    expect(text).not.toContain('resume');
    expect(f.read().kinds.profile.variants[0].promoted).toBe(true);
  });
});

describe('naukri chatbot drift simulation', () => {
  it('learns v1, flags v2 as drift, then holds both variants', () => {
    const f = feeder('naukri');
    const v1 = nkObs('chatbot-v1', JOB);
    expect(v1.landmarks).toEqual(expect.arrayContaining(['button:apply', 'chat.open', 'chat.input', 'chat.send', 'chat.options']));
    f.feed(v1, 'r1'); f.feed(v1, 'r1'); f.feed(v1, 'r2');
    expect(f.feed(v1, 'r3').verdict.class).toBe('match');
    const v2 = nkObs('chatbot-v2', JOB);
    expect(v2.landmarks).toContain('button:apply');
    expect(f.feed(v2, 'r4').verdict.class).toBe('drift');
    f.feed(v2, 'r4'); f.feed(v2, 'r5');
    expect(f.feed(v2, 'r5').verdict.class).toBe('match');
    expect(f.feed(v1, 'r6').verdict.class).toBe('match');
    expect(f.read().kinds.job.variants.filter((v) => v.promoted)).toHaveLength(2);
  });

  it('logged-out never moves counters', () => {
    const f = feeder('naukri');
    const v1 = nkObs('chatbot-v1', JOB);
    f.feed(v1, 'r1'); f.feed(v1, 'r1'); f.feed(v1, 'r2');
    const lo = nkObs('logged-out', 'https://www.naukri.com/nlogin/login');
    expect(lo.nonDrift).toBe('logged_out');
    expect(f.feed(lo, 'r3').verdict.class).toBe('logged_out');
    const k = f.read().kinds.job;
    expect(k.counters).toEqual({ match: 0, partial: 0, drift: 0 });
    expect(k.variants[0].obs).toBe(3);
  });
});
