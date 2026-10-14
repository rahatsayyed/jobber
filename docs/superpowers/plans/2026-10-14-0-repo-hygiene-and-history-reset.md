> Superseded in part: the PII scanner, its allowlist and the pii-patterns files were removed on 2026-10-14; the user-data folder, templates and file-name guard remain.

# Plan 0: Repository hygiene, user-data folder and history reset

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Per project preference, dispatch subagents with `model: sonnet`.

**Goal:** Make the repository safe to share: all personal files live in one untracked `user-data/` folder with committed synthetic templates, guard rails stop personal data coming back, and the whole history is replaced by one clean commit. Do this before building anything else.

**Architecture:** One tiny module (`src/lib/userData.ts`) is the only place that knows where personal files live (`user-data/` by default, overridable by `JOBAPPLIER_USER_DATA`). Every reader of a personal file goes through it. A script copies existing files into `user-data/` (migrate) or copies the templates there (init). A PII scanner (pure functions plus a CLI that never prints matched text) drives the cleanup and runs as a pre-commit hook. The history reset is the last task, gated on explicit owner confirmation at each destructive step, with a verified backup first.

**Tech Stack:** TypeScript (strict, ESM, `.js` import suffixes), vitest, git, bash.

**Spec:** `docs/superpowers/specs/2026-10-14-platform-sessions-dashboard-setup-requirements.md` ("Config and data hygiene")

## Why this goes first

Everything built later (the outreach runtime, ccgram, the dashboard, `AUTO_UPDATE`) adds commits. Resetting history once, at the start, means no later commit has to be rewritten, and the repository can be shared as soon as it is clean.

## Facts found on 2026-10-14 (read-only inventory)

- 241 commits, 322 tracked files; remote `origin` is `git@me:example-user/jobber.git` (visibility unknown; check before anything else).
- Personal files tracked in git and the code that reads them:
  - `input/resume.json`: read by `getBaseResume()` in `src/resume.ts:21`.
  - `renderer/input/resume.json`: a default sample used only when the renderer runs with no folder argument; per-job renders use the already-ignored `renderer/automation/`.
  - `config/easy-apply-answers.json`: read by `src/apply/linkedin.ts:25`.
  - `config/fact-gate.json`: read by `src/resumeFacts.ts:94`.
  - `config/languages.json`: read by `src/languageGate.ts:192`.
  - `scripts/eval/fixtures/base-resume.json` and `scripts/eval/fixtures/baseline/**`: a copy and tailored copies of the real resume, used by `scripts/eval/*.ts`, `tests/proseClaims.test.ts` and `tests/evalLib.test.ts`.
- Tests that depend on the owner's real data: at least `tests/gulfGates.test.ts` (asserts the shipped `config/languages.json`), `tests/proseClaims.test.ts`, `tests/evalLib.test.ts`.
- Names, emails, phone numbers or real third-party LinkedIn profile URLs also appear in `CLAUDE.md`, `README.md`, `ResumeGuide.md`, `docs/gmail-mcp-setup.md` and several specs and plans.
- Untracked and safe already: `.env`, `secrets/`, `data.sqlite`, `reports/`, `renderer/automation/`.
- A history reset does NOT remove anything already pushed to a public remote that others cloned or forked. If the repository was ever public, treat every credential that was ever committed as burned and rotate it.

## Global Constraints

- Personal files live only in `user-data/` (gitignored, directory mode 700, files mode 600). Templates live in `user-data.example/` (committed, synthetic). Nothing else may hold real personal data.
- Every reader of a personal file uses `userDataPath(...)`; no source file builds those paths by hand.
- Tests never read the owner's real files: `vitest.config.ts` sets `JOBAPPLIER_USER_DATA=user-data.example`.
- No step force-pushes, deletes a branch, or rewrites history without the owner's explicit confirmation in the same conversation. Tasks 1 to 6 are non-destructive.
- The scanner never prints matched text, only file, line and rule id.
- Implementers and reviewers never print, quote or paste the contents of any file under `user-data/` or any real personal value (in reports, commit messages or test output). Refer to files and keys only.
- Real personal values never appear in committed files, test fixtures or commit messages; templates use a synthetic person ("Jane Doe", `jane@example.com`, `+00 0000000000`, `linkedin.com/in/example-person`).
- The owner's own terms (name, email, phone, handles) live only in the gitignored `user-data/pii-patterns.json`.
- Imports use `.js` suffixes; tests live in `tests/*.test.ts`; run with `npx vitest run <file>`.

## Review Focus

1. **A reader still using a hard-coded legacy path** would silently read nothing or an old copy; a lint test fails if any source file builds a legacy personal path (Task 3).
2. **A missing personal file** must produce a clear "run init or setup" message, not a stack trace (Task 3).
3. **Migration overwriting an existing user-data file** must never happen (Task 1 test).
4. **Scanner false negatives** on the owner's terms in odd formats, and **scanner output leaking PII** (Task 2).
5. **Synthetic emails and handles** must not fail the scan, or the hook becomes noise and gets disabled (Task 2).
6. **Templates drifting from the real schema:** each template must have the same keys as the real file when the real file is present (Task 4 test).
7. **Eval fixtures that embed a tailored copy of the real resume** must be untracked, and the tests that read them must skip cleanly when they are absent (Task 4).
8. **The history reset succeeding while old objects remain reachable** (old branches, tags, stashes, reflog, remote refs) must be caught by final verification (Task 7).

