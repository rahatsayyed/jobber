// Owner canary stopgap: seed one LinkedIn person into `people` (until 6D's contact finder does it).
// Usage: linkedin-seed-person.ts --url <profile_url> --name <name> --company <company> --category recruiter|hiring_manager|peer|connection
import { fileURLToPath } from 'node:url';
import type BetterSqlite3 from 'better-sqlite3';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { isBlockedPath, isLinkedInUrl, isProfileUrl, profileKeyOf } from '../src/linkedin/urls.js';
import type { Category } from '../src/outreach/cadence.js';
import { upsertPerson } from '../src/outreach/people.js';

const CATEGORIES: readonly Category[] = ['recruiter', 'hiring_manager', 'peer', 'connection'];

export interface SeedArgs {
  url: string;
  name: string;
  company: string;
  category: string;
  /** Optional profile headline; a headline naming the company is what lets the send gate pass. */
  headline?: string;
  /** Owner vouches that the person works at the company (stores employer_match = 1). */
  employerVerified?: boolean;
}

export type SeedResult = { ok: true; person_id: number } | { ok: false; error: string };

export function seedPerson(db: BetterSqlite3.Database, args: SeedArgs): SeedResult {
  const url = String(args.url ?? '').trim();
  const name = String(args.name ?? '').trim();
  const company = String(args.company ?? '').trim();
  const category = String(args.category ?? '').trim();
  if (!isLinkedInUrl(url) || !isProfileUrl(url)) return { ok: false, error: 'url is not a LinkedIn profile url' };
  if (isBlockedPath(url).blocked) return { ok: false, error: 'url path is blocked' };
  if (!name) return { ok: false, error: 'name is required' };
  if (!company) return { ok: false, error: 'company is required' };
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    return { ok: false, error: `category must be one of ${CATEGORIES.join('|')}` };
  }
  const person_id = upsertPerson(db, {
    platform: 'linkedin',
    profileKey: profileKeyOf(url),
    name,
    company,
    headline: args.headline?.trim() || undefined,
    category: category as Category,
    // The owner vouches for the employer when seeding by hand (finding 20).
    employerMatch: args.employerVerified ? 1 : undefined,
  });
  return { ok: true, person_id };
}

function parseArgv(argv: string[]): SeedArgs {
  const get = (flag: string): string => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : '';
  };
  return {
    url: get('--url'), name: get('--name'), company: get('--company'), category: get('--category'),
    headline: get('--headline'), employerVerified: argv.includes('--employer-verified'),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const db = openDb(dbPath());
  const r = seedPerson(db, parseArgv(process.argv.slice(2)));
  if (!r.ok) {
    console.error(r.error);
    process.exit(1);
  }
  console.log(String(r.person_id));
}
