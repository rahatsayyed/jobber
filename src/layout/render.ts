// Compact, model-visible rendering of layout memory (plan 8B). Vocabulary ids, integers and dates
// only: nothing here is page text, so the output needs no input gate. Pure, no I/O.
import type { KindMemory, LayoutFile, Variant } from './types.js';

const MAX_NEEDS = 12;
const MAX_RECIPES = 6;

const day = (iso: string | null): string => (iso && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : 'never');
const stamp = (v: Variant): string => v.last_verified ?? v.first_seen;

// The variant a reader should trust: the most recently verified promoted one.
function lead(km: KindMemory): Variant | null {
  const promoted = km.variants.filter((v) => v.promoted);
  if (promoted.length === 0) return null;
  return promoted.reduce((a, b) => (stamp(b) > stamp(a) ? b : a));
}

function recipeText(r: Variant['recipes'][number]): string {
  // `text`, `role`, or `ordinal N`, then an optional `region <landmark>`.
  const parts: string[] = [];
  if (r.how === 'ordinal') parts.push(`ordinal ${r.ordinal ?? 0}`);
  else parts.push(r.how === 'role_name' ? 'role' : 'text');
  if (r.region) parts.push(`region ${r.region}`);
  return `${r.action} ${r.label} (${parts.join(' ')})`;
}

// One line per kind: `profile: stable v2 verified 2026-10-14 ok=41 fail=0 drift=0 | needs: ... | recipes: ...`.
// `vN` is the number of promoted variants; ok and fail sum the variants' recorded action outcomes.
export function renderKind(kind: string, km: KindMemory): string {
  const promoted = km.variants.filter((v) => v.promoted);
  const lv = lead(km);
  const ok = km.variants.reduce((n, v) => n + v.ok, 0);
  const fail = km.variants.reduce((n, v) => n + v.fail, 0);
  let line = `${kind}: ${km.state} v${promoted.length} verified ${day(lv?.last_verified ?? null)} ok=${ok} fail=${fail} drift=${km.counters.drift}`;
  if (lv && lv.landmarks.length > 0) line += ` | needs: ${lv.landmarks.slice(0, MAX_NEEDS).join(' ')}`;
  if (lv && lv.recipes.length > 0) line += ` | recipes: ${lv.recipes.slice(0, MAX_RECIPES).map(recipeText).join(', ')}`;
  return line;
}

// Whole kind lines only; when the budget cuts lines off, the last line is `...`.
export function renderLayout(file: LayoutFile | null, maxChars: number): string {
  const lines = file
    ? Object.keys(file.kinds).sort().map((k) => renderKind(k, file.kinds[k]))
    : [];
  if (lines.length === 0) return 'layout memory: none yet';
  const out: string[] = [];
  let used = 0;
  const reserve = 4; // "\n..."
  for (let i = 0; i < lines.length; i++) {
    const need = lines[i].length + (out.length ? 1 : 0);
    const last = i === lines.length - 1;
    if (used + need + (last ? 0 : reserve) > maxChars) {
      // keep a final marker only when something was cut and at least one line fits
      out.push('...');
      return out.length === 1 ? '...'.slice(0, maxChars) : out.join('\n').slice(0, maxChars);
    }
    out.push(lines[i]);
    used += need;
  }
  return out.join('\n');
}