## Decisions to confirm (assumed here)

- `user-data/` holds only personal data: `resume.json`, `easy-apply-answers.json`, `fact-gate.json`, `languages.json`, `pii-patterns.json`. Preference files (`config/portals.json`, `target-regions.json`, `deal-breakers.json`, `replies.json`, `discover-linkedin.json`) stay in `config/` for now; they move into a per-user profile in plan 7B.
- Eval baselines are not kept: `base-resume.json` and `baseline/` are untracked, the tests that read them skip when absent, and a user regenerates them with their own resume (`npm run eval:gen`).
- Third-party LinkedIn profile URLs in docs and `CLAUDE.md` are replaced with `example-person` placeholders.
- Who fills `user-data/`: for now `npm run user-data -- init` copies the templates and the owner edits them. In plan 7B a Claude setup skill takes the user's resume, asks the job, salary and screening questions, and writes these files for them.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/userData.ts` | `userDataDir`, `userDataPath`, legacy path map, `planMigration`, `planInit` |
| `scripts/user-data.ts` | CLI: `init` (copy templates) and `migrate` (copy existing files in) |
| `user-data.example/*` | Committed synthetic templates and a README |
| `src/hygiene/piiScan.ts` | Pure scan functions: rules, allowlist, `scanText` |
| `scripts/hygiene/pii-scan.ts` | CLI: scan tracked or staged files, print `file:line:rule`, exit 1 on any hit |
| `.githooks/pre-commit` | Blocks personal and secret files, runs the staged scan |
| `.gitignore` (modify) | `user-data/` and the other personal paths |
| `vitest.config.ts` (modify) | `JOBAPPLIER_USER_DATA=user-data.example` for tests |
| `tests/userdata-*.test.ts`, `tests/hygiene-*.test.ts` | Tests |

---

### Task 1: The user-data module and script

**Files:**
- Create: `src/lib/userData.ts`, `scripts/user-data.ts`
- Modify: `package.json` (scripts), `.gitignore`
- Test: `tests/userdata-module.test.ts`

**Interfaces:**
- Produces:
  - `USER_FILES` = `['resume.json', 'easy-apply-answers.json', 'fact-gate.json', 'languages.json', 'pii-patterns.json']`, `type UserFile`
  - `userDataDir(env?: NodeJS.ProcessEnv, root?: string): string`
  - `userDataPath(file: UserFile, env?, root?): string`
  - `missingUserDataMessage(file: UserFile): string`
  - `LEGACY_PATHS: Record<UserFile, string[]>`
  - `type CopyOp = { from: string; to: string }`
  - `planMigration(root: string, exists: (p: string) => boolean, env?): CopyOp[]`
  - `planInit(root: string, exists: (p: string) => boolean, env?): CopyOp[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/userdata-module.test.ts
import { describe, it, expect } from 'vitest';
import {
  LEGACY_PATHS,
  USER_FILES,
  missingUserDataMessage,
  planInit,
  planMigration,
  userDataDir,
  userDataPath,
} from '../src/lib/userData.js';

describe('userDataDir', () => {
  it('defaults to <root>/user-data', () => {
    expect(userDataDir({}, '/p')).toBe('/p/user-data');
  });
  it('honours JOBAPPLIER_USER_DATA, relative to the root or absolute, and ignores blanks', () => {
    expect(userDataDir({ JOBAPPLIER_USER_DATA: 'user-data.example' }, '/p')).toBe('/p/user-data.example');
    expect(userDataDir({ JOBAPPLIER_USER_DATA: '/abs/dir' }, '/p')).toBe('/abs/dir');
    expect(userDataDir({ JOBAPPLIER_USER_DATA: '   ' }, '/p')).toBe('/p/user-data');
  });
});

describe('userDataPath and the missing-file message', () => {
  it('joins the directory and the file name', () => {
    expect(userDataPath('resume.json', {}, '/p')).toBe('/p/user-data/resume.json');
  });
  it('tells the user how to fix a missing file', () => {
    const msg = missingUserDataMessage('resume.json');
    expect(msg).toContain('user-data/resume.json');
    expect(msg).toContain('init');
  });
});

describe('planMigration', () => {
  it('copies each existing legacy file whose target is missing, and never overwrites a target', () => {
    const existing = new Set([
      '/p/input/resume.json',
      '/p/config/languages.json',
      '/p/config/fact-gate.json',
      '/p/user-data/fact-gate.json',
    ]);
    const ops = planMigration('/p', (f) => existing.has(f), {});
    expect(ops).toEqual([
      { from: '/p/input/resume.json', to: '/p/user-data/resume.json' },
      { from: '/p/config/languages.json', to: '/p/user-data/languages.json' },
    ]);
  });
  it('covers every user file with at least one legacy path', () => {
    for (const f of USER_FILES) expect(LEGACY_PATHS[f].length).toBeGreaterThan(0);
  });
});

describe('planInit', () => {
  it('copies the template for each missing file only', () => {
    const existing = new Set(['/p/user-data/resume.json']);
    const ops = planInit('/p', (f) => existing.has(f), {});
    expect(ops.map((o) => o.to.split('/').pop()).sort()).toEqual(USER_FILES.filter((f) => f !== 'resume.json').sort());
    for (const op of ops) expect(op.from.startsWith('/p/user-data.example/')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/userdata-module.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `src/lib/userData.ts`**

```ts
// src/lib/userData.ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const USER_FILES = [
  'resume.json',
  'easy-apply-answers.json',
  'fact-gate.json',
  'languages.json',
  'pii-patterns.json',
] as const;
export type UserFile = (typeof USER_FILES)[number];

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function userDataDir(env: NodeJS.ProcessEnv = process.env, root: string = projectRoot): string {
  const override = env.JOBAPPLIER_USER_DATA?.trim();
  if (override) return path.isAbsolute(override) ? override : path.resolve(root, override);
  return path.join(root, 'user-data');
}

