// Plan 8G-2 task 23: the scripted Easy Apply, the hard-coded ATS scripts and the claude --print bootstrap are gone.
// Hermetic: reads repository sources only.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');

const DELETED = [
  'src/mcp/apply.ts',
  'src/mcp/applyAutoRouter.ts',
  'src/apply/linkedin.ts',
  'src/apply/external.ts',
  'src/ats',
  'src/lib/atsBootstrap.ts',
  'src/lib/domSnapshot.ts',
  'src/lib/domFallback.ts',
  '.claude/commands/ats-bootstrap-fieldmap.md',
  '.claude/commands/easy-apply-control-fallback.md',
  '.claude/commands/easy-apply-answer-fallback.md',
  'config/learned-ats-platforms.json',
];

// Built from parts so this file never contains the literal it searches for.
const OLD_PREFIX = ['mcp', 'apply', ''].join('__');

/**
 * Ruling R4: .claude/agents/discoverer.md and sender.md (and the discover MCP) are removed by the 8G-1 branch
 * (task 14), not here. sender.md still lists the old apply tools until that branch lands, so only it is allowed.
 * discoverer.md is listed too in case the old names appear there. The two lint tests assert the ABSENCE of the prefix.
 */
const OLD_PREFIX_ALLOWED = new Set([
  '.claude/agents/discoverer.md',
  '.claude/agents/sender.md',
  'tests/agents-lint.test.ts',
  'tests/apply-operator-lint.test.ts',
  'tests/legacy-apply-removed.test.ts',
]);

function gitGrepFiles(pattern: string, paths: string[]): string[] {
  try {
    return execFileSync('git', ['grep', '-lE', pattern, '--', ...paths], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean);
  } catch (e) {
    if ((e as { status?: number }).status === 1) return [];
    throw e;
  }
}

describe('legacy scripted apply is removed', () => {
  it.each(DELETED)('%s is absent', (p) => {
    expect(existsSync(join(ROOT, p))).toBe(false);
  });

  it('the old apply tool prefix appears only in the allowed files', () => {
    const hits = gitGrepFiles(OLD_PREFIX, ['config', '.claude', 'src', 'scripts', 'tests', '.mcp.json', 'package.json', '.env.example'])
      .filter((f) => !OLD_PREFIX_ALLOWED.has(f));
    expect(hits).toEqual([]);
  });

  it('.mcp.json has no apply server and package.json no mcp:apply script', () => {
    const mcp = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcp.mcpServers)).not.toContain('apply');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(Object.keys(pkg.scripts)).not.toContain('mcp:apply');
  });

  it('the hybrid fallback env keys are gone', () => {
    const files = gitGrepFiles('(EASY_APPLY|EXTERNAL_APPLY)_HYBRID_FALLBACK', ['src', 'scripts', 'config', '.claude', '.env.example', 'tests'])
      .filter((f) => f !== 'tests/legacy-apply-removed.test.ts');
    expect(files).toEqual([]);
  });

  it('no module imports a deleted file', () => {
    const files = gitGrepFiles(
      "applyEasyApply|applyExternal|bootstrapFieldMap|detectAts|learned-ats-platforms|atsBootstrap|domSnapshot|domFallback|applyAutoRouter|from '[./]+/(apply/(linkedin|external)|ats/)",
      ['src', 'scripts', 'config', '.claude', 'tests', '.env.example'],
    ).filter((f) => !['tests/legacy-apply-removed.test.ts', 'scripts/migrate-learned-ats.ts', 'tests/applier-recipes.test.ts'].includes(f));
    expect(files).toEqual([]);
  });

  it('nothing launches a browser through chromium.launch or a stock playwright value import in src/apply', () => {
    // The apply entries are gone from the launch allowlist (the remaining entries belong to the 8G-1 branch).
    const lint = readFileSync(join(ROOT, 'tests/browser-launch-lint.test.ts'), 'utf8');
    const listBlock = /LEGACY_LAUNCH_ALLOWLIST: string\[\] = \[([\s\S]*?)\];/.exec(lint)?.[1] ?? '';
    expect(listBlock).not.toContain('src/apply/');
    expect(existsSync(join(ROOT, 'src/apply'))).toBe(true); // answers.ts and registry.ts stay
    const direct = gitGrepFiles("chromium[.]launch|from 'playwright'", ['src/apply', 'src/applier', 'src/mcp/applier.ts', 'src/webcore']);
    expect(direct).toEqual([]);
  });
});
