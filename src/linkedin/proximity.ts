// 2D-proximity helpers COPIED from src/mcp/connect.ts (same bodies, typed on LiPage). connect.ts is
// not imported: it opens data.sqlite at import. Fail-closed picks live in verify.ts.
import { SELECTORS } from './selectors.js';
import { pickNearestToNameIndex, type Point } from './verify.js';
import type { LiLocator, LiPage } from './types.js';

/** Position of the heading whose text matches `expectedName`, or null if none found. */
export async function getProfileNamePoint(page: Pick<LiPage, 'locator'>, expectedName: string): Promise<Point | null> {
  if (!expectedName) return null;
  const headings = await page
    .locator(SELECTORS.nameHeadings)
    .evaluateAll((els) =>
      els.map((el) => {
        const box = el.getBoundingClientRect();
        return { text: (el.textContent ?? '').trim(), x: box.x, y: box.y };
      }),
    );
  const match = headings.find((h) => h.text === expectedName);
  return match ? { x: match.x, y: match.y } : null;
}

/**
 * Resolves to whichever match of `selector` sits closest (2D) to the profile's own name, or to a
 * zero-match locator (`.nth(count)`) if the nearest is implausibly far. Falls back to `.first()`
 * when there are no matches at all or no name position.
 */
export async function pickNearestLocator(
  page: Pick<LiPage, 'locator'>,
  selector: string,
  namePoint: Point | null,
): Promise<LiLocator> {
  const candidatesLocator = page.locator(selector);
  const count = await candidatesLocator.count();
  if (count === 0 || namePoint === null) return candidatesLocator.first();
  const candidates = await candidatesLocator.evaluateAll((els) =>
    els.map((el) => {
      const box = el.getBoundingClientRect();
      return { x: box.x, y: box.y };
    }),
  );
  const index = pickNearestToNameIndex(namePoint, candidates);
  return candidatesLocator.nth(index === -1 ? count : index);
}
