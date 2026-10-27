// A locator-capable page double for a modal in a CLOSED shadow root: only getByRole locators can see it
// (the fake BcPage's walker tree never contains it). Mirrors what the live probe saw on a LinkedIn profile:
// getByRole('dialog') count 1, buttons Dismiss / Add a note / Send without a note, one textbox.
import type { LdLocator, LdPage } from '../../src/browserctl/locatorDialogs.js';

export interface Ctl { role: string; name: string; value?: string; type?: string }
export interface Box { x: number; y: number; width: number; height: number }
interface El { role: string; label: string; text: string; value: string; type: string; ctl?: Ctl; dlg?: boolean; menu?: boolean; box?: Box }

export interface ShadowWorld {
  page: LdPage;
  /** Every locator click, as `<role>:<name>`. */
  clicks: string[];
  fills: string[];
  isOpen(): boolean;
  /** Show the first step of the invite modal ("Dismiss", "Add a note", "Send without a note"). */
  // noHeading: the dialog has no heading and no aria-label, so it has no name (only its text and buttons tell what it is).
  // appearAfterMs: the dialog is not visible to any locator until that much time advanced (LinkedIn opens it seconds after the click).
  // roleBlind: the role tree lists no control under the dialog (only text); the controls are still reachable by a CSS locator.
  // labelOnly: a button carries its label in aria-label and a span child (no own text).
  open(o?: { name?: string; fillAfterMs?: number; noHeading?: boolean; appearAfterMs?: number; roleBlind?: boolean; labelOnly?: boolean }): void;
  close(): void;
  /** Change what the textbox holds without any fill call (a page that rewrote the field). */
  setBox(v: string): void;
  /** Called after a click that did not close the dialog (default behaviour covers the invite flow). */
  sendCount(): number;
  // An open menu (role menu, invisible to the walker). A Connect item opens the invite modal.
  openMenu(items?: string[], o?: { fillAfterMs?: number }): void;
  // Time passes: a dialog or menu opened with fillAfterMs shows no controls until that much time advanced.
  advance(ms: number): void;
  // Total time advanced since the dialog or menu opened.
  elapsed(): number;
  // Box of a control as the locator layer reports it; null when it is not shown.
  boxOf(role: string, name: string): Box | null;
  // A real mouse click at a viewport point: the shown control containing it gets clicked. Returns whether one was hit.
  mouseClick(x: number, y: number): boolean;
  closeMenu(): void;
  isMenuOpen(): boolean;
}

