// Engine open waits for the page to settle; arm verification must not invalidate the operator's refs.
import { afterEach, describe, expect, it } from 'vitest';
import { LIVE_ENV, NOTE, URL_, profileHtml, refOf, world, type World } from './helpers/bcWorld.js';
import { JOB_ID, JOB_URL, THREAD_URL, jobHtml, nkWorld, refOf as nkRefOf, threadHtml, type NkWorld } from './helpers/nkWorld.js';
import { buildTreeFromHtml } from '../src/browserctl/snapshot.js';

const worlds: Array<World | NkWorld> = [];
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); });


describe('open: settle before the returned snapshot', () => {
  it('waits for a hydrating page (nodes grow) and returns the settled tree', async () => {
    const w = world({ html: profileHtml(), env: LIVE_ENV }); worlds.push(w);
    const late = profileHtml({ extra: '<button>Activity</button><a href="/in/x/details/about/">About</a>' });
    const early = profileHtml();
    let calls = 0;
    w.page.snapshot = async () => {
      calls += 1;
      const html = calls >= 2 ? late : early;
      w.page.setHtml(html);
      return { ...buildTreeFromHtml(html, w.page.url()), url: w.page.url() };
    };
    const r = await w.engine.open(URL_);
    expect(r.ok).toBe(true);
    expect(r.state).toContain('Activity');
    expect(calls).toBeGreaterThanOrEqual(4);
  });

  it('is bounded: a page that never stops changing still returns', async () => {
    const w = world({ html: profileHtml(), env: LIVE_ENV }); worlds.push(w);
    let calls = 0;
    w.page.snapshot = async () => {
      calls += 1;
      const html = profileHtml({ extra: '<button>x</button>'.repeat(1 + (calls % 50)) });
      w.page.setHtml(html);
      return { ...buildTreeFromHtml(html, w.page.url()), url: w.page.url() };
    };
    const r = await w.engine.open(URL_);
    expect(r.ok).toBe(true);
    expect(calls).toBeLessThan(60);
  });

  it('an empty first read is not treated as settled', async () => {
    const w = world({ html: profileHtml(), env: LIVE_ENV }); worlds.push(w);
    let calls = 0;
    w.page.snapshot = async () => {
      calls += 1;
      const empty = calls <= 3;
      return { url: w.page.url(), title: '', nodes: empty ? [] : buildTreeFromHtml(profileHtml(), w.page.url()).nodes };
    };
    const r = await w.engine.open(URL_);
    expect(r.state).toContain('Jane Example');
  });
});

describe('arm: refs from the latest operator snapshot stay valid', () => {
  it('linkedin: a ref taken before arming still works after arming', async () => {
    const w = world({ html: profileHtml(), env: LIVE_ENV }); worlds.push(w);
    const ref = refOf(await w.snap(), 'button', 'More');
    const before = w.engine.refs.epoch;
    const a = await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE });
    expect(a.status, JSON.stringify(a)).toBe('armed');
    expect(w.engine.refs.epoch).toBe(before);
    const r = await w.engine.click(ref);
    expect(r.code).toBe('clicked');
  });

  it('linkedin: a real page change during arm still makes the old ref stale', async () => {
    const w = world({ html: profileHtml(), env: LIVE_ENV }); worlds.push(w);
    const ref = refOf(await w.snap(), 'button', 'More');
    const a = await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE });
    expect(a.status).toBe('armed');
    // arm only re-reads the page it is on; a real change afterwards (the control is gone) still refuses the ref
    w.page.setHtml(profileHtml({ extra: '<button>Extra</button>' }).replace('<button>More</button>', '<button>Less</button>'));
    const r = await w.engine.click(ref);
    expect(['stale_ref', 'target_changed', 'target_gone']).toContain(r.code);
  });

  it('naukri arm_apply keeps the epoch when the page is unchanged', async () => {
    const w = nkWorld({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV }); worlds.push(w);
    const ref = nkRefOf(await w.snap(), 'button', 'Save job');
    const before = w.engine.refs.epoch;
    expect((await w.armApply({ job_id: JOB_ID })).status).toBe('armed');
    expect(w.engine.refs.epoch).toBe(before);
    expect((await w.engine.click(ref)).code).toBe('clicked');
  });

  it('naukri arm_send keeps the epoch when the page is unchanged', async () => {
    const w = nkWorld({ html: threadHtml(), url: THREAD_URL, env: LIVE_ENV }); worlds.push(w);
    await w.snap();
    const before = w.engine.refs.epoch;
    expect((await w.armSend()).status).toBe('armed');
    expect(w.engine.refs.epoch).toBe(before);
  });

  it('naukri: page change during arm makes old refs stale', async () => {
    const w = nkWorld({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV }); worlds.push(w);
    const ref = nkRefOf(await w.snap(), 'button', 'Save job');
    w.page.onAct = (what) => { if (what.startsWith('goto')) w.page.setHtml(jobHtml().replace('Save job', 'Saved')); };
    expect((await w.armApply({ job_id: JOB_ID })).status).toBe('armed');
    expect(['stale_ref', 'target_changed', 'target_gone']).toContain((await w.engine.click(ref)).code);
  });
});