export function userDataPath(file: UserFile, env: NodeJS.ProcessEnv = process.env, root: string = projectRoot): string {
  return path.join(userDataDir(env, root), file);
}

export function missingUserDataMessage(file: UserFile): string {
  return `user-data/${file} not found. Run \`npm run user-data -- init\` to copy the templates, then fill them in (the setup skill does this for you).`;
}

/** Where each file lived before the user-data folder existed (relative to the project root). */
export const LEGACY_PATHS: Record<UserFile, string[]> = {
  'resume.json': ['input/resume.json'],
  'easy-apply-answers.json': ['config/easy-apply-answers.json'],
  'fact-gate.json': ['config/fact-gate.json'],
  'languages.json': ['config/languages.json'],
  'pii-patterns.json': ['config/pii-patterns.local.json'],
};

export interface CopyOp {
  from: string;
  to: string;
}

export function planMigration(
  root: string,
  exists: (p: string) => boolean,
  env: NodeJS.ProcessEnv = process.env,
): CopyOp[] {
  const ops: CopyOp[] = [];
  for (const file of USER_FILES) {
    const to = userDataPath(file, env, root);
    if (exists(to)) continue;
    const from = LEGACY_PATHS[file].map((rel) => path.join(root, rel)).find((p) => exists(p));
    if (from) ops.push({ from, to });
  }
  return ops;
}

