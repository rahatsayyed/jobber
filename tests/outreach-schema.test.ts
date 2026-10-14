// tests/outreach-schema.test.ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { migrateOutreachTables } from '../src/outreach/schema.js';

type Db = ReturnType<typeof openDb>;
const tables = (db: Db): string[] =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);

const insertPerson = (db: Db, key: string) =>
  db
    .prepare(
      "INSERT INTO people (platform, profile_key, name, company, company_key, category) VALUES ('linkedin', ?, 'Test Person', 'Acme', 'acme', 'peer')",
    )
    .run(key);

describe('outreach schema', () => {
  it('creates the outreach tables when the db opens', () => {
    const db = openDb(':memory:');
    for (const t of ['people', 'contact_state', 'touches', 'rate_events', 'halt_flags']) {
      expect(tables(db)).toContain(t);
    }
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    migrateOutreachTables(db);
    migrateOutreachTables(db);
    expect(tables(db)).toContain('people');
  });

  it('rejects a duplicate person on the same platform', () => {
    const db = openDb(':memory:');
    insertPerson(db, 'linkedin.com/in/a');
    expect(() => insertPerson(db, 'linkedin.com/in/a')).toThrow();
  });

  it('rejects a duplicate touch idempotency key', () => {
    const db = openDb(':memory:');
    const id = Number(insertPerson(db, 'linkedin.com/in/b').lastInsertRowid);
    const ins = () =>
      db.prepare("INSERT INTO touches (person_id, kind, idempotency_key) VALUES (?, 'connect', 'k1')").run(id);
    ins();
    expect(ins).toThrow();
  });
});
