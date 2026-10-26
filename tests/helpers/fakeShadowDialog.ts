// A locator-capable page double for a modal in a CLOSED shadow root: only getByRole locators can see it
// (the fake BcPage's walker tree never contains it). Mirrors what the live probe saw on a LinkedIn profile:
// getByRole('dialog') count 1, buttons Dismiss / Add a note / Send without a note, one textbox.
import type { LdLocator, LdPage } from '../../src/browserctl/locatorDialogs.js';

export interface Ctl { role: string; name: string; value?: string; type?: string }
interface El { role: string; label: string; text: string; value: string; type: string; ctl?: Ctl; dlg?: boolean; menu?: boolean }

export interface ShadowWorld {
  page: LdPage;
  /** Every locator click, as `<role>:<name>`. */
  clicks: string[];
  fills: string[];
  isOpen(): boolean;
  /** Show the first step of the invite modal ("Dismiss", "Add a note", "Send without a note"). */
  open(o?: { name?: string }): void;
  close(): void;
  /** Change what the textbox holds without any fill call (a page that rewrote the field). */
  setBox(v: string): void;
  /** Called after a click that did not close the dialog (default behaviour covers the invite flow). */
  sendCount(): number;
  // An open menu (role menu, invisible to the walker). A Connect item opens the invite modal.
  openMenu(items?: string[]): void;
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
  const clicks: string[] = [];
  const fills: string[] = [];

  const ctls = (): Ctl[] => step === 'first'
    ? [{ role: 'heading', name: 'Add a note to your invitation?' }, { role: 'button', name: 'Dismiss' },
      { role: 'button', name: 'Add a note' }, { role: 'button', name: 'Send without a note' }]
    : [{ role: 'heading', name: 'Add a note to your invitation?' }, { role: 'button', name: 'Dismiss' },
      { role: 'textbox', name: 'Add a note', type: 'text', value: box }, { role: 'button', name: 'Send' }];
  const textOf = (): string => [`Personalize your invitation to ${recipient} by adding a note`, ...ctls().filter((c) => c.role !== 'textbox').map((c) => c.name)].join('\n');
  const toEl = (c: Ctl): El => ({ role: c.role, label: (c.role === 'button' && c.name === 'Dismiss') || c.role === 'textbox' ? c.name : '', text: c.role === 'textbox' ? '' : c.name,
    value: c.role === 'textbox' ? box : '', type: c.type ?? '', ctl: c });
  const dialogEl = (): El => ({ role: 'dialog', label: '', text: textOf(), value: '', type: '', dlg: true });

  const menuEl = (): El => ({ role: 'menu', label: '', text: menuItems.join('\n'), value: '', type: '', menu: true });
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
      getByRole: (role) => loc(() => list().flatMap((e) => (e.dlg ? ctls().filter((c) => c.role === role).map(toEl)
        : e.menu && role === 'menuitem' ? menuItems.map((m) => toEl({ role: 'menuitem', name: m })) : []))),
      innerText: async () => one().text,
      inputValue: async () => one().value,
      evaluate: async <T,>(fn: (el: any) => T) => {
        const e = one();
        return fn({
          getAttribute: (k: string) => (k === 'aria-label' ? (e.label || null) : k === 'type' ? (e.type || null) : null),
          innerText: e.text, textContent: e.text,
        });
      },
      click: async () => { click(one()); },
      fill: async (t) => { const e = one(); if (e.role !== 'textbox') throw new Error('not fillable'); box = t; fills.push(t); },
    };
  };

  const page: LdPage = {
    getByRole: (role) => loc(() => (role === 'dialog' && open ? [dialogEl()] : role === 'menu' && menuOpen ? [menuEl()] : [])),
  };
  return {
    page, clicks, fills,
    isOpen: () => open,
    open: (o) => { open = true; step = 'first'; box = ''; recipient = o?.name ?? 'Jane Example'; },
    close: () => { open = false; },
    setBox: (v) => { box = v; },
    sendCount: () => sent,
    openMenu: (items) => { menuOpen = true; menuItems = items ?? ['Connect', 'Follow', 'Message', 'Save to PDF', 'Report or block']; },
    closeMenu: () => { menuOpen = false; },
    isMenuOpen: () => menuOpen,
  };
}