export function planInit(root: string, exists: (p: string) => boolean, env: NodeJS.ProcessEnv = process.env): CopyOp[] {
  const ops: CopyOp[] = [];
  for (const file of USER_FILES) {
    const to = userDataPath(file, env, root);
    if (!exists(to)) ops.push({ from: path.join(root, 'user-data.example', file), to });
  }
  return ops;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/userdata-module.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the script and the npm entry**

```ts
// scripts/user-data.ts
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { planInit, planMigration, userDataDir } from '../src/lib/userData.js';

const root = resolve(import.meta.dirname, '..');
const command = process.argv[2];
const ops =
  command === 'migrate' ? planMigration(root, existsSync) : command === 'init' ? planInit(root, existsSync) : null;

if (!ops) {
  console.error('usage: npm run user-data -- <init|migrate>');
  process.exit(2);
}

const dir = userDataDir(process.env, root);
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
for (const op of ops) {
  mkdirSync(dirname(op.to), { recursive: true });
  copyFileSync(op.from, op.to);
  chmodSync(op.to, 0o600);
  console.log(`copied ${op.from.replace(root + '/', '')} -> ${op.to.replace(root + '/', '')}`);
}
console.log(ops.length ? `${ops.length} file(s) copied` : 'nothing to copy');
```

In `package.json`, add to `scripts`:

```json
"user-data": "tsx scripts/user-data.ts"
```

- [ ] **Step 6: Ignore `user-data/` first (append the line `user-data/` to `.gitignore`), then migrate the owner's real files into it (non-destructive copy)**

Run: `npm run user-data -- migrate`
Expected: it lists the copied files (resume, answers, fact-gate, languages, and the local terms file if it exists). The originals are still in place; Task 4 removes them from git.

- [ ] **Step 7: Commit**

```bash
git add src/lib/userData.ts scripts/user-data.ts package.json .gitignore tests/userdata-module.test.ts
git commit -m "feat(hygiene): user-data folder module with init and migrate"
```

---

### Task 2: PII scanner

**Files:**
- Create: `src/hygiene/piiScan.ts`, `scripts/hygiene/pii-scan.ts`
- Modify: `package.json` (scripts)
- Test: `tests/hygiene-pii-scan.test.ts`

**Interfaces:**
- Produces:
  - `type Hit = { file: string; line: number; rule: string }`, `Rule = { id: string; re: RegExp }`
  - `ALLOWED_EMAIL_DOMAINS`
  - `compileLocalTerms(terms: string[]): Rule[]`
  - `scanText(file: string, text: string, localTerms?: Rule[]): Hit[]`
- Rules: `email` (not on an allowed domain), `phone` (international or 10-digit, with optional spaces or dashes), `linkedin_profile` (`linkedin.com/in/<handle>` except the synthetic handles), `local_term:<n>` (owner's terms, case-insensitive, never echoing the term).

- [ ] **Step 1: Write the failing test**

```ts
// tests/hygiene-pii-scan.test.ts
import { describe, it, expect } from 'vitest';
import { compileLocalTerms, scanText } from '../src/hygiene/piiScan.js';

const rules = (text: string, terms: string[] = []): string[] =>
  scanText('f.md', text, compileLocalTerms(terms)).map((h) => h.rule);

describe('scanText', () => {
  it('finds real-looking emails and ignores allowlisted synthetic domains', () => {
    expect(rules('contact someone@gmail.com today')).toContain('email');
    expect(rules('jane@example.com and jobs@acme.com and a@users.noreply.github.com')).toEqual([]);
  });

  it('finds phone numbers in common formats', () => {
    expect(rules('call +91 90000 00000 now')).toContain('phone');
    expect(rules('call 9000000000 now')).toContain('phone');
    expect(rules('call +1-415-555-0100 now')).toContain('phone');
    expect(rules('version 12345 and port 8080')).toEqual([]);
  });

  it('finds linkedin profile urls but not company pages or the synthetic handle', () => {
    expect(rules('see https://www.linkedin.com/in/some-person/')).toContain('linkedin_profile');
    expect(rules('see https://www.linkedin.com/company/acme/')).toEqual([]);
    expect(rules('see linkedin.com/in/example-person')).toEqual([]);
  });

  it("finds the owner's own terms case-insensitively", () => {
    expect(rules('Written by JANE Q Tester', ['jane q tester'])).toEqual(['local_term:0']);
  });

  it('reports file and line and never the matched text', () => {
    const hits = scanText('a/b.md', 'ok\nline two has bob@gmail.com in it', compileLocalTerms(['secretterm']));
    expect(hits).toEqual([{ file: 'a/b.md', line: 2, rule: 'email' }]);
    const text = JSON.stringify(scanText('x', 'secretterm here', compileLocalTerms(['secretterm'])));
    expect(text).not.toContain('secretterm');
  });

  it('ignores empty or whitespace-only local terms', () => {
    expect(compileLocalTerms(['', '   ', 'real'])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hygiene-pii-scan.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Write `piiScan.ts`**

```ts
// src/hygiene/piiScan.ts
export interface Hit {
  file: string;
  line: number;
  rule: string;
}

export interface Rule {
  id: string;
  re: RegExp;
}

export const ALLOWED_EMAIL_DOMAINS = [
  'example.com',
  'example.org',
  'example.net',
  'acme.com',
  'test.com',
  'users.noreply.github.com',
];

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const PHONE = /(?<![\w.])(?:\+\d{1,3}[ -]?)?(?:\(?\d{2,5}\)?[ -]?){1,3}\d{4,}(?![\w.])/g;
const LINKEDIN_PROFILE = /linkedin\.com\/in\/([A-Za-z0-9_%-]+)/gi;
const ALLOWED_PROFILE_HANDLES = ['example-person', 'jane-doe'];

const digitCount = (s: string): number => s.replace(/\D/g, '').length;

export function compileLocalTerms(terms: string[]): Rule[] {
  return terms
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t, i) => ({ id: `local_term:${i}`, re: new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }));
}

