// Shadow roots, same-origin iframes and failure diagnostics in browserctl.
// Part 1 runs the real in-page script (bcScript) over a tiny DOM double with open and closed shadow roots.
// Part 2 drives the engine over fixtures that spell shadow roots as <template shadowrootmode="open">:
// a LinkedIn invite dialog and a Naukri apply chatbot and confirmation inside a shadow root keep the exact
// commit rules. Part 3 checks the .jobber/diag file (structure only, 0600, at most 8 KB, redacted).
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { countSince } from '../src/outreach/limits.js';
import { buildTreeFromHtml, renderTree, flattenShadowFixture, type RawTree } from '../src/browserctl/snapshot.js';
import { safeName, DIAG_MAX_BYTES } from '../src/browserctl/diag.js';
import { el, iframe, runBc, shadow, FEl } from './helpers/miniDom.js';
import { LIVE_ENV, NOTE, URL_, inviteDialog, profileHtml, refOf, world, type World } from './helpers/bcWorld.js';
import { JOB_ID, JOB_URL, jobHtml, nkWorld, refOf as nkRef, type NkWorld } from './helpers/nkWorld.js';

const worlds: World[] = [];
const nks: NkWorld[] = [];
const mk = (o: Parameters<typeof world>[0]) => { const w = world(o); worlds.push(w); return w; };
const mkNk = (o: Parameters<typeof nkWorld>[0]) => { const w = nkWorld(o); nks.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.cleanup(); for (const w of nks.splice(0)) w.cleanup(); });
const clicks = (w: { page: { log: string[] } }) => w.page.log.filter((l) => l.startsWith('click'));
const SINCE = new Date('2026-10-01T00:00:00Z');

// ---- part 1: the in-page script over a DOM double ----
const inviteInShadow = (): FEl => {
  const dialog = el('div', { role: 'dialog', 'aria-labelledby': 'h' },
    el('h2', { id: 'h' }, 'Add a note to your invitation?'),
    el('p', {}, 'Personalize your invitation to Jane Example by adding a note'),
    el('button', { 'aria-label': 'Dismiss' }),
    el('textarea', {}),
    el('div', { class: 'artdeco-modal__actionbar' },
      el('button', {}, 'Add a note'), el('button', {}, 'Send without a note'), el('button', {}, 'Send')));
  const outlet = shadow(el('div', { id: 'interop-outlet' }), [el('div', { class: 'theme' }, dialog)]);
  return el('body', {}, el('main', {}, el('h1', {}, 'Jane Example'), el('a', { href: '/in/jane-example/', 'aria-label': 'Invite Jane Example to connect' })), outlet);
};

