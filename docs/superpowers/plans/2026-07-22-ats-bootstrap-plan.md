# Self-Extending ATS Bootstrapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `apply_url` resolves to a domain none of the 4 known ATS modules
(Greenhouse/Lever/Workday/Ashby) recognize, learn a reusable `FieldMap` for it from a live
snapshot of the page via a bounded Claude CLI call, persist it, and use it immediately — so the
next application to that same domain never needs to learn it again.

**Architecture:** Four new small modules (`src/ats/learned.ts` for the persisted registry,
`src/lib/domSnapshot.ts` for live-page form-control extraction, `src/lib/atsBootstrap.ts` for
the Claude-backed field-selection call, `.claude/commands/ats-bootstrap-fieldmap.md` for its
prompt contract) plug into `src/apply/external.ts`'s existing platform-detection branch.
Bootstrapping only fires when the caller has no `expected_platform` (i.e. never through one of
the 4 explicit per-platform tools — only through a generic/no-platform-expectation caller).

**Tech Stack:** TypeScript, Playwright, zod, vitest, the project's existing `claude --print`
CLI-shellout pattern (`src/lib/domFallback.ts`).

## Global Constraints

- Scope is `src/apply/external.ts` only — LinkedIn Easy Apply (`linkedin.ts`) is explicitly out
  of scope (spec §Scope).
- Always on, no opt-in env flag (spec §Scope) — unlike `EASY_APPLY_HYBRID_FALLBACK` /
  `EXTERNAL_APPLY_HYBRID_FALLBACK`.
- Bootstrap inspection is accessibility/DOM snapshot only — no screenshot, no raw HTML dump
  (spec §"How should Claude inspect...").
- Learned `FieldMap`s persist to a JSON registry read fresh via `readFileSync` on every call, so
  a newly learned platform works on the very next application without an MCP/session reconnect
  (spec §Persistence) — mirrors `config/easy-apply-answers.json`'s reload semantics.
- On first sighting of a new domain: learn now, submit now — no extra manual_review-only first
  pass (spec §First-use). The learned `FieldMap` gets zero special leniency: the same
  required-field check and confirmation-text check that already gate the 4 built-in platforms
  apply identically (spec §Error Handling).
- If any REQUIRED field (`name`/`email`/`resumeUpload`/`submitButton` — see Task 3 for why
  `submitButton` is required for bootstrap even though it's "optional" in the spec's prose)
  can't be confidently resolved: fall through to `manual_review`, write nothing to the registry
  (spec §"What should happen if Claude's...inspection can't confidently find...").
- Never invent a selector that isn't verbatim present in the live-page snapshot — enforced both
  in the Claude prompt contract and independently re-validated in code (defense in depth, same
  discipline as `resolveControlWithFallback`/`resolveAnswerTopicWithFallback` in
  `src/lib/domFallback.ts`).

---

### Task 1: Learned-platform registry

**Files:**
- Create: `src/ats/learned.ts`
- Test: `tests/ats-learned.test.ts`

**Interfaces:**
- Consumes: `FieldMap` from `src/ats/types.ts` (existing).
- Produces:
  - `loadLearnedPlatforms(configPath?: string): Record<string, FieldMap>`
  - `saveLearnedPlatform(domain: string, fieldMap: FieldMap, configPath?: string): void`
  - `export interface LearnedDetection { platform: string; fieldMap: FieldMap }`
  - `detectLearned(url: string, configPath?: string): LearnedDetection | null`

  Task 4 imports `detectLearned` and `saveLearnedPlatform` from this file.

- [ ] **Step 1: Write the failing tests**

Create `tests/ats-learned.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadLearnedPlatforms, saveLearnedPlatform, detectLearned } from '../src/ats/learned.js';
import type { FieldMap } from '../src/ats/types.js';

const fakeFieldMap: FieldMap = {
  name: '#name',
  email: '#email',
  phone: '#phone',
  resumeUpload: '#resume',
  coverLetter: '#cover',
  submitButton: '#submit',
};

describe('learned ATS platform registry', () => {
  let tmpDir: string;
  let configPath: string;

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function freshConfigPath(): string {
    tmpDir = mkdtempSync(path.join(tmpdir(), 'ats-learned-test-'));
    configPath = path.join(tmpDir, 'learned-ats-platforms.json');
    return configPath;
  }

  it('loadLearnedPlatforms returns {} when the file does not exist yet (first run)', () => {
    const p = freshConfigPath();
    expect(loadLearnedPlatforms(p)).toEqual({});
  });

  it('saveLearnedPlatform then loadLearnedPlatforms round-trips a FieldMap', () => {
    const p = freshConfigPath();
    saveLearnedPlatform('jobs.example.com', fakeFieldMap, p);
    expect(loadLearnedPlatforms(p)).toEqual({ 'jobs.example.com': fakeFieldMap });
  });

  it('saveLearnedPlatform merges a new domain without clobbering an existing one', () => {
    const p = freshConfigPath();
    saveLearnedPlatform('jobs.example.com', fakeFieldMap, p);
    const other: FieldMap = { ...fakeFieldMap, name: '#other-name' };
    saveLearnedPlatform('careers.other.com', other, p);

    const registry = loadLearnedPlatforms(p);
    expect(registry['jobs.example.com']).toEqual(fakeFieldMap);
    expect(registry['careers.other.com']).toEqual(other);
  });

  it('detectLearned matches a URL by hostname against the registry', () => {
    const p = freshConfigPath();
    saveLearnedPlatform('jobs.example.com', fakeFieldMap, p);
    const result = detectLearned('https://jobs.example.com/careers/123?ref=abc', p);
    expect(result).toEqual({ platform: 'jobs.example.com', fieldMap: fakeFieldMap });
  });

  it('detectLearned returns null for a domain not in the registry', () => {
    const p = freshConfigPath();
    saveLearnedPlatform('jobs.example.com', fakeFieldMap, p);
    expect(detectLearned('https://unrelated.com/jobs/1', p)).toBeNull();
  });

  it('detectLearned returns null for a malformed URL instead of throwing', () => {
    const p = freshConfigPath();
    expect(detectLearned('not a url', p)).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/ats-learned.test.ts`
Expected: FAIL — `Cannot find module '../src/ats/learned.js'`

- [ ] **Step 3: Write the implementation**

Create `src/ats/learned.ts`:

```typescript
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FieldMap } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');
const DEFAULT_LEARNED_PLATFORMS_PATH = path.join(projectRoot, 'config', 'learned-ats-platforms.json');

/**
 * Reads the learned-ATS-platform registry fresh from disk on every call — same reload
 * semantics as config/easy-apply-answers.json, so a newly learned platform is usable on the
 * very next call with no MCP/session reconnect. Returns {} if the file doesn't exist yet
 * (first run, before anything has ever been learned).
 */
export function loadLearnedPlatforms(
  configPath: string = DEFAULT_LEARNED_PLATFORMS_PATH
): Record<string, FieldMap> {
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, 'utf8'));
}

/** Merges `fieldMap` into the registry under `domain` and writes the whole registry back. */
export function saveLearnedPlatform(
  domain: string,
  fieldMap: FieldMap,
  configPath: string = DEFAULT_LEARNED_PLATFORMS_PATH
): void {
  const registry = loadLearnedPlatforms(configPath);
  registry[domain] = fieldMap;
  writeFileSync(configPath, JSON.stringify(registry, null, 2) + '\n');
}

export interface LearnedDetection {
  platform: string;
  fieldMap: FieldMap;
}

/**
 * Hostname lookup against the learned registry, mirroring each static ATS module's own
 * `detect(url)` shape. Returns null on no match or an unparseable URL.
 */
export function detectLearned(
  url: string,
  configPath: string = DEFAULT_LEARNED_PLATFORMS_PATH
): LearnedDetection | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const registry = loadLearnedPlatforms(configPath);
  const fieldMap = registry[hostname];
  return fieldMap ? { platform: hostname, fieldMap } : null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ats-learned.test.ts`
