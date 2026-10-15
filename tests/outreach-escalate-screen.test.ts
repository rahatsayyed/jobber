import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { handleEscalate } from '../src/mcp/outreach.js';
import type { ScreenVerdict } from '../src/safety/screen.js';

const NOW = new Date('2026-10-15T10:00:00Z');
const v = (over: Partial<ScreenVerdict>): ScreenVerdict => ({ blocked: false, unscreened: false, text: '', flags: [], code: 'ok', ...over });
const row = (db: ReturnType<typeof openDb>, id: number) =>
  db.prepare('SELECT reason, detail FROM escalations WHERE id = ?').get(id) as { reason: string; detail: string | null };

describe('escalate screening (policy D3)', () => {
  it('blocked: stores [blocked: code] for both fields and still creates the escalation', async () => {
    const db = openDb(':memory:');
    const calls: string[] = [];
    const r = await handleEscalate(
      {
        db,
        now: () => NOW,
        screen: async (raw, p) => {
          calls.push(`${p}:${raw}`);
          return v({ blocked: true, code: 'injection_suspected' });
        },
      },
      { platform: 'linkedin', reason: 'odd', detail: 'evil text' },
    );
    expect(row(db, r.id)).toEqual({ reason: '[blocked: injection_suspected]', detail: '[blocked: injection_suspected]' });
    expect(calls).toEqual(['escalate:odd\nevil text']);
  });
  it('blocked without a detail still fills both fields', async () => {
    const db = openDb(':memory:');
    const r = await handleEscalate(
      { db, now: () => NOW, screen: async () => v({ blocked: true, code: 'classifier_truncated' }) },
      { platform: 'naukri', reason: 'x' },
    );
    expect(row(db, r.id)).toEqual({ reason: '[blocked: classifier_truncated]', detail: '[blocked: classifier_truncated]' });
  });
  it('unscreened: prefixes the reason, keeps the detail', async () => {
    const db = openDb(':memory:');
    const r = await handleEscalate(
      { db, now: () => NOW, screen: async () => v({ unscreened: true }) },
      { platform: 'linkedin', reason: 'needs human', detail: 'salary?' },
    );
    expect(row(db, r.id)).toEqual({ reason: '[unscreened] needs human', detail: 'salary?' });
  });
  it('clean: stored unchanged', async () => {
    const db = openDb(':memory:');
    const r = await handleEscalate(
      { db, now: () => NOW, screen: async () => v({}) },
      { platform: 'linkedin', reason: 'needs human', detail: 'salary?' },
    );
    expect(row(db, r.id)).toEqual({ reason: 'needs human', detail: 'salary?' });
  });
});