describe('in-page script pierces open shadow roots', () => {
  it('sees the invite dialog, its controls and the composer inside a shadow root', () => {
    const t = runBc<RawTree>(inviteInShadow(), 'snapshot')!;
    const dlg = t.nodes.find((x) => x.role === 'dialog')!;
    expect(dlg).toBeTruthy();
    expect(dlg.name).toBe('Add a note to your invitation?');
    const inDialog = t.nodes.filter((x) => x.dialog === dlg.n);
    const names = inDialog.filter((x) => x.role === 'button').map((x) => x.name);
    expect(names).toEqual(['Dismiss', 'Add a note', 'Send without a note', 'Send'].map((n) => n));
    expect(inDialog.find((x) => x.role === 'textbox')).toMatchObject({ composer: true });
    expect(inDialog.find((x) => x.name === 'Send')).toMatchObject({ inFooter: true, dialogName: 'Add a note to your invitation?' });
    expect(renderTree(t, 3)).toContain('dialog "Add a note to your invitation?" (open)');
  });

  it('describe finds a stamped element inside the shadow root, with its dialog context', () => {
    const body = inviteInShadow();
    const t = runBc<RawTree>(body, 'snapshot')!;
    const send = t.nodes.find((x) => x.role === 'button' && x.name === 'Send')!;
    const live = runBc<RawTree['nodes'][number]>(body, 'describe', { n: send.n })!;
    expect(live).toMatchObject({ role: 'button', name: 'Send', dialogName: 'Add a note to your invitation?' });
  });

  it('a hidden shadow host hides its shadow content; a closed root stays unseen and is counted as a candidate', () => {
    const hiddenHost = shadow(el('div', { style: 'display:none' }), [el('button', {}, 'Secret')]);
    const closedHost = shadow(el('artdeco-modal', {}), [el('button', {}, 'Closed')], false);
    const body = el('body', {}, el('button', {}, 'Visible'), hiddenHost, closedHost);
    const t = runBc<RawTree>(body, 'snapshot')!;
    expect(t.nodes.filter((x) => x.role === 'button').map((x) => x.name)).toEqual(['Visible']);
    const d = runBc<{ shadowRoots: number; closedHostCandidates: number }>(body, 'diag')!;
    expect(d.shadowRoots).toBe(1);
    expect(d.closedHostCandidates).toBe(1);
  });

  it('enters a visible same-origin iframe and ignores a cross-origin one without failing', () => {
    const body = el('body', {}, el('button', {}, 'Outer'), iframe([el('button', {}, 'Inner')]), iframe([el('button', {}, 'Foreign')], true));
    const t = runBc<RawTree>(body, 'snapshot')!;
    expect(t.nodes.filter((x) => x.role === 'button').map((x) => x.name)).toEqual(['Outer', 'Inner']);
    expect(runBc<{ iframes: number }>(body, 'diag')!.iframes).toBe(2);
  });

  it('diag lists open dialogs with their button names and no other text', () => {
    const d = runBc<{ dialogs: { role: string; name: string; buttons: string[] }[] }>(inviteInShadow(), 'diag')!;
    expect(d.dialogs).toHaveLength(1);
    expect(d.dialogs[0].buttons).toEqual(['Dismiss', 'Add a note', 'Send without a note', 'Send']);
    expect(JSON.stringify(d)).not.toContain('Personalize');
  });
});

describe('fixture side: shadow templates and srcdoc iframes', () => {
  it('unwraps open shadow templates (nested too) and leaves plain and closed templates hidden', () => {
    const html = '<body><div><template shadowrootmode="open"><button>In shadow</button><div><template shadowrootmode="open"><button>Deeper</button></template></div></template></div>'
      + '<template><button>Plain template</button></template><div><template shadowrootmode="closed"><button>Closed</button></template></div></body>';
    expect(flattenShadowFixture(html)).not.toContain('<template shadowrootmode="open">');
    const t = buildTreeFromHtml(html, 'https://x.test/');
    expect(t.nodes.filter((x) => x.role === 'button').map((x) => x.name)).toEqual(['In shadow', 'Deeper']);
  });

  it('reads a srcdoc iframe', () => {
    const t = buildTreeFromHtml('<body><iframe srcdoc="&lt;button&gt;Framed&lt;/button&gt;"></iframe></body>', 'https://x.test/');
    expect(t.nodes.filter((x) => x.role === 'button').map((x) => x.name)).toEqual(['Framed']);
  });
});

// ---- part 2: engine rules unchanged for shadow-root elements ----
const shadowInvite = (o: { name?: string; note?: string } = {}): string => `<div id="interop-outlet"><template shadowrootmode="open"><div role="dialog" aria-labelledby="h">
<h2 id="h">Add a note to your invitation?</h2><p>Personalize your invitation to ${o.name ?? 'Jane Example'} by adding a note</p>
<button aria-label="Dismiss"></button><textarea>${o.note ?? NOTE}</textarea>
<footer><button>Add a note</button><button>Send without a note</button><button>Send</button></footer></div></template></div>`;
const page = (dialog = '') => profileHtml({ extra: dialog });

