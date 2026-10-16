import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.js';
import { recordRun, boardStatusReply, sourceStatusReply } from '../src/sources/status.js';
import { buildSourceRows, renderSources, sourcesNotice, SOURCE_COLUMNS } from '../src/status/sources.js';

const SINCE = '1970-01-01T00:00:00.000Z';

function fixture() {
  const db = openDb(':memory:');
  recordRun(db, 'greenhouse', { fetched: 10, kept: 4, new: 2 });
  recordRun(db, 'naukri', { fetched: 5, kept: 5, new: 1, error: 'boom timeout', fallback_used: true });
  db.prepare("INSERT INTO generated_providers (id, state, created_at, updated_at) VALUES ('acme','candidate','t','t')").run();
  return db;
}

describe('source status table', () => {
  it('renders the exact columns, a script row, a fallback row with error and ran:no rows', () => {
    const out = renderSources(buildSourceRows(fixture(), SINCE));
    const lines = out.split('\n');
    expect(lines[0]).toBe('source id | kind (script|agent) | fetched | kept | new | errors | fallback used');
    expect(SOURCE_COLUMNS).toHaveLength(7);
    expect(lines).toContain('greenhouse | script | 10 | 4 | 2 | 0 | no');
    expect(lines.find((l) => l.startsWith('naukri | '))).toMatch(/^naukri \| \w+ \| 5 \| 5 \| 1 \| 1 \| yes$/);
    expect(lines).toContain('gen:acme | script | ran:no | - | - | - | -');
    expect(lines).toContain('error naukri: boom timeout');
  });

  it('prints the window header when given', () => {
    expect(renderSources(buildSourceRows(fixture(), SINCE), 'ran in last 24h').split('\n')[0]).toBe('ran in last 24h');
  });

  it('is stable across calls', () => {
    const db = fixture();
    expect(renderSources(buildSourceRows(db, SINCE))).toBe(renderSources(buildSourceRows(db, SINCE)));
  });

  it('a row last run before the window is ran:no and its old numbers are hidden', () => {
    const db = fixture();
    db.prepare("UPDATE platform_status SET last_run_at = '2020-01-01T00:00:00.000Z' WHERE id = 'greenhouse'").run();
    const lines = renderSources(buildSourceRows(db, '2025-01-01T00:00:00.000Z')).split('\n');
    expect(lines).toContain('greenhouse | script | ran:no | - | - | - | -');
    expect(lines.some((l) => l.startsWith('greenhouse | script | 10'))).toBe(false);
    const n = sourcesNotice(db, { sinceIso: '2025-01-01T00:00:00.000Z' })!;
    expect(n.title).toBe('sources: 1 ran, fetched 5, new 1, errors 1, fallback 1');
    expect(n.detail).not.toContain('greenhouse');
  });

  it('works on an empty database', () => {
    expect(buildSourceRows(openDb(':memory:'), SINCE).every((r) => !r.ran)).toBe(true);
    expect(sourcesNotice(openDb(':memory:'), { sinceIso: SINCE })).toBeNull();
  });

  it('wake notice carries the same numbers as the table and the code pass note', () => {
    const db = fixture();
    const n = sourcesNotice(db, { runId: 'run-1', sinceIso: SINCE, note: 'pass exploded' })!;
    expect(n.level).toBe('warn');
    expect(n.runId).toBe('run-1');
    expect(n.title).toBe('sources: 2 ran, fetched 15, new 3, errors 1, fallback 1');
    expect(n.detail).toContain('code pass: pass exploded');
    expect(n.detail).toContain('greenhouse | script | 10 | 4 | 2 | 0 | no');
  });

  it('a note alone still produces a notice, and a long table is summarized under the notifier cap', () => {
    expect(sourcesNotice(openDb(':memory:'), { sinceIso: SINCE, note: 'x' })!.detail).toBe('code pass: x');
    const db = openDb(':memory:');
    for (let i = 0; i < 60; i++) recordRun(db, `src-${String(i).padStart(2, '0')}`, { fetched: 1, kept: 1, new: 1 });
    const n = sourcesNotice(db, { sinceIso: SINCE })!;
    expect(n.detail!.length).toBeLessThanOrEqual(1000);
    expect(n.detail).toMatch(/\+\d+ more rows/);
    expect(n.title).toContain('60 ran');
  });

  it('tool replies: source_status and the board_status alias answer', () => {
    const src = JSON.parse(sourceStatusReply(fixture()).content[0].text);
    expect(src.ran).toBe(true);
    expect(src.rows.map((r: { source: string }) => r.source)).toContain('greenhouse');
    expect(JSON.parse(boardStatusReply({ ran: false }).content[0].text)).toEqual({ ran: false, deprecated: 'use source_status' });
  });

  it('/sources command file and status script wiring', () => {
    const cmd = readFileSync('.claude/commands/sources.md', 'utf8');
    expect(cmd).toMatch(/^allowed-tools:\s*Bash\(npx tsx scripts\/status\.ts sources:\*\)$/m);
    expect(cmd).toContain('`npx tsx scripts/status.ts sources`');
    const script = readFileSync('scripts/status.ts', 'utf8');
    expect(script).toContain("'sources'");
    expect(script).toContain('ran in last');
  });
});