export function scanText(file: string, text: string, localTerms: Rule[] = []): Hit[] {
  const hits: Hit[] = [];
  text.split('\n').forEach((line, i) => {
    const n = i + 1;
    for (const m of line.matchAll(EMAIL)) {
      if (!ALLOWED_EMAIL_DOMAINS.includes(m[1].toLowerCase())) hits.push({ file, line: n, rule: 'email' });
    }
    for (const m of line.matchAll(PHONE)) {
      const digits = digitCount(m[0]);
      if (m[0].includes('+') ? digits >= 8 : digits >= 10) hits.push({ file, line: n, rule: 'phone' });
    }
    for (const m of line.matchAll(LINKEDIN_PROFILE)) {
      if (!ALLOWED_PROFILE_HANDLES.includes(m[1].toLowerCase())) hits.push({ file, line: n, rule: 'linkedin_profile' });
    }
    for (const rule of localTerms) {
      if (rule.re.test(line)) hits.push({ file, line: n, rule: rule.id });
    }
  });
  return hits;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/hygiene-pii-scan.test.ts`
Expected: PASS. If the phone test `version 12345 and port 8080` fails, tighten `PHONE` until only real phone shapes match (the test is the spec).

- [ ] **Step 5: Write the CLI**

```ts
// scripts/hygiene/pii-scan.ts
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { compileLocalTerms, scanText, type Hit } from '../../src/hygiene/piiScan.js';
import { userDataPath } from '../../src/lib/userData.js';

const staged = process.argv.includes('--staged');
const gitArgs = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACM', '-z'] : ['ls-files', '-z'];
const files = execFileSync('git', gitArgs, { encoding: 'utf8' }).split('\0').filter(Boolean);

const termsFile = userDataPath('pii-patterns.json');
const terms: string[] = existsSync(termsFile) ? (JSON.parse(readFileSync(termsFile, 'utf8')).terms ?? []) : [];
const localRules = compileLocalTerms(terms);

const SKIP = /\.(png|jpg|jpeg|gif|pdf|ico|woff2?|ttf|lock|sqlite)$/i;
const hits: Hit[] = [];
for (const file of files) {
  if (SKIP.test(file) || !existsSync(file)) continue;
  if (statSync(file).size > 1_000_000) continue;
  hits.push(...scanText(file, readFileSync(file, 'utf8'), localRules));
}

for (const h of hits) console.log(`${h.file}:${h.line}  ${h.rule}`);
console.log(
  `${hits.length} finding(s) in ${files.length} file(s)${terms.length ? '' : ' (no user-data/pii-patterns.json: owner terms not checked)'}`,
);
process.exit(hits.length > 0 ? 1 : 0);
```

In `package.json`, add to `scripts`:

```json
"scan:pii": "tsx scripts/hygiene/pii-scan.ts"
```

- [ ] **Step 6: Create the local terms file and run the scan (inventory)**

Create `user-data/pii-patterns.json` (gitignored through Task 4) with the owner's real terms:

```json
{ "terms": ["REAL FULL NAME", "real.email@realdomain.com", "REAL PHONE DIGITS", "real-linkedin-handle"] }
```

Run `JOBAPPLIER_USER_DATA=user-data npm run scan:pii`. Expected: many findings (the to-do list for Tasks 3 to 5). Save the output to the scratchpad, not the repository.

- [ ] **Step 7: Commit**

```bash
git add src/hygiene/piiScan.ts scripts/hygiene/pii-scan.ts package.json tests/hygiene-pii-scan.test.ts
git commit -m "feat(hygiene): PII scanner that never prints matched text"
```

---

### Task 3: Point every reader at `user-data/`

**Files:**
- Modify: `src/resume.ts` (line 21), `src/apply/linkedin.ts` (line 25), `src/resumeFacts.ts` (line 94), `src/languageGate.ts` (line 192)
- Test: `tests/userdata-readers.test.ts`; fix any existing test that depended on the owner's real data

**Interfaces:**
- Consumes: `userDataPath`, `missingUserDataMessage` from Task 1.

- [ ] **Step 1: Write the failing test**

```ts
// tests/userdata-readers.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getBaseResume } from '../src/resume.js';

function withUserData<T>(dir: string, fn: () => T): T {
  const before = process.env.JOBAPPLIER_USER_DATA;
  process.env.JOBAPPLIER_USER_DATA = dir;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.JOBAPPLIER_USER_DATA;
    else process.env.JOBAPPLIER_USER_DATA = before;
  }
}

describe('getBaseResume', () => {
  it('reads resume.json from the user-data directory at call time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ud-'));
    writeFileSync(join(dir, 'resume.json'), JSON.stringify({ basics: { name: 'Jane Doe' } }));
    expect(withUserData(dir, () => getBaseResume())).toEqual({ basics: { name: 'Jane Doe' } });
  });

  it('throws a helpful message when the file is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ud-'));
    expect(() => withUserData(dir, () => getBaseResume())).toThrow(/user-data\/resume\.json.*init/s);
  });
});