Expected: PASS (6/6)

- [ ] **Step 5: Commit**

```bash
git add src/ats/learned.ts tests/ats-learned.test.ts
git commit -m "feat: add learned-ATS-platform registry (config/learned-ats-platforms.json)"
```

---

### Task 2: Live-page form-control snapshot

**Files:**
- Create: `src/lib/domSnapshot.ts`
- Test: `tests/domSnapshot.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface SnapshotInput { selector: string; type: string; id?: string; name?: string; ariaLabel?: string; placeholder?: string }`
  - `export interface SnapshotButton { selector: string; text: string }`
  - `export interface FormControlSnapshot { inputs: SnapshotInput[]; buttons: SnapshotButton[] }`
  - `export function buildSelector(descriptor: { tag: string; id?: string; name?: string; indexAmongSameTag: number }): string` — pure, unit-tested.
  - `export async function snapshotFormControls(page: Pick<import('playwright').Page, 'evaluate'>): Promise<FormControlSnapshot>` — Playwright-touching, not unit-tested here (same convention as the rest of this codebase's browser-interacting code); Task 4 wires it in and it gets exercised live per the plan's testing note below.

  Task 3 consumes `FormControlSnapshot` (selector validation). Task 4 consumes
  `snapshotFormControls`.

- [ ] **Step 1: Write the failing test**

Create `tests/domSnapshot.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildSelector } from '../src/lib/domSnapshot.js';

describe('buildSelector', () => {
  it('prefers #id when an id is present, even if a name is also present', () => {
    expect(buildSelector({ tag: 'input', id: 'email_addr', name: 'email', indexAmongSameTag: 3 })).toBe(
      '#email_addr'
    );
  });

  it('falls back to tag[name="..."] when there is no id', () => {
    expect(buildSelector({ tag: 'input', name: 'phone_number', indexAmongSameTag: 2 })).toBe(
      'input[name="phone_number"]'
    );
  });

  it('falls back to a structural tag:nth-of-type selector when neither id nor name is present', () => {
    expect(buildSelector({ tag: 'button', indexAmongSameTag: 0 })).toBe('button:nth-of-type(1)');
    expect(buildSelector({ tag: 'button', indexAmongSameTag: 4 })).toBe('button:nth-of-type(5)');
  });

  it('treats an empty-string id or name as absent, falling through to the next strategy', () => {
    expect(buildSelector({ tag: 'input', id: '', name: 'resume', indexAmongSameTag: 1 })).toBe(
      'input[name="resume"]'
    );
    expect(buildSelector({ tag: 'input', id: '', name: '', indexAmongSameTag: 1 })).toBe(
      'input:nth-of-type(2)'
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/domSnapshot.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/domSnapshot.js'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/domSnapshot.ts`:

```typescript
import type { Page } from 'playwright';

export interface ControlDescriptor {
  tag: string;
  id?: string;
  name?: string;
  indexAmongSameTag: number;
}

export interface SnapshotInput {
  selector: string;
  type: string;
  id?: string;
  name?: string;
  ariaLabel?: string;
  placeholder?: string;
}

export interface SnapshotButton {
  selector: string;
  text: string;
}

export interface FormControlSnapshot {
  inputs: SnapshotInput[];
  buttons: SnapshotButton[];
}

/**
 * Pure: synthesizes a verifiable CSS selector for one control, preferring `#id`, then
 * `tag[name="..."]`, then a structural `tag:nth-of-type(n)` fallback — so every selector
 * handed to Claude for the ATS bootstrap step is guaranteed to resolve to a real element on
 * the page, never just descriptive text.
 */
export function buildSelector(descriptor: ControlDescriptor): string {
  if (descriptor.id) return `#${descriptor.id}`;
  if (descriptor.name) return `${descriptor.tag}[name="${descriptor.name}"]`;
  return `${descriptor.tag}:nth-of-type(${descriptor.indexAmongSameTag + 1})`;
}

interface RawDescriptor extends ControlDescriptor {
  type?: string;
  ariaLabel?: string;
  placeholder?: string;
  text?: string;
}

/**
 * Extracts every input/select/textarea and every clickable button/link on the live page,
 * synthesizing a verifiable selector for each via `buildSelector`.
 */
export async function snapshotFormControls(page: Pick<Page, 'evaluate'>): Promise<FormControlSnapshot> {
  const raw = await page.evaluate(() => {
    function describe(el: Element, tag: string, index: number) {
      const input = el as HTMLInputElement;
      return {
        tag,
        id: el.id || undefined,
        name: input.name || undefined,
        type: input.type || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        placeholder: input.placeholder || undefined,
        text: el.textContent?.trim() || undefined,
        indexAmongSameTag: index,
      };
    }
    const inputEls = Array.from(document.querySelectorAll('input, select, textarea'));
    const buttonEls = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"]'));
    return {
      inputs: inputEls.map((el, i) => describe(el, el.tagName.toLowerCase(), i)),
      buttons: buttonEls.map((el, i) => describe(el, el.tagName.toLowerCase(), i)),
    };
  });

  const rawInputs = raw.inputs as RawDescriptor[];
  const rawButtons = raw.buttons as RawDescriptor[];

  return {
    inputs: rawInputs.map((d) => ({
      selector: buildSelector(d),
      type: d.type ?? 'text',
      id: d.id,
      name: d.name,
      ariaLabel: d.ariaLabel,
      placeholder: d.placeholder,
    })),
    buttons: rawButtons.map((d) => ({ selector: buildSelector(d), text: d.text ?? '' })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/domSnapshot.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add src/lib/domSnapshot.ts tests/domSnapshot.test.ts
git commit -m "feat: add live-page form-control snapshot for ATS bootstrapping"
```

---

### Task 3: Claude-backed FieldMap bootstrap

**Files:**
- Modify: `src/lib/domFallback.ts` (export the two already-private helpers this task reuses)
- Create: `src/lib/atsBootstrap.ts`
- Create: `.claude/commands/ats-bootstrap-fieldmap.md`
- Test: `tests/atsBootstrap.test.ts`

**Interfaces:**
- Consumes: `FormControlSnapshot` from `src/lib/domSnapshot.ts` (Task 2), `FieldMap` from
  `src/ats/types.ts`, and (newly exported) `runClaudeCli`/`extractJson` from
  `src/lib/domFallback.ts`.
- Produces:
  - `export const BOOTSTRAP_REQUIRED_FIELDS = ['name', 'email', 'resumeUpload', 'submitButton'] as const;`
  - `export const BOOTSTRAP_OPTIONAL_FIELDS = ['phone', 'coverLetter'] as const;`
  - `export const UNRESOLVED_OPTIONAL_SELECTOR = '[data-ats-bootstrap-unresolved="true"]';`
  - `export type BootstrapResult = { fieldMap: FieldMap } | { missing: string[] };`
  - `export async function bootstrapFieldMap(snapshot: FormControlSnapshot, deps?: FallbackDeps): Promise<BootstrapResult>`

  Task 4 imports `bootstrapFieldMap` and `UNRESOLVED_OPTIONAL_SELECTOR` is only used internally
  (Task 4 doesn't need to import it — it flows through the returned `FieldMap`).

**Why `submitButton` is REQUIRED here even though the spec's prose lists it under "optional
fields":** `FieldMap.submitButton` is a mandatory `string` in `src/ats/types.ts` — there is no
"missing submit button" graceful path anywhere in `external.ts` (unlike `phone`/`coverLetter`,
which are looked up with `page.$(selector)` and just skipped if not found). Without a real
submit-button selector, a learned platform could never actually submit anything, so bootstrap
correctness requires it to gate success. `phone` and `coverLetter` truly are best-effort: if
Claude can't resolve them, `bootstrapFieldMap` fills them with `UNRESOLVED_OPTIONAL_SELECTOR` —
a syntactically valid CSS selector guaranteed to match no real element, so `external.ts`'s
existing `page.$(selector)` optional-field checks see a safe "not found" exactly like they
already handle a genuinely absent optional field, instead of crashing on an invalid/empty
selector string.

- [ ] **Step 1: Export the two helpers this task reuses**

In `src/lib/domFallback.ts`, change (around line 32):

```typescript
async function runClaudeCli(command: string, input: unknown, model?: string): Promise<string | null> {
```

to:

```typescript
export async function runClaudeCli(command: string, input: unknown, model?: string): Promise<string | null> {
```

And change (around line 57):

```typescript
function extractJson<T>(raw: string, schema: z.ZodType<T>): T | null {
```

to:

```typescript
export function extractJson<T>(raw: string, schema: z.ZodType<T>): T | null {
```

No behavior change — these two functions' bodies are untouched, only their visibility. Run the
existing suite once to confirm nothing else is affected:

Run: `npx vitest run`
Expected: PASS, same count as before this task (no regressions from a visibility-only change)

- [ ] **Step 2: Write the failing tests**

Create `tests/atsBootstrap.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  bootstrapFieldMap,
  BOOTSTRAP_REQUIRED_FIELDS,
  UNRESOLVED_OPTIONAL_SELECTOR,
} from '../src/lib/atsBootstrap.js';
import type { FormControlSnapshot } from '../src/lib/domSnapshot.js';

const snapshot: FormControlSnapshot = {
  inputs: [
    { selector: '#full_name', type: 'text' },
    { selector: '#email_addr', type: 'email' },
    { selector: 'input[name="resume"]', type: 'file' },
    { selector: '#phone_num', type: 'tel' },
  ],
  buttons: [{ selector: '#submit_btn', text: 'Submit Application' }],
};

describe('bootstrapFieldMap', () => {
  it('returns a complete FieldMap when Claude resolves every required and optional field to real snapshot selectors', async () => {
    const runClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        fieldMap: {
          name: '#full_name',
          email: '#email_addr',
          resumeUpload: 'input[name="resume"]',
          submitButton: '#submit_btn',
          phone: '#phone_num',
        },
      })
    );

    const result = await bootstrapFieldMap(snapshot, { runClaude });

    expect(result).toEqual({
      fieldMap: {
        name: '#full_name',
        email: '#email_addr',
        resumeUpload: 'input[name="resume"]',
        submitButton: '#submit_btn',
        phone: '#phone_num',
        coverLetter: UNRESOLVED_OPTIONAL_SELECTOR,
      },
    });
  });

  it('fills an unresolved optional field (coverLetter) with UNRESOLVED_OPTIONAL_SELECTOR instead of failing', async () => {
    const runClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        fieldMap: {
          name: '#full_name',
          email: '#email_addr',
          resumeUpload: 'input[name="resume"]',
          submitButton: '#submit_btn',
        },
      })
    );

    const result = await bootstrapFieldMap(snapshot, { runClaude });

    expect('fieldMap' in result).toBe(true);
    if ('fieldMap' in result) {
      expect(result.fieldMap.phone).toBe(UNRESOLVED_OPTIONAL_SELECTOR);
      expect(result.fieldMap.coverLetter).toBe(UNRESOLVED_OPTIONAL_SELECTOR);
    }
  });

  it('rejects a required-field selector Claude invented that is not actually in the snapshot (never-invent enforcement)', async () => {
    const runClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        fieldMap: {
          name: '#full_name',
          email: '#a-selector-that-does-not-exist',
          resumeUpload: 'input[name="resume"]',
          submitButton: '#submit_btn',
        },
      })
    );

    const result = await bootstrapFieldMap(snapshot, { runClaude });

    expect(result).toEqual({ missing: ['email'] });
  });

  it('returns the explicit missing list Claude reports when it cannot resolve a required field itself', async () => {
    const runClaude = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ fieldMap: null, missing: ['resumeUpload'] }));

    const result = await bootstrapFieldMap(snapshot, { runClaude });

    expect(result).toEqual({ missing: ['resumeUpload'] });
  });

  it('falls back to the full required-field list as "missing" when the CLI call itself fails', async () => {
    const runClaude = vi.fn().mockResolvedValue(null);

    const result = await bootstrapFieldMap(snapshot, { runClaude });

    expect(result).toEqual({ missing: [...BOOTSTRAP_REQUIRED_FIELDS] });
  });

  it('falls back to the full required-field list as "missing" when the CLI returns unparseable output', async () => {
    const runClaude = vi.fn().mockResolvedValue('not json at all');

    const result = await bootstrapFieldMap(snapshot, { runClaude });

    expect(result).toEqual({ missing: [...BOOTSTRAP_REQUIRED_FIELDS] });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/atsBootstrap.test.ts`
Expected: FAIL — `Cannot find module '../src/lib/atsBootstrap.js'`

- [ ] **Step 4: Write the implementation**

Create `.claude/commands/ats-bootstrap-fieldmap.md`:

```markdown
---
description: Hybrid self-extending ATS bootstrap — derive a FieldMap (name/email/resume/submit selectors) for a job-application platform that isn't Greenhouse/Lever/Workday/Ashby
---

You are the ATS-bootstrapping step of Jobber's apply flow (see
`docs/superpowers/specs/2026-07-21-ats-bootstrap-design.md`). `apply_url` resolved to a domain
that doesn't match any of the 4 known ATS platforms (Greenhouse/Lever/Workday/Ashby). You are
given a snapshot of every actual form control on the live application page, and must pick which
ones correspond to which field — so the codebase can learn this platform once and reuse it on
every future application to the same domain.

Your input is a single JSON object, on one line:
`{"snapshot": {"inputs": [{"selector": "<css selector>", "type": "<input type>", "id": "<...>", "name": "<...>", "ariaLabel": "<...>", "placeholder": "<...>"}, ...], "buttons": [{"selector": "<css selector>", "text": "<visible button/link text>"}, ...]}, "requiredFields": ["name", "email", "resumeUpload", "submitButton"], "optionalFields": ["phone", "coverLetter"]}`

Rules:
- For each field in `requiredFields` and `optionalFields`, pick AT MOST ONE `selector` value
  copied VERBATIM from `snapshot.inputs` (for name/email/phone/resumeUpload/coverLetter) or
  `snapshot.buttons` (for submitButton) that best matches that field's purpose. Use each
  control's `id`/`name`/`ariaLabel`/`placeholder`/`type`/`text` as your only evidence.
- NEVER invent a selector that is not verbatim present in `snapshot`. If nothing in the snapshot
  plausibly matches a field, leave that field out of your `fieldMap` entirely — do not guess,
  do not force the closest-sounding control.
- If you cannot confidently resolve one or more fields in `requiredFields`, do not return a
  `fieldMap` at all — return `{"fieldMap": null, "missing": ["<unresolved required field
  name>", ...]}` instead. A guessed selector for a required field can silently corrupt or fail a
  real job application, so refuse rather than force a fit.
- Fields in `optionalFields` may be omitted from your `fieldMap` if nothing plausibly matches —
  this is expected and fine, do not fabricate to fill them in.

Respond with ONLY a single-line JSON object — no markdown fence, no commentary, nothing else:
`{"fieldMap": {"name": "<selector>", "email": "<selector>", "resumeUpload": "<selector>", "submitButton": "<selector>", "phone": "<selector>", "coverLetter": "<selector>"}}`
(omit any optional key you couldn't resolve)
or, if any required field is unresolved:
`{"fieldMap": null, "missing": ["<required field name>", ...]}`

Input:
$ARGUMENTS
```

Create `src/lib/atsBootstrap.ts`:

```typescript
import { z } from 'zod';
import { runClaudeCli, extractJson, type FallbackDeps } from './domFallback.js';
import type { FieldMap } from '../ats/types.js';
import type { FormControlSnapshot } from './domSnapshot.js';

export const BOOTSTRAP_REQUIRED_FIELDS = ['name', 'email', 'resumeUpload', 'submitButton'] as const;
export const BOOTSTRAP_OPTIONAL_FIELDS = ['phone', 'coverLetter'] as const;

/**
 * Guaranteed to match no real element on any page — used to fill an optional FieldMap slot
 * Claude couldn't resolve, so external.ts's existing `page.$(selector)` optional-field checks
 * see a safe "not found" instead of an invalid/empty selector string.
 */
export const UNRESOLVED_OPTIONAL_SELECTOR = '[data-ats-bootstrap-unresolved="true"]';

const BootstrapResponseSchema = z.object({
  fieldMap: z.record(z.string(), z.string()).nullable(),
  missing: z.array(z.string()).optional(),
});

export type BootstrapResult = { fieldMap: FieldMap } | { missing: string[] };

function selectorsInSnapshot(snapshot: FormControlSnapshot): Set<string> {
  return new Set([
    ...snapshot.inputs.map((i) => i.selector),
    ...snapshot.buttons.map((b) => b.selector),
  ]);
}

/**
 * Given a live-page form-control snapshot, asks Claude to pick selectors for a FieldMap —
 * only from selectors actually present in the snapshot (never invent one; re-validated here
 * independently of the prompt's own "never invent" instruction). Returns the complete
 * FieldMap on success (with UNRESOLVED_OPTIONAL_SELECTOR filled in for any unresolved optional
 * field), or the list of unresolved REQUIRED fields on failure.
 */
export async function bootstrapFieldMap(
  snapshot: FormControlSnapshot,
  deps: FallbackDeps = {}
): Promise<BootstrapResult> {
  const invoke = deps.runClaude ?? ((command: string, input: unknown) => runClaudeCli(command, input, deps.model));

  const raw = await invoke('ats-bootstrap-fieldmap', {
    snapshot,
    requiredFields: BOOTSTRAP_REQUIRED_FIELDS,
    optionalFields: BOOTSTRAP_OPTIONAL_FIELDS,
  });
  if (!raw) return { missing: [...BOOTSTRAP_REQUIRED_FIELDS] };

  const parsed = extractJson(raw, BootstrapResponseSchema);
  if (!parsed) return { missing: [...BOOTSTRAP_REQUIRED_FIELDS] };
  if (!parsed.fieldMap) {
    return { missing: parsed.missing && parsed.missing.length > 0 ? parsed.missing : [...BOOTSTRAP_REQUIRED_FIELDS] };
  }

  const validSelectors = selectorsInSnapshot(snapshot);
  const missing: string[] = [];
  for (const field of BOOTSTRAP_REQUIRED_FIELDS) {
    const selector = parsed.fieldMap[field];
    if (!selector || !validSelectors.has(selector)) missing.push(field);
  }
  if (missing.length > 0) return { missing };

  const fieldMap: Record<string, string> = {};
  for (const field of BOOTSTRAP_REQUIRED_FIELDS) {
    fieldMap[field] = parsed.fieldMap[field];
  }
  for (const field of BOOTSTRAP_OPTIONAL_FIELDS) {
    const selector = parsed.fieldMap[field];
    fieldMap[field] = selector && validSelectors.has(selector) ? selector : UNRESOLVED_OPTIONAL_SELECTOR;
  }

  return { fieldMap: fieldMap as unknown as FieldMap };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/atsBootstrap.test.ts`
Expected: PASS (6/6)

- [ ] **Step 6: Commit**

```bash
git add src/lib/domFallback.ts src/lib/atsBootstrap.ts .claude/commands/ats-bootstrap-fieldmap.md tests/atsBootstrap.test.ts
git commit -m "feat: add Claude-backed ATS FieldMap bootstrap (bootstrapFieldMap)"
```

---

### Task 4: Wire bootstrapping into `external.ts`, update docs

**Files:**
- Modify: `src/apply/external.ts`
- Modify: `tests/ats.test.ts`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: `detectLearned`/`saveLearnedPlatform` (Task 1), `snapshotFormControls` (Task 2),
  `bootstrapFieldMap` (Task 3).
- Produces: no new exports beyond the two new optional `ApplyExternalDeps` fields
  (`bootstrap?: FallbackDeps`, `learnedPlatformsPath?: string`) — this is the plan's final,
  user-facing integration task.

- [ ] **Step 1: Add the two new imports**

In `src/apply/external.ts`, add these imports right after the existing `import * as ashby from
'../ats/ashby.js';` line:

```typescript
import { detectLearned, saveLearnedPlatform } from '../ats/learned.js';
import { snapshotFormControls } from '../lib/domSnapshot.js';
import { bootstrapFieldMap } from '../lib/atsBootstrap.js';
```

- [ ] **Step 2: Add the two new `ApplyExternalDeps` fields**

In `src/apply/external.ts`, in the `ApplyExternalDeps` interface, add after the existing
`fallbackEnabled?: boolean;` line:

```typescript
  /**
   * Injectable Claude fallback for the self-extending ATS bootstrap step (always-on, no
   * opt-in flag — see docs/superpowers/specs/2026-07-21-ats-bootstrap-design.md). Separate
   * from `fallback` above, which only covers the opt-in submit-click escalation.
   */
  bootstrap?: FallbackDeps;
  /**
   * Override for the learned-platform registry file path, for testing without touching the
   * real config/learned-ats-platforms.json.
   */
  learnedPlatformsPath?: string;
```

- [ ] **Step 3: Replace the platform-detection branch**

In `src/apply/external.ts`, replace:

```typescript
  const ats = detectAts(job.apply_url);
  if (!ats) {
    return recordAndReturn(database, job_id, null, 'manual_review', 'unsupported ATS platform');
  }

  // Safety check for the per-platform tool split (apply.greenhouse/lever/workday/ashby): a
  // job's apply_url can drift from what the caller expects (e.g. a Greenhouse posting that
  // redirects through a Lever-branded domain). Refuse rather than silently applying through
  // the wrong platform's tool.
  if (expected_platform && ats.platform !== expected_platform) {
    return recordAndReturn(
      database,
      job_id,
      ats.platform,
      'manual_review',
      `expected platform "${expected_platform}" but apply_url resolved to "${ats.platform}"`
    );
  }
```

with:

```typescript
  let ats = detectAts(job.apply_url) ?? detectLearned(job.apply_url, deps.learnedPlatformsPath);

  if (!ats) {
    if (expected_platform) {
      // A caller invoking a SPECIFIC platform tool (apply.greenhouse et al.) always sets
      // expected_platform. An unrecognized domain there means a data problem (wrong apply_url
      // stored), not a legitimate new platform to learn — bootstrapping only ever fires for
      // the no-expected-platform case (a generic caller with no fixed platform in mind), never
      // through an explicit specific-platform tool call.
      return recordAndReturn(database, job_id, null, 'manual_review', 'unsupported ATS platform');
    }
    // else: fall through — attempt to bootstrap a FieldMap once the browser has launched, below.
  } else if (expected_platform && ats.platform !== expected_platform) {
    // Safety check for the per-platform tool split (apply.greenhouse/lever/workday/ashby): a
    // job's apply_url can drift from what the caller expects (e.g. a Greenhouse posting that
    // redirects through a Lever-branded domain). Refuse rather than silently applying through
    // the wrong platform's tool.
    return recordAndReturn(
      database,
      job_id,
      ats.platform,
      'manual_review',
      `expected platform "${expected_platform}" but apply_url resolved to "${ats.platform}"`
    );
  }
```

- [ ] **Step 4: Update the rate-limit gate's `platform` reference and its comment**

Replace:

```typescript
  // Gate immediately before the Playwright launch — after every cheap, pure, non-browser
  // pre-flight check above (job lookup, tailored-resume lookup, ATS detection, base resume
  // fetch) has already had a chance to reject the request for free, so a rejection never
  // burns a quota slot for a no-op.
  //
  // Judgment call: this shares the SAME 'easy_apply' counter key as linkedin.ts's
  // `apply_easy_apply`, per the design spec (docs/superpowers/specs/2026-07-07-jobapplier-
  // phase2-design.md §5.1: "Rate-limited by MAX_APPLIES_PER_DAY (shared counter with 5.2)"),
  // where §5.2 is this file. So `MAX_APPLIES_PER_DAY` is one combined daily cap across
  // LinkedIn Easy Apply + external ATS applies, not two independent caps.
  const maxPerDay =
    deps.maxAppliesPerDay ?? Number(process.env.MAX_APPLIES_PER_DAY ?? DEFAULT_MAX_APPLIES_PER_DAY);
  const allowed = checkAndIncrement(database, 'easy_apply', maxPerDay);
  if (!allowed) {
    return {
      job_id,
      status: 'rate_limited',
      platform: ats.platform,
      reason: `daily apply limit (${maxPerDay}) reached`,
    };
  }
```

with:

```typescript
  // Gate immediately before the Playwright launch — after every cheap, pure, non-browser
  // pre-flight check above (job lookup, tailored-resume lookup, ATS detection, base resume
  // fetch) has already had a chance to reject the request for free, so a rejection never
  // burns a quota slot for a no-op. An unrecognized domain with no expected_platform is NOT a
  // cheap rejection past this point — bootstrapping is a real attempt (browser launch + a
  // live Claude call) and still burns a slot, the same as any other apply attempt.
  //
  // Judgment call: this shares the SAME 'easy_apply' counter key as linkedin.ts's
  // `apply_easy_apply`, per the design spec (docs/superpowers/specs/2026-07-07-jobapplier-
  // phase2-design.md §5.1: "Rate-limited by MAX_APPLIES_PER_DAY (shared counter with 5.2)"),
  // where §5.2 is this file. So `MAX_APPLIES_PER_DAY` is one combined daily cap across
  // LinkedIn Easy Apply + external ATS applies, not two independent caps.
  const maxPerDay =
    deps.maxAppliesPerDay ?? Number(process.env.MAX_APPLIES_PER_DAY ?? DEFAULT_MAX_APPLIES_PER_DAY);
  const allowed = checkAndIncrement(database, 'easy_apply', maxPerDay);
  if (!allowed) {
    return {
      job_id,
      status: 'rate_limited',
      platform: ats?.platform ?? null,
      reason: `daily apply limit (${maxPerDay}) reached`,
    };
  }
```

- [ ] **Step 5: Add the bootstrap attempt right after `page.goto`, and switch the rest of the try block to a resolved, non-null `ats`**

Replace:

```typescript
    browser = await browserLauncher.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(job.apply_url, { timeout: 30000, waitUntil: 'domcontentloaded' });

    for (const [key, selector] of getRequiredFieldEntries(ats.fieldMap)) {
      const el = await page.$(selector);
      if (!el) {
        return recordAndReturn(
          database,
          job_id,
          ats.platform,
          'manual_review',
          `required field "${key}" not found on page (selector: ${selector})`
        );
      }
    }

    if (ats.fieldMap.firstName && ats.fieldMap.lastName) {
      const { first, last } = splitName(applicant.name);
      await page.fill(ats.fieldMap.firstName, first);
      await page.fill(ats.fieldMap.lastName, last);
    } else {
      await page.fill(ats.fieldMap.name, applicant.name ?? '');
    }

    await page.fill(ats.fieldMap.email, applicant.email ?? '');

    if (applicant.phone) {
      const phoneEl = await page.$(ats.fieldMap.phone);
      if (phoneEl) await page.fill(ats.fieldMap.phone, applicant.phone);
    }

    const coverLetterEl = await page.$(ats.fieldMap.coverLetter);
    if (coverLetterEl && prepared.body) {
      await page.fill(ats.fieldMap.coverLetter, prepared.body);
    }

    await page.setInputFiles(ats.fieldMap.resumeUpload, prepared.resume_path);

    const clickedSubmit = await findAndClickControl(
      page,
      ats.fieldMap.submitButton,
      'Submit the completed job application form',
      fallback
    );
    if (!clickedSubmit) {
      return recordAndReturn(
        database,
        job_id,
        ats.platform,
        'manual_review',
        `submit button not found on page (selector: ${ats.fieldMap.submitButton})`
      );
    }
```

with:

```typescript
    browser = await browserLauncher.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(job.apply_url, { timeout: 30000, waitUntil: 'domcontentloaded' });

    if (!ats) {
      let hostname: string | null = null;
      try {
        hostname = new URL(job.apply_url).hostname.toLowerCase();
      } catch {
        hostname = null;
      }

      const snapshot = await snapshotFormControls(page);
      const bootstrapResult = await bootstrapFieldMap(snapshot, deps.bootstrap);
      if ('missing' in bootstrapResult) {
        return recordAndReturn(
          database,
          job_id,
          hostname,
          'manual_review',
          `could not learn a field map for this platform — missing: ${bootstrapResult.missing.join(', ')}`
        );
      }

      if (hostname) saveLearnedPlatform(hostname, bootstrapResult.fieldMap, deps.learnedPlatformsPath);
      ats = { platform: hostname ?? 'unknown', fieldMap: bootstrapResult.fieldMap };
    }
    const resolvedAts = ats!;

    for (const [key, selector] of getRequiredFieldEntries(resolvedAts.fieldMap)) {
      const el = await page.$(selector);
      if (!el) {
        return recordAndReturn(
          database,
          job_id,
          resolvedAts.platform,
          'manual_review',
          `required field "${key}" not found on page (selector: ${selector})`
        );
      }
    }

    if (resolvedAts.fieldMap.firstName && resolvedAts.fieldMap.lastName) {
      const { first, last } = splitName(applicant.name);
      await page.fill(resolvedAts.fieldMap.firstName, first);
      await page.fill(resolvedAts.fieldMap.lastName, last);
    } else {
      await page.fill(resolvedAts.fieldMap.name, applicant.name ?? '');
    }

    await page.fill(resolvedAts.fieldMap.email, applicant.email ?? '');

    if (applicant.phone) {
      const phoneEl = await page.$(resolvedAts.fieldMap.phone);
      if (phoneEl) await page.fill(resolvedAts.fieldMap.phone, applicant.phone);
    }

    const coverLetterEl = await page.$(resolvedAts.fieldMap.coverLetter);
    if (coverLetterEl && prepared.body) {
      await page.fill(resolvedAts.fieldMap.coverLetter, prepared.body);
    }

    await page.setInputFiles(resolvedAts.fieldMap.resumeUpload, prepared.resume_path);

    const clickedSubmit = await findAndClickControl(
      page,
      resolvedAts.fieldMap.submitButton,
      'Submit the completed job application form',
      fallback
    );
    if (!clickedSubmit) {
      return recordAndReturn(
        database,
        job_id,
        resolvedAts.platform,
        'manual_review',
        `submit button not found on page (selector: ${resolvedAts.fieldMap.submitButton})`
      );
    }
```

- [ ] **Step 6: Update the remaining `ats.platform` references (confirmation-check and success return) to `resolvedAts.platform`**

Replace:

```typescript
    if (!confirmed) {
      return recordAndReturn(
        database,
        job_id,
        ats.platform,
        'manual_review',
        'clicked submit but could not confirm the application was actually recorded — verify manually'
      );
    }

    return recordAndReturn(database, job_id, ats.platform, 'submitted');
  } catch (err) {
    return recordAndReturn(
      database,
      job_id,
      ats.platform,
      'failed',
      (err as Error).message ?? 'unknown error during external apply'
    );
```

with:

```typescript
    if (!confirmed) {
      return recordAndReturn(
        database,
        job_id,
        resolvedAts.platform,
        'manual_review',
        'clicked submit but could not confirm the application was actually recorded — verify manually'
      );
    }

    return recordAndReturn(database, job_id, resolvedAts.platform, 'submitted');
  } catch (err) {
    return recordAndReturn(
      database,
      job_id,
      ats?.platform ?? null,
      'failed',
      (err as Error).message ?? 'unknown error during external apply'
    );
```

- [ ] **Step 7: Add `evaluate` to the shared fake-page test fixture**

In `tests/ats.test.ts`, in `makeFakeExternalApplyPage`, add an `evaluate` mock to the returned
`page` object so bootstrap tests can control what `snapshotFormControls` sees, while every
existing test (which never triggers bootstrapping) keeps working unchanged with the default
empty snapshot. Add a new parameter and the `evaluate` field:

Replace:

```typescript
function makeFakeExternalApplyPage({
  submitButtonSelector,
  submitButtonFound = true,
  confirmationAppears = true,
  clickableCandidates = [] as string[],
  clickableElementsByText = {} as Record<string, { click: ReturnType<typeof vi.fn> }>,
}: {
  submitButtonSelector: string;
  submitButtonFound?: boolean;
  confirmationAppears?: boolean;
  clickableCandidates?: string[];
  clickableElementsByText?: Record<string, { click: ReturnType<typeof vi.fn> }>;
}) {
  const submitButton = { click: vi.fn().mockResolvedValue(undefined) };

  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    $: vi.fn().mockResolvedValue({}), // every required-field/optional-field lookup "found"
    fill: vi.fn().mockResolvedValue(undefined),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
```

with:

```typescript
function makeFakeExternalApplyPage({
  submitButtonSelector,
  submitButtonFound = true,
  confirmationAppears = true,
  clickableCandidates = [] as string[],
  clickableElementsByText = {} as Record<string, { click: ReturnType<typeof vi.fn> }>,
  rawSnapshot = { inputs: [], buttons: [] } as { inputs: unknown[]; buttons: unknown[] },
}: {
  submitButtonSelector: string;
  submitButtonFound?: boolean;
  confirmationAppears?: boolean;
  clickableCandidates?: string[];
  clickableElementsByText?: Record<string, { click: ReturnType<typeof vi.fn> }>;
  rawSnapshot?: { inputs: unknown[]; buttons: unknown[] };
}) {
  const submitButton = { click: vi.fn().mockResolvedValue(undefined) };

  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(rawSnapshot),
    $: vi.fn().mockResolvedValue({}), // every required-field/optional-field lookup "found"
    fill: vi.fn().mockResolvedValue(undefined),
    setInputFiles: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 8: Rewrite the "unsupported ATS" pre-flight test — this scenario now bootstraps instead of failing fast**

In `tests/ats.test.ts`, in the `describe('applyExternal rate limiting (Finding 1)', ...)` block,
replace the existing test:

```typescript
  it('does not burn a quota slot on a cheap pre-flight rejection (Finding 2: unsupported ATS)', async () => {
    saveJob(db, {
      id: 'job-ext-unsupported-ats',
      source: 'other',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://example.com/careers/123',
      apply_url: 'https://example.com/careers/123',
      description: 'React role',
    });
    saveOutreach(db, {
      job_id: 'job-ext-unsupported-ats',
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Cover letter body',
      resume_path: '/tmp/fake-resume.pdf',
    });
    const launch = vi.fn();

    const result = await applyExternal(
      { job_id: 'job-ext-unsupported-ats' },
      { db, maxAppliesPerDay: 5, chromium: { launch } }
    );

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/unsupported ATS platform/);
    expect(launch).not.toHaveBeenCalled();

    const row = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?")
      .get('easy_apply') as { count: number } | undefined;
    expect(row).toBeUndefined();
  });
```

with:

```typescript
  it('rejects immediately without launching a browser when expected_platform is set and the URL matches no known/learned platform', async () => {
    // A caller invoking one of the 4 explicit per-platform tools always sets
    // expected_platform — an unrecognized domain there is a data problem (wrong apply_url),
    // not a bootstrap opportunity, so this stays a cheap pre-flight rejection.
    saveJob(db, {
      id: 'job-ext-unsupported-explicit',
      source: 'other',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://example.com/careers/123',
      apply_url: 'https://example.com/careers/123',
      description: 'React role',
    });
    saveOutreach(db, {
      job_id: 'job-ext-unsupported-explicit',
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Cover letter body',
      resume_path: '/tmp/fake-resume.pdf',
    });
    const launch = vi.fn();

    const result = await applyExternal(
      { job_id: 'job-ext-unsupported-explicit', expected_platform: 'greenhouse' },
      { db, maxAppliesPerDay: 5, chromium: { launch } }
    );

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/unsupported ATS platform/);
    expect(launch).not.toHaveBeenCalled();

    const row = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?")
      .get('easy_apply') as { count: number } | undefined;
    expect(row).toBeUndefined();
  });

  it('attempts to bootstrap a new field map (no expected_platform) for an unrecognized domain, falling to manual_review when the bootstrap cannot resolve any required field', async () => {
    saveJob(db, {
      id: 'job-ext-unsupported-bootstrap',
      source: 'other',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: 'https://example.com/careers/123',
      apply_url: 'https://example.com/careers/123',
      description: 'React role',
    });
    saveOutreach(db, {
      job_id: 'job-ext-unsupported-bootstrap',
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Cover letter body',
      resume_path: '/tmp/fake-resume.pdf',
    });
    const { page } = makeFakeExternalApplyPage({
      submitButtonSelector: '#submit',
      rawSnapshot: { inputs: [], buttons: [] },
    });
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);
    const runClaude = vi.fn().mockResolvedValue(null); // simulates the bootstrap CLI call failing/finding nothing

    const result = await applyExternal(
      { job_id: 'job-ext-unsupported-bootstrap' },
      { db, maxAppliesPerDay: 5, chromium: { launch }, bootstrap: { runClaude } }
    );

    expect(result.status).toBe('manual_review');
    expect(result.reason).toMatch(/could not learn a field map for this platform/);
    expect(result.platform).toBe('example.com');
    expect(launch).toHaveBeenCalled();

    // Unlike the cheap pre-flight rejections above, a bootstrap ATTEMPT is real work
    // (browser launch + a live Claude call) and burns a quota slot just like any other apply.
    const row = db
      .prepare("SELECT count FROM daily_counters WHERE day = date('now') AND key = ?")
      .get('easy_apply') as { count: number } | undefined;
    expect(row?.count).toBe(1);
  });
```

- [ ] **Step 9: Add success-path and learned-registry-reuse tests**

In `tests/ats.test.ts`, add a new `describe` block after the hybrid-fallback describe block:

```typescript
describe('applyExternal self-extending ATS bootstrap (success + reuse)', () => {
  let db: Database.Database;
  let tmpDir: string;
  let learnedPlatformsPath: string;

  beforeEach(() => {
    db = openDb(':memory:');
    tmpDir = mkdtempSync(path.join(tmpdir(), 'ats-bootstrap-test-'));
    learnedPlatformsPath = path.join(tmpDir, 'learned-ats-platforms.json');
  });

  afterEach(() => {
    if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedApplicableJob(jobId: string, applyUrl: string) {
    saveJob(db, {
      id: jobId,
      source: 'other',
      title: 'Full Stack Developer',
      company: 'Acme Corp',
      url: applyUrl,
      apply_url: applyUrl,
      description: 'React role',
    });
    saveOutreach(db, {
      job_id: jobId,
      contact_email: 'hiring@acme.com',
      subject: 'Application',
      body: 'Cover letter body',
      resume_path: '/tmp/fake-resume.pdf',
    });
  }

  it('learns a FieldMap for a new platform, persists it, and submits through it in the same run', async () => {
    seedApplicableJob('job-ext-bootstrap-success', 'https://jobs.newats.example/apply/123');
    const rawSnapshot = {
      inputs: [
        { tag: 'input', id: 'full_name', indexAmongSameTag: 0 },
        { tag: 'input', id: 'email_addr', indexAmongSameTag: 1 },
        { tag: 'input', name: 'resume', indexAmongSameTag: 2 },
      ],
      buttons: [{ tag: 'button', id: 'submit_btn', text: 'Submit', indexAmongSameTag: 0 }],
    };
    const { page, submitButton } = makeFakeExternalApplyPage({
      submitButtonSelector: '#submit_btn',
      confirmationAppears: true,
      rawSnapshot,
    });
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);
    const runClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        fieldMap: {
          name: '#full_name',
          email: '#email_addr',
          resumeUpload: 'input[name="resume"]',
          submitButton: '#submit_btn',
        },
      })
    );

    const result = await applyExternal(
      { job_id: 'job-ext-bootstrap-success' },
      { db, chromium: { launch }, bootstrap: { runClaude }, learnedPlatformsPath }
    );

    expect(result.status).toBe('submitted');
    expect(result.platform).toBe('jobs.newats.example');
    expect(submitButton.click).toHaveBeenCalledTimes(1);

    const registry = JSON.parse(readFileSync(learnedPlatformsPath, 'utf8'));
    expect(registry['jobs.newats.example'].name).toBe('#full_name');
  });

  it('reuses a previously learned platform on a later call without invoking the bootstrap Claude fallback again', async () => {
    seedApplicableJob('job-ext-bootstrap-reuse', 'https://jobs.newats.example/apply/456');
    saveLearnedPlatform(
      'jobs.newats.example',
      {
        name: '#full_name',
        email: '#email_addr',
        phone: '#phone',
        resumeUpload: 'input[name="resume"]',
        coverLetter: '#cover',
        submitButton: '#submit_btn',
      },
      learnedPlatformsPath
    );
    const { page, submitButton } = makeFakeExternalApplyPage({
      submitButtonSelector: '#submit_btn',
      confirmationAppears: true,
    });
    const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn().mockResolvedValue(undefined) };
    const launch = vi.fn().mockResolvedValue(browser);
    const runClaude = vi.fn();

    const result = await applyExternal(
      { job_id: 'job-ext-bootstrap-reuse' },
      { db, chromium: { launch }, bootstrap: { runClaude }, learnedPlatformsPath }
    );

    expect(result.status).toBe('submitted');
    expect(submitButton.click).toHaveBeenCalledTimes(1);
    expect(runClaude).not.toHaveBeenCalled();
  });
});
```

Add the new imports this step and Task 4's other steps need at the top of `tests/ats.test.ts`
(next to the existing imports):

```typescript
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { saveLearnedPlatform } from '../src/ats/learned.js';
```

- [ ] **Step 10: Run the full test suite and typecheck**

Run: `npx vitest run`
Expected: PASS, all tests green (previous total + 6 new `ats-learned` + 5 new `domSnapshot` + 6
new `atsBootstrap` + 3 net-new `ats.test.ts` cases: the old "unsupported ATS" test is replaced
by 2 new ones in Step 8, net +1 there, plus the 2 new success/reuse tests added in Step 9)

Run: `npx tsc -p . --noEmit`
Expected: no new errors (the 2 pre-existing, unrelated `linkedin.ts` errors may still appear,
same as before this plan)

- [ ] **Step 11: Update CLAUDE.md**

In `CLAUDE.md`, in the `### Hybrid Claude fallback (Easy Apply + external ATS, opt-in)` section,
add a new subsection immediately after it (before the "None of `external.ts`'s new
confirmation-check/fallback behavior..." paragraph):

```markdown
### Self-extending ATS bootstrapping

When `apply_url` resolves to a domain that matches none of the 4 known ATS platforms
(Greenhouse/Lever/Workday/Ashby) — and the caller did NOT pin a specific `expected_platform`
(i.e. not one of the 4 explicit `apply.<platform>` tools, which always fail closed to
`manual_review` on a mismatch rather than bootstrap) — `external.ts` attempts to learn a
`FieldMap` for it from a live snapshot of the page's form controls, via a bounded `claude
--print` call (`.claude/commands/ats-bootstrap-fieldmap.md`), always on with no opt-in flag
(unlike the hybrid fallbacks above). On success the learned `FieldMap` is persisted to
`config/learned-ats-platforms.json` (read fresh on every call, no reconnect needed) and used
immediately for the current application — same required-field/confirmation-text safety nets as
the 4 built-in platforms, no special leniency. On failure (any of name/email/resumeUpload/
submitButton unresolved), nothing is written and the application falls to `manual_review`.
See `docs/superpowers/specs/2026-07-21-ats-bootstrap-design.md` for the full design.
```

And in the paragraph beginning "None of `external.ts`'s new confirmation-check/fallback
behavior has been live-tested...", append one sentence:

```markdown
The self-extending ATS bootstrap above is in the same boat — it has unit-test coverage but has
never been exercised against a real unrecognized-ATS posting.
```

- [ ] **Step 12: Commit**

```bash
git add src/apply/external.ts tests/ats.test.ts CLAUDE.md
git commit -m "feat: wire self-extending ATS bootstrapping into applyExternal"
```

---

### Task 5: `apply.auto` router (added post-final-review)

The final whole-branch review found that Tasks 1-4 landed correctly but had no live
caller: every registered MCP tool (`apply.linkedin`, `apply.greenhouse`, `apply.lever`,
`apply.workday`, `apply.ashby`) always pins `expected_platform`, and bootstrapping is
intentionally gated to only fire when `expected_platform` is absent. CLAUDE.md already
describes an `apply.auto({apply_url, job_id})` router tool ("inspects `apply_url` and
internally dispatches to the matching platform tool... a thin dispatcher over the same
per-platform tools, so there is one source of truth per platform, not two") but it was
never actually implemented. The user chose to build it now rather than defer it, so this
feature has a real caller before merge.

**Files:**
- Modify: `src/mcp/apply.ts`
- Test: `tests/apply-auto.test.ts` (new)

**Interfaces:**
- Consumes: `detectAts` (existing export from `src/apply/external.ts`), `applyExternal`
  (existing), `applyEasyApply` (existing, from `src/apply/linkedin.ts`).
- Produces: a new `auto` tool registered on the existing `apply` MCP server, taking
  `{apply_url: string, job_id: string}` and returning the same JSON shape the underlying
  tool it dispatches to returns.

- [ ] **Step 1: Write the failing tests**

Create `tests/apply-auto.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';

// apply.ts is an MCP server entrypoint (registers tools against a McpServer instance and
// calls server.connect() at import time unless VITEST=true is set) — so this test exercises
// the pure routing decision directly rather than spinning up the MCP server, mirroring how
// this project already avoids testing its other *.ts MCP entrypoints end-to-end.
import { routeApplyAuto } from '../src/mcp/applyAutoRouter.js';

describe('routeApplyAuto', () => {
  it('routes a Greenhouse URL to the greenhouse platform with expected_platform pinned', () => {
    expect(routeApplyAuto('https://boards.greenhouse.io/acme/jobs/123')).toEqual({
      kind: 'external',
      platform: 'greenhouse',
    });
  });

  it('routes a Lever URL to the lever platform with expected_platform pinned', () => {
    expect(routeApplyAuto('https://jobs.lever.co/acme/abc-123')).toEqual({
      kind: 'external',
      platform: 'lever',
    });
  });

  it('routes a LinkedIn URL to the linkedin (Easy Apply) path', () => {
    expect(routeApplyAuto('https://www.linkedin.com/jobs/view/123456')).toEqual({ kind: 'linkedin' });
  });

  it('routes an unrecognized domain to the bootstrap path (external, no expected_platform)', () => {
    expect(routeApplyAuto('https://jobs.newats.example/apply/123')).toEqual({
      kind: 'external',
      platform: null,
    });
  });

  it('routes a malformed URL to the bootstrap path rather than throwing', () => {
    expect(routeApplyAuto('not a url')).toEqual({ kind: 'external', platform: null });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/apply-auto.test.ts`
Expected: FAIL — `Cannot find module '../src/mcp/applyAutoRouter.js'`

- [ ] **Step 3: Write the implementation**

Create `src/mcp/applyAutoRouter.ts` (the pure routing decision, kept separate from
`apply.ts` so it's unit-testable without booting an MCP server):

```typescript
import { detectAts } from '../apply/external.js';

export type ApplyAutoRoute = { kind: 'linkedin' } | { kind: 'external'; platform: string | null };

function isLinkedInUrl(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('linkedin.com');
  } catch {
    return false;
  }
}

/**
 * Pure routing decision for the `apply.auto` tool: inspects `apply_url` and decides which
 * underlying apply path handles it. Never reimplements platform logic itself — a
 * `{kind: 'external', platform: null}` result means "no known platform matched; let
 * applyExternal's own bootstrap step (learn-or-manual_review) handle it," exactly the
 * no-expected_platform case self-extending ATS bootstrapping requires to ever fire.
 */
export function routeApplyAuto(applyUrl: string): ApplyAutoRoute {
  if (isLinkedInUrl(applyUrl)) return { kind: 'linkedin' };
  const ats = detectAts(applyUrl);
  return { kind: 'external', platform: ats?.platform ?? null };
}
```

Modify `src/mcp/apply.ts` — add the import and register the new tool. Add this import
alongside the existing ones:

```typescript
import { routeApplyAuto } from './applyAutoRouter.js';
```

Add this tool registration after the `for (const platform of [...])` loop and before
`async function main()`:

```typescript
server.registerTool(
  'auto',
  {
    description:
      'Routes an application to the correct apply.<platform> tool by inspecting apply_url. ' +
      'Thin dispatcher only — does not reimplement platform logic, so there is one source of ' +
      'truth per platform, not two. An apply_url matching none of the known platforms is passed ' +
      'through to the external-ATS path with no pinned platform, which lets it attempt to learn ' +
      'a new platform (self-extending ATS bootstrapping) instead of refusing outright.',
    inputSchema: {
      apply_url: z.string(),
      job_id: z.string(),
    },
  },
  async ({ apply_url, job_id }) => {
    const route = routeApplyAuto(apply_url);
    const result =
      route.kind === 'linkedin'
        ? await applyEasyApply({ job_id })
        : await applyExternal({ job_id, expected_platform: route.platform ?? undefined });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/apply-auto.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npx vitest run`
Expected: PASS (previous total + 5)

Run: `npx tsc -p . --noEmit`
Expected: only the 2 pre-existing unrelated `linkedin.ts` errors, no new ones

- [ ] **Step 6: Update CLAUDE.md**

In `CLAUDE.md`, the very first paragraph already describes `apply.auto` in the present
tense as if it exists ("`apply` is one MCP server exposing both a per-platform tool for
each target... and a single `apply.auto({apply_url, job_id})` router tool..."). No text
change is needed there — this task makes that description true. Add one sentence to the
"Self-extending ATS bootstrapping" subsection added in Task 4, noting `apply.auto` is now
the router that can actually reach the no-`expected_platform` bootstrap path:

Find this sentence (added in Task 4):

```markdown
When `apply_url` resolves to a domain that matches none of the 4 known ATS platforms
```

Replace the paragraph's opening with:

```markdown
`apply.auto` is the only caller that can ever reach this path — the 4 explicit per-platform
tools always pin `expected_platform`, which fails closed instead of bootstrapping (see
"Applying (Phase 2)" above). When `apply_url` resolves to a domain that matches none of the 4
known ATS platforms
```

- [ ] **Step 7: Commit**

```bash
git add src/mcp/apply.ts src/mcp/applyAutoRouter.ts tests/apply-auto.test.ts CLAUDE.md
git commit -m "feat: add apply.auto router so ATS bootstrapping has a live caller"
```