export function shadowWorld(): ShadowWorld {
  let open = false;
  let recipient = 'Jane Example';
  let step: 'first' | 'note' = 'first';
  let box = '';
  let sent = 0;
  let menuOpen = false;
  let menuItems: string[] = [];
  let time = 0;
  let fillAt = 0;
  let menuFillAt = 0;
  let noHeading = false;
  let appearAt = 0;
  let roleBlind = false;
  let labelOnly = false;
  const clicks: string[] = [];
  const fills: string[] = [];

  const allCtls = (): Ctl[] => step === 'first'
    ? [{ role: 'heading', name: 'Add a note to your invitation?' }, { role: 'button', name: 'Dismiss' },
      { role: 'button', name: 'Add a note' }, { role: 'button', name: 'Send without a note' }]
    : [{ role: 'heading', name: 'Add a note to your invitation?' }, { role: 'button', name: 'Dismiss' },
      { role: 'textbox', name: 'Add a note', type: 'text', value: box }, { role: 'button', name: 'Send' }];
  const ctls = (): Ctl[] => (time < appearAt + fillAt ? [] : allCtls().filter((c) => !(noHeading && c.role === 'heading')));
  const shownItems = (): string[] => (time < menuFillAt ? [] : menuItems);
  const DLG_BOX: Box = { x: 300, y: 100, width: 400, height: 300 };
  const MENU_BOX: Box = { x: 600, y: 200, width: 200, height: 200 };
  const ctlBox = (i: number): Box => ({ x: 320, y: 150 + i * 50, width: 360, height: 40 });
  const itemBox = (i: number): Box => ({ x: 610, y: 210 + i * 30, width: 180, height: 25 });
  const textOf = (): string => [`Personalize your invitation to ${recipient} by adding a note`, ...ctls().filter((c) => c.role !== 'textbox').map((c) => c.name)].join('\n');
  const toEl = (c: Ctl): El => ({ role: c.role, label: (c.role === 'button' && (c.name === 'Dismiss' || labelOnly)) || c.role === 'textbox' ? c.name : '', text: c.role === 'textbox' ? '' : c.name,
    value: c.role === 'textbox' ? box : '', type: c.type ?? '', ctl: c, box: ctlBox(ctls().findIndex((x) => x.role === c.role && x.name === c.name)) });
  const dialogEl = (): El => ({ role: 'dialog', label: '', text: textOf(), value: '', type: '', dlg: true, box: DLG_BOX });

  const menuEl = (): El => ({ role: 'menu', label: '', text: shownItems().join('\n'), value: '', type: '', menu: true, box: MENU_BOX });
  const click = (e: El): void => {
    if (!e.ctl) return;
    clicks.push(`${e.ctl.role}:${e.ctl.name}`);
    if (e.ctl.role === 'menuitem') {
      menuOpen = false;
      if (e.ctl.name === 'Connect') { open = true; step = 'first'; box = ''; }
      return;
    }
    if (e.ctl.name === 'Dismiss') open = false;
    else if (e.ctl.name === 'Add a note') step = 'note';
    else if (e.ctl.name === 'Send' || e.ctl.name === 'Send without a note') { sent++; open = false; }
  };

  const loc = (list: () => El[]): LdLocator => {
    const one = (): El => { const l = list(); if (l.length !== 1) throw new Error(`locator resolved to ${l.length} elements`); return l[0]; };
    return {
      count: async () => list().length,
      nth: (i) => loc(() => list().slice(i, i + 1)),
      first: () => loc(() => list().slice(0, 1)),
      locator: () => loc(() => list().flatMap((e) => (e.dlg ? ctls().filter((c) => c.role !== 'heading').map(toEl) : []))),
      getByRole: (role) => loc(() => list().flatMap((e) => (e.dlg ? (roleBlind && role !== 'heading' ? [] : ctls().filter((c) => c.role === role).map(toEl))
        : e.menu && role === 'menuitem' ? shownItems().map((m, i) => ({ ...toEl({ role: 'menuitem', name: m }), box: itemBox(i) })) : []))),
      boundingBox: async () => one().box ?? null,
      innerText: async () => one().text,
      inputValue: async () => one().value,
      evaluate: async <T,>(fn: (el: any) => T) => {
        const e = one();
        return fn({
          tagName: e.role === 'button' ? 'BUTTON' : e.role === 'textbox' ? 'TEXTAREA' : 'DIV',
          getAttribute: (k: string) => (k === 'aria-label' ? (e.label || null) : k === 'type' ? (e.type || null) : null),
          innerText: e.text, textContent: e.text,
        });
      },
      click: async () => { click(one()); },
      fill: async (t) => { const e = one(); if (e.role !== 'textbox') throw new Error('not fillable'); box = t; fills.push(t); },
    };
  };

  const page: LdPage = {
    getByRole: (role) => loc(() => (role === 'dialog' && open && time >= appearAt ? [dialogEl()] : role === 'menu' && menuOpen ? [menuEl()] : [])),
  };
  return {
    page, clicks, fills,
    isOpen: () => open,
    open: (o) => { open = true; step = 'first'; box = ''; recipient = o?.name ?? 'Jane Example'; time = 0; fillAt = o?.fillAfterMs ?? 0; noHeading = o?.noHeading === true;
      appearAt = o?.appearAfterMs ?? 0; roleBlind = o?.roleBlind === true; labelOnly = o?.labelOnly === true; },
    close: () => { open = false; },
    setBox: (v) => { box = v; },
    sendCount: () => sent,
    openMenu: (items, o) => { menuOpen = true; menuItems = items ?? ['Connect', 'Follow', 'Message', 'Save to PDF', 'Report or block']; time = 0; menuFillAt = o?.fillAfterMs ?? 0; },
    advance: (ms) => { time += ms; },
    elapsed: () => time,
    boxOf: (role, name) => {
      if (role === 'menuitem') { const i = shownItems().indexOf(name); return menuOpen && i >= 0 ? itemBox(i) : null; }
      const i = ctls().findIndex((c) => c.role === role && c.name === name);
      return open && i >= 0 ? ctlBox(i) : null;
    },
    mouseClick: (x, y) => {
      const inBox = (b: Box): boolean => x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height;
      if (menuOpen) {
        const i = shownItems().findIndex((_, k) => inBox(itemBox(k)));
        if (i >= 0) { click({ role: 'menuitem', label: '', text: '', value: '', type: '', ctl: { role: 'menuitem', name: shownItems()[i] } }); return true; }
      }
      if (open) {
        const c = ctls().find((_, k) => inBox(ctlBox(k)));
        if (c && c.role !== 'heading') { click(toEl(c)); return true; }
      }
      return false;
    },
    closeMenu: () => { menuOpen = false; },
    isMenuOpen: () => menuOpen,
  };
}
