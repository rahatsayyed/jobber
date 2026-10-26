// LinkedIn profile connection state, read from the profile's OWN top card and its More menu only (never from a
// sidebar or recommendation card, whose Connect sends an invitation directly). The snapshot prints the result as
// `connect_state:`, the arm tool refuses on it, and the commit step re-checks it right before a Connect click.
//   a) a top-card Connect                           -> connectable
//   b) no top-card Connect, More menu open and it holds Connect or Personalize invite -> via_more
//   c) neither, with at least one More menu row read (or no More button) -> not_connectable (1st degree, or follow only)
//      (menu rows are the controls of region `menu`, set by the snapshot inside a role=menu list or an open popover)
//   d) Pending or Withdraw in the top card           -> already_pending
//   (More exists but no menu row was read: not open yet, or its rows were not found) -> check_more: click More, snapshot again
import { isConnectControlName, normName } from './guard.js';
import type { RawNode, RawTree } from './snapshot.js';

export type TopCardState = 'connectable' | 'via_more' | 'not_connectable' | 'already_pending' | 'check_more';

const isControl = (x: RawNode): boolean => x.role === 'button' || x.role === 'link' || x.role === 'menuitem';
const PENDING_RE = /^pending\b|^withdraw\b/;
const MORE_RE = /^more\b/;
const SENT_TOAST_RE = /\b(?:invitation|invite) (?:was )?sent\b/i;

/** Is this tree a profile page read with regions? Only the page walker sets topcard, sidebar or main (and only on /in/ pages). */
export const hasRegions = (tree: RawTree): boolean => tree.nodes.some((x) => x.region === 'topcard' || x.region === 'sidebar' || x.region === 'main');

/** State of the profile in `tree`, or null when the tree has no regions (not a profile page). */
export function connectionStateOf(tree: RawTree): { state: TopCardState; reason: string } | null {
  if (!hasRegions(tree)) return null;
  const controls = tree.nodes.filter((x) => x.dialog === undefined && isControl(x));
  const top = controls.filter((x) => x.region === 'topcard');
  const menu = controls.filter((x) => x.region === 'menu');
  if (top.some((x) => PENDING_RE.test(normName(x.name)))) return { state: 'already_pending', reason: 'Pending or Withdraw in the top card' };
  if (top.some((x) => isConnectControlName(x.name))) return { state: 'connectable', reason: 'Connect in the top card' };
  if (menu.some((x) => isConnectControlName(x.name))) return { state: 'via_more', reason: 'Connect, Personalize invite or Invite <name> to connect in the More menu' };
  if (!top.some((x) => MORE_RE.test(normName(x.name)))) return { state: 'not_connectable', reason: 'no Connect and no More button in the top card' };
  if (menu.length > 0) return { state: 'not_connectable', reason: 'More menu has no Connect: 1st degree or follow only' };
  return { state: 'check_more', reason: 'no Connect in the top card: click the top-card More and snapshot again' };
}

/** Did a click that opened no dialog still send the invitation? Pending in the top card, or an "Invitation sent" toast. */
export function directSendSeen(tree: RawTree): boolean {
  if (tree.nodes.some((x) => x.dialog === undefined && isControl(x) && x.region === 'topcard' && PENDING_RE.test(normName(x.name)))) return true;
  return tree.nodes.some((x) => x.dialog === undefined && x.role === 'text' && x.text.length <= 80 && SENT_TOAST_RE.test(x.text));
}