describe('no source file builds a legacy personal path by hand', () => {
  const sources = ['src/resume.ts', 'src/apply/linkedin.ts', 'src/resumeFacts.ts', 'src/languageGate.ts'];
  for (const file of sources) {
    it(`${file} uses userDataPath`, () => {
      const text = readFileSync(file, 'utf8');
      expect(text).toMatch(/userDataPath\(/);
      expect(text).not.toMatch(/'config',\s*'(easy-apply-answers|fact-gate|languages)\.json'/);
      expect(text).not.toMatch(/'input',\s*'resume\.json'/);
    });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/userdata-readers.test.ts`
Expected: FAIL (readers still use legacy paths).

- [ ] **Step 3: Repoint `getBaseResume` in `src/resume.ts`**

Add the import next to the others:

```ts
import { missingUserDataMessage, userDataPath } from './lib/userData.js';
```

Replace the body of `getBaseResume` (currently lines 21 to 24):

```ts
export function getBaseResume(): any {
  const resumePath = userDataPath('resume.json');
  if (!existsSync(resumePath)) throw new Error(missingUserDataMessage('resume.json'));
  return JSON.parse(readFileSync(resumePath, 'utf8'));
}
```

(`existsSync` is already imported on line 4.)

- [ ] **Step 4: Repoint the three config readers**

In `src/apply/linkedin.ts`, add `import { userDataPath } from '../lib/userData.js';` and replace line 25:

```ts
const ANSWERS_CONFIG_PATH = userDataPath('easy-apply-answers.json');
```

In `src/resumeFacts.ts`, add `import { userDataPath } from './lib/userData.js';` and replace the `defaultFactGatePath` definition (line 94) with:

```ts
const defaultFactGatePath = userDataPath('fact-gate.json');
```

In `src/languageGate.ts`, add `import { userDataPath } from './lib/userData.js';` and replace the `defaultPath` definition (line 192) with:

```ts
const defaultPath = userDataPath('languages.json');
```

If any of these files used `path` or `fileURLToPath` only for the removed expression, remove the now-unused import so the type check stays clean.

- [ ] **Step 5: (moved to Task 4)**

The `vitest.config.ts` change that points tests at the templates is made in Task 4, in the same commit as the templates, so every commit keeps the full suite green. Until then, readers use the owner's real `user-data/` files that Task 1 copied in. Run the full suite now (`npx tsc -p . --noEmit && npx vitest run`) to confirm the repointing broke nothing.

- [ ] **Step 6: Run the readers test**

Run: `npx vitest run tests/userdata-readers.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/resume.ts src/apply/linkedin.ts src/resumeFacts.ts src/languageGate.ts tests/userdata-readers.test.ts
git commit -m "refactor(hygiene): read personal files through the user-data module"
```

---

### Task 4: Templates, untracking and the personal-data tests

**Files:**
- Create: `user-data.example/resume.json`, `user-data.example/easy-apply-answers.json`, `user-data.example/fact-gate.json`, `user-data.example/languages.json`, `user-data.example/pii-patterns.json`, `user-data.example/README.md`
- Modify: `.gitignore`, `vitest.config.ts`, `scripts/eval/README.md`, `tests/gulfGates.test.ts`, `tests/proseClaims.test.ts`, `tests/evalLib.test.ts`
- Remove from git (copies already in `user-data/`): `input/resume.json`, `renderer/input/resume.json`, `config/easy-apply-answers.json`, `config/fact-gate.json`, `config/languages.json`, `scripts/eval/fixtures/base-resume.json`, `scripts/eval/fixtures/baseline/**`
- Test: `tests/hygiene-templates.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/hygiene-templates.test.ts
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { scanText } from '../src/hygiene/piiScan.js';
import { USER_FILES } from '../src/lib/userData.js';

const keysOf = (v: unknown, prefix = ''): string[] =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [prefix + k, ...keysOf(x, `${prefix}${k}.`)])
    : [];

describe('user-data templates', () => {
  it('has a template and a README for the folder', () => {
    expect(existsSync('user-data.example/README.md')).toBe(true);
    for (const f of USER_FILES) expect(existsSync(`user-data.example/${f}`), f).toBe(true);
  });

  for (const f of USER_FILES) {
    it(`user-data.example/${f} is valid JSON and contains no personal data`, () => {
      const text = readFileSync(`user-data.example/${f}`, 'utf8');
      expect(() => JSON.parse(text)).not.toThrow();
      expect(scanText(f, text)).toEqual([]);
    });

    it(`user-data.example/${f} has the same keys as the real file when the real file is present`, () => {
      const real = `user-data/${f}`;
      if (!existsSync(real)) return;
      const a = keysOf(JSON.parse(readFileSync(real, 'utf8'))).sort();
      const b = keysOf(JSON.parse(readFileSync(`user-data.example/${f}`, 'utf8'))).sort();
      expect(b).toEqual(a);
    });
  }

  it('.gitignore keeps every personal path out of git', () => {
    const lines = readFileSync('.gitignore', 'utf8').split('\n').map((l) => l.trim());
    for (const rule of [
      'user-data/',
      'renderer/input/resume.json',
      'scripts/eval/fixtures/base-resume.json',
      'scripts/eval/fixtures/baseline/',
    ]) {
      expect(lines).toContain(rule);
    }
  });
});
```

Note: the key-parity test compares against the real files in `user-data/`, whose `pii-patterns.json` may differ in shape; keep the template's shape (`{ "terms": [...] }`) identical to the file Task 2 step 6 created.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hygiene-templates.test.ts`
Expected: FAIL (templates and ignore rules missing).

- [ ] **Step 3: Create the synthetic templates**

For `resume.json`, `easy-apply-answers.json`, `fact-gate.json` and `languages.json`: copy the real file from `user-data/` into `user-data.example/` and replace every real value with the synthetic person. Keep every key and the structure exactly. Replacement values: name `Jane Doe`, email `jane@example.com`, phone `+00 0000000000`, LinkedIn `linkedin.com/in/example-person`, GitHub and website `https://example.com/...`, employers and schools `Example Corp` and `Example University`, bullets short generic sentences. `fact-gate.json`: keep the four keys (`allow_facts`, `allow_metrics`, `forbidden_phrases`, `warn_phrases`) with empty arrays. `languages.json`: `{ "confirmed": false, "declared": [{ "language": "English", "level": "fluent" }] }`. `pii-patterns.json`: `{ "terms": ["Your Full Name", "your.email@yourdomain.com", "+00 0000000000", "your-linkedin-handle"] }`.

Write `user-data.example/README.md` explaining: this folder holds templates; real files live in the untracked `user-data/` folder; `npm run user-data -- init` copies the templates into place; each file's purpose in one line (resume = the base resume the agent tailors and never edits; answers = screening-question answers; fact-gate = facts you confirm the checker may allow; languages = languages you speak; pii-patterns = your own name, email, phone and handles so the scanner can catch them); and "the setup skill (plan 7B) asks for your resume and a few questions and writes these for you".

Check each template with the scanner: `JOBAPPLIER_USER_DATA=user-data.example npm run scan:pii` must report no finding pointing at `user-data.example/`.

- [ ] **Step 4: Update `.gitignore` and point tests at the templates**

Append (`user-data/` was already added in Task 1):

```
renderer/input/resume.json
scripts/eval/fixtures/base-resume.json
scripts/eval/fixtures/baseline/
```

In `vitest.config.ts`, add to the existing `env` object (so tests read the templates, never the owner's files):

```ts
JOBAPPLIER_USER_DATA: 'user-data.example',
```

- [ ] **Step 5: Untrack the real files and remove the old copies**

First confirm each real file exists in `user-data/` (`ls user-data`). Then run:

```bash
git rm --cached input/resume.json renderer/input/resume.json config/easy-apply-answers.json config/fact-gate.json config/languages.json scripts/eval/fixtures/base-resume.json
git rm -r --cached scripts/eval/fixtures/baseline
rm input/resume.json config/easy-apply-answers.json config/fact-gate.json config/languages.json
```

(Keep `renderer/input/resume.json`, `scripts/eval/fixtures/base-resume.json` and `scripts/eval/fixtures/baseline/` on disk; they are now ignored, and local eval runs may use them.)

- [ ] **Step 6: Make the dependent tests independent of the owner's data**

- `tests/gulfGates.test.ts`: the block titled "the shipped config/languages.json today ..." asserts the owner's real language list. Replace its file-dependent assertions with an explicit in-test declared list (build the object in the test) so it no longer reads any user file.
- `tests/proseClaims.test.ts` (lines near 130) and `tests/evalLib.test.ts` (line near 47): wrap the blocks that read `scripts/eval/fixtures/base-resume.json` and `scripts/eval/fixtures/baseline/**` in `describe.skipIf(!existsSync(<fixture path>))` so they skip cleanly when a user has not generated local eval data.
- `scripts/eval/README.md`: replace the sentences describing the frozen baseline with: baselines and the base-resume fixture are local and ignored; generate them with `npm run eval:gen` using your own resume in `user-data/resume.json`.

Run the whole suite: `npx tsc -p . --noEmit && npx vitest run`. For any other failing test that depended on the owner's real data, rewrite it to use explicit in-test data or the template; never re-add a real file.

- [ ] **Step 7: Run the templates test and the suite**

Run: `npx vitest run tests/hygiene-templates.test.ts && npx vitest run`
Expected: PASS (skipped eval blocks are reported as skipped).

- [ ] **Step 8: Commit**

```bash
git add user-data.example .gitignore vitest.config.ts scripts/eval/README.md tests
git commit -m "chore(hygiene): move personal files to user-data, add synthetic templates"
```

---

### Task 5: Scrub docs and CLAUDE.md

**Files:**
- Modify: every tracked file the scanner still reports, plus every doc that names a moved path

- [ ] **Step 1: List what remains**

Run: `JOBAPPLIER_USER_DATA=user-data npm run scan:pii`
Expected: findings only in docs, `CLAUDE.md`, `README.md`, `ResumeGuide.md`, comments or tests. Findings in `scripts/eval/fixtures` or `user-data.example` mean an earlier task missed something.

- [ ] **Step 2: Replace each finding**

For each reported `file:line`: replace real people's LinkedIn handles with `example-person` (or `jane-doe`); the owner's name, email and phone with `Jane Doe`, `jane@example.com`, `+00 0000000000`; and company or recruiter names that identify a real third party with generic placeholders. Keep the meaning of each sentence. Preference text in `CLAUDE.md` (role, location, salary targets) is configuration, not identity; leave it (it moves to the per-user profile in plan 7B).

- [ ] **Step 3: Update moved-path references**

Run: `git grep -nI -e "input/resume.json" -e "config/easy-apply-answers.json" -e "config/fact-gate.json" -e "config/languages.json" -- . ':!docs/superpowers/plans' ':!docs/superpowers/specs'`
Update each hit in `CLAUDE.md`, `.claude/agents/*.md`, `.claude/skills/**`, `README.md`, `ResumeGuide.md` and source comments to the new `user-data/...` path.

- [ ] **Step 4: Confirm clean**

Run: `JOBAPPLIER_USER_DATA=user-data npm run scan:pii && npx vitest run`
Expected: `0 finding(s)`; tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(hygiene): remove personal and third-party identifiers, update moved paths"
```

---

### Task 6: Pre-commit guard

**Files:**
- Create: `.githooks/pre-commit`
- Modify: `README.md`
- Test: `tests/hygiene-hook.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/hygiene-hook.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';

describe('pre-commit hook', () => {
  const hook = readFileSync('.githooks/pre-commit', 'utf8');

  it('runs the staged PII scan and stops on failure', () => {
    expect(hook).toMatch(/set -euo pipefail/);
    expect(hook).toMatch(/scripts\/hygiene\/pii-scan\.ts --staged/);
  });

  it('refuses staged secret, database, local-settings and user-data files by name', () => {
    expect(hook).toMatch(/\\\.env/);
    expect(hook).toMatch(/secrets\//);
    expect(hook).toMatch(/\.sqlite/);
    expect(hook).toMatch(/user-data\//);
    expect(hook).toMatch(/settings\\\.local\\\.json/);
  });

  it('allows the committed templates and .env.example', () => {
    expect(hook).toMatch(/user-data\.example/);
    expect(hook).toMatch(/\.env\\\.example/);
  });

  it('is executable', () => {
    expect(statSync('.githooks/pre-commit').mode & 0o111).not.toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/hygiene-hook.test.ts`
Expected: FAIL (file not found).

- [ ] **Step 3: Write the hook**

```bash
#!/usr/bin/env bash
# Blocks commits that contain personal data, secrets or local-only files.
set -euo pipefail

BLOCKED='(^|/)\.env($|\.)|^secrets/|\.sqlite$|^user-data/|settings\.local\.json$'
ALLOWED='\.env\.example$|^user-data\.example/'
if git diff --cached --name-only --diff-filter=ACM | grep -E "$BLOCKED" | grep -vE "$ALLOWED"; then
  echo "Refusing to commit the files listed above (secrets, databases, user data or local settings)." >&2
  exit 1
fi

npx tsx scripts/hygiene/pii-scan.ts --staged
```

- [ ] **Step 4: Activate the hook path and run the test**

Run: `chmod +x .githooks/pre-commit && git config core.hooksPath .githooks && npx vitest run tests/hygiene-hook.test.ts`
Expected: PASS. Then prove it blocks: on a scratch branch, stage a file containing a real-looking email and confirm the commit is refused; stage `user-data/resume.json` with `git add -f` and confirm it is refused; delete the scratch branch.

- [ ] **Step 5: Add the setup note**

In `README.md`, under development setup, add: `git config core.hooksPath .githooks` and `npm run user-data -- init` (the setup wizard will run both later).

- [ ] **Step 6: Commit**

```bash
git add .githooks/pre-commit tests/hygiene-hook.test.ts README.md
git commit -m "chore(hygiene): pre-commit hook blocking PII, secrets and local files"
```

---

### Task 7: History reset (owner-gated, destructive)

**Files:** none; this rewrites repository history. Every step marked CONFIRM needs the owner's explicit "yes" in the conversation first.

- [ ] **Step 1: Preconditions (non-destructive)**

Run: `JOBAPPLIER_USER_DATA=user-data npm run scan:pii` (must show `0 finding(s)`), `npx vitest run` (all pass), `git status --short` (clean). Check whether the remote is public or private (`gh repo view --json visibility`, or GitHub settings) and tell the owner. If it was ever public, scan the old history for credentials (`gitleaks detect` if installed) and tell the owner to rotate anything found regardless of the reset.

- [ ] **Step 2: Back up the old history (non-destructive)**

Run:

```bash
mkdir -p "$HOME/Backups"
git bundle create "$HOME/Backups/jobber-pre-reset.bundle" --all
git bundle verify "$HOME/Backups/jobber-pre-reset.bundle"
```

Confirm the bundle verifies and sits outside the repository. Confirm `user-data/`, `secrets/`, `.env` and `data.sqlite` are untouched on disk (they are not part of history).

- [ ] **Step 3: Create the single clean commit locally (CONFIRM before running)**

Run:

```bash
git checkout --orphan clean-main
git add -A
git commit -m "Initial commit"
```

Verify: `git log --oneline` shows one commit; `JOBAPPLIER_USER_DATA=user-data npm run scan:pii` still shows `0 finding(s)`; `git ls-files | grep -E '^(user-data/|secrets/|\.env$)'` prints nothing.

- [ ] **Step 4: Replace main locally (CONFIRM before running)**

Run:

```bash
git branch -M clean-main main
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

Verify: `git log --oneline` shows one commit; `git tag` and `git stash list` are empty (delete old tags and stashes the owner agrees to drop); `git fsck` reports no problems; `git count-objects -v` shows a small size.

- [ ] **Step 5: Update the remote (CONFIRM, and the owner chooses one)**

Option A (strongest): delete the GitHub repository and create a new one with the same name, then push the single commit. This removes old objects, pull-request refs and cached views on GitHub's side (existing forks and clones elsewhere keep the old history).

Option B: after listing and deleting every other remote branch and tag (`git push origin --delete <name>`) and checking for open pull requests (their refs keep old commits reachable on GitHub), run `git push --force origin main`. Weaker than Option A.

Never run either without the owner saying which option and "go".

- [ ] **Step 6: Re-enable the guard rails and record the result**

Run `git config core.hooksPath .githooks` again if the clone was recreated. Add a short note to `docs/superpowers/specs/2026-10-14-platform-sessions-dashboard-setup-requirements.md` under "Repository hygiene and history reset" stating the date the history was reset and that old clones may still hold the previous history. Commit it.

```bash
git add docs/superpowers/specs/2026-10-14-platform-sessions-dashboard-setup-requirements.md
git commit -m "docs: record history reset and remaining exposure"
```

---

## Self-review

- **Spec coverage:** one untracked folder for all personal files with committed templates and a README (T1, T4); every reader repointed through one module (T3); Claude-assisted filling prepared by templates plus the init command, with the conversational skill specified for plan 7B (T1, T4 and Decisions); personal data and third-party identifiers scrubbed (T5); scanner and pre-commit guard so it cannot come back (T2, T6); history reset to one clean commit with backup and owner gates (T7).
- **Placeholder scan:** none; T4 step 3 and T5 step 2 describe replacements to make in files whose real contents must not be copied into this plan.
- **Type consistency:** `UserFile`, `userDataPath`, `userDataDir`, `planMigration`, `planInit` are defined in T1 and used unchanged in T2 to T4; `Hit`, `Rule`, `compileLocalTerms`, `scanText` are defined in T2 and reused in T4.
- **Review Focus coverage:** 1 and 2 in T3; 3 in T1; 4 and 5 in T2; 6 and 7 in T4; 8 in T7.
