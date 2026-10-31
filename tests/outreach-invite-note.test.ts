import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { upsertPerson } from '../src/outreach/people.js';
import { TUNING_DEFAULTS } from '../src/outreach/tuning.js';
import { listDueTouches } from '../src/outreach/service.js';
import { handleListDueTouches } from '../src/mcp/outreach.js';
import { loadLinkedinPlan } from '../src/accountPlan.js';

const NOW = new Date('2026-10-15T08:00:00.000Z');
const day = 24 * 3600 * 1000;
type D = ReturnType<typeof openDb>;

function due(db: D, slug: string): number {
  const id = upsertPerson(db, { platform: 'linkedin', profileKey: `linkedin.com/in/${slug}`, name: slug, company: `Co ${slug}`, category: 'recruiter' });
  db.prepare("UPDATE contact_state SET stage = 'active', cycle_started_at = ? WHERE person_id = ?").run(new Date(NOW.getTime() - 30 * day).toISOString(), id);
  db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status, sent_at) VALUES (?, 'connect', ?, 'sent', ?)").run(id, `k-${slug}`, new Date(NOW.getTime() - 10 * day).toISOString());
  return id;
}
const conn = (db: D, url: string, note: string | null, status = 'connected') =>
  db.prepare('INSERT INTO connections (profile_url, note, status) VALUES (?, ?, ?)').run(url, note, status);
const flagOf = (db: D, slug: string) => listDueTouches(db, NOW, TUNING_DEFAULTS, { limit: 20 }).find((t) => t.profile_url?.endsWith(`/in/${slug}`))?.invite_had_note;

describe('invite_had_note on due touches', () => {
  it('is true for a noted invite, false for a plain one, across URL variants', () => {
    const db = openDb(':memory:');
    due(db, 'noted');
    due(db, 'plain');
    due(db, 'nullnote');
    conn(db, 'https://www.linkedin.com/in/Noted/?miniProfileUrn=abc', 'Hi, I saw the React role');
    conn(db, 'https://linkedin.com/in/plain', '');
    conn(db, 'https://www.linkedin.com/in/nullnote/', null);
    expect(flagOf(db, 'noted')).toBe(true);
    expect(flagOf(db, 'plain')).toBe(false);
    expect(flagOf(db, 'nullnote')).toBe(false);
  });
  it('a messaged row (the DM text) does not make a plain invite noted; the newest invite row wins', () => {
    const db = openDb(':memory:');
    due(db, 'a');
    due(db, 'b');
    conn(db, 'https://www.linkedin.com/in/a', '', 'sent');
    conn(db, 'https://www.linkedin.com/in/a', 'a dm text', 'messaged');
    conn(db, 'https://www.linkedin.com/in/b', 'old note', 'sent');
    conn(db, 'https://www.linkedin.com/in/b', '', 'connected');
    expect(flagOf(db, 'a')).toBe(false);
    expect(flagOf(db, 'b')).toBe(false);
  });
  it('defaults to false when there is no connections row (acceptance via a message touch)', () => {
    const db = openDb(':memory:');
    const id = due(db, 'c');
    db.prepare("INSERT INTO touches (person_id, kind, idempotency_key, status, sent_at) VALUES (?, 'role_ask', 'r1', 'sent', ?)").run(id, new Date(NOW.getTime() - 8 * day).toISOString());
    expect(listDueTouches(db, NOW, TUNING_DEFAULTS, { limit: 20 })[0].invite_had_note).toBe(false);
  });
});

describe('list_due_touches payload', () => {
  it('has a top-level linkedin_plan and the touches with invite_had_note', () => {
    const db = openDb(':memory:');
    due(db, 'x');
    conn(db, 'https://www.linkedin.com/in/x', 'note');
    const r = handleListDueTouches({ db, now: () => NOW }, { limit: 5 });
    expect(['free', 'premium', 'unknown']).toContain(r.linkedin_plan);
    expect(r.touches).toHaveLength(1);
    expect(r.touches[0]).toMatchObject({ kind: 'role_ask', invite_had_note: true });
  });
});

describe('loadLinkedinPlan', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'acct-'));
  const write = (name: string, text: string) => { const f = path.join(dir, name); writeFileSync(f, text); return f; };
  it('missing file is unknown', () => expect(loadLinkedinPlan(path.join(dir, 'nope.json'))).toBe('unknown'));
  it('invalid JSON or value is unknown', () => {
    expect(loadLinkedinPlan(write('bad.json', '{oops'))).toBe('unknown');
    expect(loadLinkedinPlan(write('v.json', '{"linkedin_plan":"gold"}'))).toBe('unknown');
    expect(loadLinkedinPlan(write('n.json', 'null'))).toBe('unknown');
    expect(loadLinkedinPlan(write('t.json', '{"linkedin_plan":5}'))).toBe('unknown');
  });
  it('valid values pass', () => {
    expect(loadLinkedinPlan(write('f.json', '{"linkedin_plan":"free"}'))).toBe('free');
    expect(loadLinkedinPlan(write('p.json', '{"linkedin_plan":" Premium "}'))).toBe('premium');
    expect(loadLinkedinPlan(write('u.json', '{"linkedin_plan":"unknown"}'))).toBe('unknown');
  });
});
