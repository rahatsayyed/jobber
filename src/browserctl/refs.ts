// browserctl refs: per-platform epoch store. Every snapshot starts a new epoch E and the model sees
// refs as `s<E>.<n>`; a ref from an older epoch is refused with stale_ref (re-snapshot). The store
// never touches the page: it only maps a ref to the ordinal stamped as data-bc by the last snapshot.
import type { RawNode, RawTree } from './snapshot.js';

export const REF_RE = /^s(\d{1,9})\.(\d{1,5})$/;

export type RefResult =
  | { ok: true; n: number; epoch: number; node: RawNode | null }
  | { ok: false; code: 'bad_ref' | 'stale_ref' | 'no_snapshot'; reason: string };

export class RefStore {
  private epochNo = 0;
  private nodes = new Map<number, RawNode>();
  private haveSnapshot = false;

  /** Current epoch (0 before the first snapshot). */
  get epoch(): number { return this.epochNo; }
  get hasSnapshot(): boolean { return this.haveSnapshot; }

  /** Start a new epoch for a fresh tree; every earlier ref becomes stale. Returns the new epoch. */
  begin(tree: RawTree): number {
    this.epochNo += 1;
    this.nodes = new Map(tree.nodes.map((nd) => [nd.n, nd]));
    this.haveSnapshot = true;
    return this.epochNo;
  }

  /** Capture the public ref state (arm verification uses it to leave the operator's refs untouched). */
  save(): { epochNo: number; nodes: Map<number, RawNode>; haveSnapshot: boolean } {
    return { epochNo: this.epochNo, nodes: this.nodes, haveSnapshot: this.haveSnapshot };
  }
  restore(s: { epochNo: number; nodes: Map<number, RawNode>; haveSnapshot: boolean }): void {
    this.epochNo = s.epochNo;
    this.nodes = s.nodes;
    this.haveSnapshot = s.haveSnapshot;
  }

  /** Invalidate every ref without a new snapshot (navigation, reload, dialog close). */
  invalidate(): void {
    this.epochNo += 1;
    this.nodes = new Map();
    this.haveSnapshot = false;
  }

  refOf(n: number): string { return `s${this.epochNo}.${n}`; }

  /** The node as it was when the snapshot was taken (advisory; act re-reads the live element). */
  node(n: number): RawNode | null { return this.nodes.get(n) ?? null; }

  resolve(ref: unknown): RefResult {
    if (typeof ref !== 'string') return { ok: false, code: 'bad_ref', reason: 'ref must be a string like s3.12' };
    const m = REF_RE.exec(ref.trim());
    if (!m) return { ok: false, code: 'bad_ref', reason: 'ref must look like s<epoch>.<n>' };
    if (!this.haveSnapshot) return { ok: false, code: 'no_snapshot', reason: 'take a snapshot first' };
    const epoch = Number(m[1]);
    const n = Number(m[2]);
    if (epoch !== this.epochNo) return { ok: false, code: 'stale_ref', reason: `ref is from epoch ${epoch}, current is ${this.epochNo}; take a new snapshot` };
    if (!this.nodes.has(n)) return { ok: false, code: 'bad_ref', reason: 'no such node in this snapshot' };
    return { ok: true, n, epoch, node: this.nodes.get(n) ?? null };
  }
}
