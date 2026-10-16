// The one strict selector validator for declarative, agent-proposed specs (generated providers, Task 8) and, later, apply recipes (Task 19).
// Selectors are DATA interpreted by a fixed matcher, never handed to a browser or eval. Grammar: up to two compounds joined by ONE space
// (descendant); a compound is an optional lower-case tag plus any of #id, .class, [attr] or [attr=value] with attr from a closed list.
// No pseudo-classes (:has, :not, :nth-*), no child/sibling/group combinators, no wildcards, no escapes, at most 160 chars.
const NAME = '[A-Za-z_][A-Za-z0-9_-]{0,63}';
const ATTR_NAME = '(?:id|name|class|href|type|role|itemprop|itemtype|rel|title|(?:data|aria)-[a-z0-9-]{1,40})';
const VALUE = '(?:"[A-Za-z0-9_.-]{1,60}"|\'[A-Za-z0-9_.-]{1,60}\'|[A-Za-z0-9_.-]{1,60})';
const PART = `(?:#${NAME}|\\.${NAME}|\\[${ATTR_NAME}(?:=${VALUE})?\\])`;
const COMPOUND = new RegExp(`^(?:[a-z][a-z0-9]{0,15})?${PART}*$`);

export const MAX_SELECTOR_CHARS = 160;

export function isSafeSelector(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_SELECTOR_CHARS) return false;
  const parts = s.split(' ');
  if (parts.length > 2) return false;
  return parts.every((p) => p.length > 0 && COMPOUND.test(p));
}

const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SEGMENT = /^(?:[A-Za-z0-9_-]{1,64}|\[\d{1,3}\])$/;

/** A JSON path such as `data.jobs`, `title`, `locations[0].name`: dot-separated keys with optional numeric indexes, at most 160 chars. */
export function isSafeJsonPath(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0 || s.length > MAX_SELECTOR_CHARS) return false;
  const segs = s.replace(/\[(\d{1,3})\]/g, '.[$1]').split('.');
  return segs.every((g) => g.length > 0 && SEGMENT.test(g) && !BAD_KEYS.has(g));
}

export function jsonPathSegments(s: string): Array<string | number> {
  return s.replace(/\[(\d{1,3})\]/g, '.[$1]').split('.').filter(Boolean).map((g) => (g.startsWith('[') ? Number(g.slice(1, -1)) : g));
}