describe('LinkedIn invite dialog inside a shadow root', () => {
  it('Send without a note and Send are commit class: no armed intent means nothing is clicked', async () => {
    const w = mk({ html: page(shadowInvite()), env: LIVE_ENV });
    expect(await w.snap()).toContain('dialog "Add a note to your invitation?"');
    for (const name of ['Send', 'Send without a note']) {
      const r = await w.engine.click(refOf(await w.snap(), 'button', name));
      expect(r.code).toBe('no_armed_intent');
    }
    expect(clicks(w)).toEqual([]);
  });

  it('armed: the Send in the shadow dialog is verified (recipient, exact note) and sent once', async () => {
    const w = mk({ html: page(shadowInvite()), env: LIVE_ENV });
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE, job_id: 'j1', company: 'Acme' })).status).toBe('armed');
    const send = refOf(await w.snap(), 'button', 'Send');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page()); };
    const r = await w.engine.click(send);
    expect(r).toMatchObject({ ok: true, status: 'sent', code: 'sent' });
    expect(countSince(w.db, 'linkedin_invite', SINCE)).toBe(1);
  });

  it('a shadow dialog that addresses another person, or carries another note, is refused', async () => {
    const other = mk({ html: page(shadowInvite({ name: 'Mallory Evil' })), env: LIVE_ENV });
    expect((await other.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    expect((await other.engine.click(refOf(await other.snap(), 'button', 'Send'))).code).toBe('dialog_recipient_mismatch');
    expect(clicks(other)).toEqual([]);
    const text = mk({ html: page(shadowInvite({ note: 'a different note' })), env: LIVE_ENV });
    expect((await text.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    expect((await text.engine.click(refOf(await text.snap(), 'button', 'Send'))).code).toBe('intent_text_mismatch');
    expect(clicks(text)).toEqual([]);
  });

  it('the Connect open step finds the invite dialog that renders in a shadow root', async () => {
    const w = mk({ html: profileHtml(), env: LIVE_ENV });
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(page(shadowInvite())); };
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Connect'));
    expect(r).toMatchObject({ ok: true, code: 'dialog_opened' });
  });
});

const NK_SHADOW_CHAT = `<html><head><title>Software Engineer - Acme | Naukri</title></head><body><main><h1>Software Engineer</h1><p>Acme</p>
<div id="chat-host"><template shadowrootmode="open"><div class="chatbot_Drawer"><ul><li><p>How many years of experience do you have in React?</p></li></ul>
<div contenteditable="true" data-placeholder="Type message here"></div><button class="sendMsg">Save</button></div></template></div></main></body></html>`;
const NK_SHADOW_DONE = `<html><head><title>Software Engineer - Acme | Naukri</title></head><body><main><h1>Software Engineer</h1><p>Acme</p>
<div id="toast"><template shadowrootmode="open"><p>Applied to "Software Engineer"</p></template></div></main></body></html>`;

describe('Naukri apply chatbot and confirmation inside a shadow root', () => {
  it('a chatbot drawer in a shadow root is seen as a chatbot (composer) after Apply', async () => {
    const w = mkNk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(NK_SHADOW_CHAT); };
    expect((await w.armApply()).status).toBe('armed');
    const r = await w.engine.click(nkRef(await w.snap(), 'button', 'Apply'));
    expect(r).toMatchObject({ ok: true, code: 'chatbot_opened' });
  });

  it('a confirmation toast in a shadow root confirms the apply, recorded once', async () => {
    const w = mkNk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.setHtml(NK_SHADOW_DONE); };
    expect((await w.armApply()).status).toBe('armed');
    const r = await w.engine.click(nkRef(await w.snap(), 'button', 'Apply'));
    expect(r).toMatchObject({ ok: true, status: 'sent', code: 'applied' });
    expect(w.db.prepare('SELECT COUNT(*) AS n FROM applications WHERE job_id = ?').get(JOB_ID)).toMatchObject({ n: 1 });
  });

  it('the Apply control itself inside a shadow root is still the counted, armed Apply', async () => {
    const hostPage = '<html><head><title>Software Engineer - Acme | Naukri</title></head><body><main><h1>Software Engineer</h1><p>Acme</p>'
      + '<div><template shadowrootmode="open"><button>Apply</button></template></div></main></body></html>';
    const w = mkNk({ html: hostPage, url: JOB_URL, env: LIVE_ENV });
    const noIntent = await w.engine.click(nkRef(await w.snap(), 'button', 'Apply'));
    expect(noIntent.code).toBe('no_armed_intent');
    expect(clicks(w)).toEqual([]);
  });
});

