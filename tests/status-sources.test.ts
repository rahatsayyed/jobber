import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { recordRun, boardStatusAlias } from '../src/sources/status.js';
import { buildSourceRows, renderSources, sourcesNotice, SOURCE_COLUMNS } from '../src/status/sources.js';

function fixture() {
  const db = openDb(':memory:');
  recordRun(db, 'greenhouse', { fetched: 10, kept: 4, new: 2 });
  recordRun(db, 'naukri', { fetched: 5, kept: 5, new: 1, error: 'boom timeout', fallback_used: true });
  db.prepare("INSERT INTO generated_providers (id, state, created_at, updated_at) VALUES ('acme','candidate','t','t')").run();
  return db;
}

describe('source status table', () => {
  it('renders the exact columns, a script row, a fallback row with error and ran:no rows', () => {
    const out = renderSources(buildSourceRows(fixture()));
    const lines = out.split('\n');
    expect(lines[0]).toBe('source id | kind (script|agent) | fetched | kept | new | errors | fallback used');
    expect(SOURCE_COLUMNS).toHaveLength(7);
    expect(lines).toContain('greenhouse | script | 10 | 4 | 2 | 0 | no');
    expect(lines.find((l) => l.startsWith('naukri | '))).toMatch(/^naukri \| \w+ \| 5 \| 5 \| 1 \| 1 \| yes$/);
    expect(lines).toContain('gen:acme | script | ran:no | - | - | - | -');
    const err = lines.find((l) => l.startsWith('error naukri: '))!;
    expect(err).toContain('boom');
    expect(err).toBe('error naukri: boom timeout');
    expect(lines.some((l) => l.includes('| ran:no'))).toBe(true);
  });

  it('is stable across calls', () => {
    const db = fixture();
    expect(renderSources(buildSourceRows(db))).toBe(renderSources(buildSourceRows(db)));
  });

  it('works on an empty database', () => {
    const rows = buildSourceRows(openDb(':memory:'));
    expect(rows.every((r) => !r.ran)).toBe(true);
    expect(sourcesNotice(openDb(':memory:'))).toBeNull();
  });

  it('wake notice carries the same numbers as the table', () => {
    const db = fixture();
    const n = sourcesNotice(db, 'run-1')!;
    expect(n.level).toBe('warn');
    expect(n.runId).toBe('run-1');
    expect(n.title).toBe('sources: 2 ran, fetched 15, new 3, errors 1, fallback 1');
    expect(n.detail).toBe(renderSources(buildSourceRows(db)));
  });

  it('the old board_status alias still answers', () => {
    expect(boardStatusAlias({ ran: false })).toEqual({ ran: false, deprecated: 'use source_status' });
  });

  it('/sources command file and status script wiring', () => {
    const cmd = readFileSync('.claude/commands/sources.md', 'utf8');
    expect(cmd).toMatch(/^allowed-tools:\s*Bash\(npx tsx scripts\/status\.ts sources:\*\)$/m);
    expect(cmd).toContain('`npx tsx scripts/status.ts sources`');
    expect(readFileSync('scripts/status.ts', 'utf8')).toContain("'sources'");
    expect(readFileSync('src/scheduler/driver.ts', 'utf8')).toContain('sourcesNotice');
  });
});