// ---- part 3: diagnostics ----
const diagPath = (reason: string | undefined): string => {
  const m = /\(diag: ([^)]+)\)/.exec(reason ?? '');
  if (!m) throw new Error(`no diag path in reason: ${reason}`);
  return m[1];
};

describe('failure diagnostics', () => {
  it('no_dialog_after_connect writes one structure-only file and names it in the reason', async () => {
    const w = mk({ html: profileHtml(), env: LIVE_ENV });
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Connect'));
    expect(r).toMatchObject({ status: 'failed', code: 'no_dialog_after_connect' });
    const file = diagPath(r.reason);
    expect(file).toMatch(/linkedin-.*\.json$/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = readFileSync(file, 'utf8');
    expect(raw.length).toBeLessThanOrEqual(DIAG_MAX_BYTES);
    const j = JSON.parse(raw);
    expect(j).toMatchObject({ platform: 'linkedin', code: 'no_dialog_after_connect', url_changed: false, url_path: '/in/jane-example/', clicked: { role: 'button', name: 'Connect' } });
    expect(raw).not.toContain(NOTE);
    expect(raw).not.toContain('?');
  });

  it('url_changed is true when the click navigated; the typed note never reaches the file', async () => {
    const w = mk({ html: profileHtml(), env: LIVE_ENV });
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    w.page.onAct = (what) => { if (what.startsWith('click')) w.page.currentUrl = 'https://www.linkedin.com/preload/custom-invite/?vanityName=jane-example'; };
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Connect'));
    const j = JSON.parse(readFileSync(diagPath(r.reason), 'utf8'));
    expect(j.url_changed).toBe(true);
    expect(j.url_path).toBe('/preload/custom-invite/');
    expect(JSON.stringify(j)).not.toContain('vanityName');
  });

  it('an unconfirmed Send lists the open dialogs and their button names, redacted, without the note', async () => {
    const dlg = `<dialog open aria-label="Add a note">${'<h2>Add a note to your invitation?</h2>'}<p>Personalize your invitation to Jane Example by adding a note</p>
<textarea>${NOTE}</textarea><footer><button>Cancel</button><button>Send</button><button>Mail bob@example.com or +1 (555) 123-4567</button></footer></dialog>`;
    const w = mk({ html: profileHtml({ dialog: dlg }), env: LIVE_ENV });
    expect((await w.arm({ kind: 'connect_note', profile_url: URL_, text: NOTE })).status).toBe('armed');
    const r = await w.engine.click(refOf(await w.snap(), 'button', 'Send'));
    expect(r).toMatchObject({ status: 'unconfirmed', code: 'unconfirmed' });
    const raw = readFileSync(diagPath(r.reason), 'utf8');
    const j = JSON.parse(raw);
    expect(j.tree_dialogs[0].buttons).toEqual(['Cancel', 'Send', 'Mail [redacted] or [redacted]']);
    expect(raw).not.toContain('bob@example.com');
    expect(raw).not.toContain('555');
    expect(raw).not.toContain(NOTE);
    expect(raw).not.toContain('Personalize');
  });

  it('Naukri apply with no chatbot or confirmation writes a diag file', async () => {
    const w = mkNk({ html: jobHtml(), url: JOB_URL, env: LIVE_ENV });
    w.page.onAct = () => undefined;
    expect((await w.armApply()).status).toBe('armed');
    const r = await w.engine.click(nkRef(await w.snap(), 'button', 'Apply'));
    expect(r).toMatchObject({ status: 'unconfirmed', code: 'apply_click_ignored' });
    const j = JSON.parse(readFileSync(diagPath(r.reason), 'utf8'));
    expect(j).toMatchObject({ platform: 'naukri', code: 'apply_click_ignored', clicked: { role: 'button', name: 'Apply' } });
  });

  it('safeName strips controls, redacts email and phone, and caps the length', () => {
    expect(safeName('  a\u0000b\n c@d.io  ')).toBe('a b [redacted]');
    expect(safeName('x'.repeat(200)).length).toBe(60);
    expect(safeName('call 98765 43210 now')).toBe('call [redacted] now');
  });
});
