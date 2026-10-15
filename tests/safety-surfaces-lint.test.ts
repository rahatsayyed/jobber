import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SCREENED_SURFACES, PENDING_SURFACE_FILES, SCREEN_CALL_PATTERN } from '../src/safety/screen.js';

const ROOT = process.cwd();

// Surface files that do not exist yet. Task 8 creates src/linkedin/findProfiles.ts and empties
// PENDING_SURFACE_FILES in src/safety/screen.ts (this list follows it).
const PENDING_FILES: ReadonlyArray<string> = PENDING_SURFACE_FILES;

// Files that may call the synchronous gateInput( / gateField( directly. A new caller must be added
// here on purpose, after deciding why it does not need screenUntrusted.
const SYNC_ONLY = new Set([
  'src/linkedin/state.ts',
  'src/safety/fieldGate.ts',
  'src/naukri/parse.ts',
  'src/naukri/inbound.ts',
  'src/outreach/service.ts',
  'src/mcp/naukri.ts',
  'src/safety/screen.ts',
  'src/safety/inputGate.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('screened surfaces lint', () => {
  it('every surface file exists (except the pending one) and calls the screen', () => {
    for (const s of SCREENED_SURFACES) {
      const p = join(ROOT, s.file);
      if (PENDING_FILES.includes(s.file)) {
        // Pending: may be absent; once it exists it must screen.
        expect(existsSync(p) ? SCREEN_CALL_PATTERN.test(readFileSync(p, 'utf8')) : true, s.id).toBe(true);
        continue;
      }
      expect(existsSync(p), `${s.id}: ${s.file} missing`).toBe(true);
      expect(SCREEN_CALL_PATTERN.test(readFileSync(p, 'utf8')), `${s.id}: ${s.file} does not screen`).toBe(true);
    }
  });
  it('only allowlisted files call gateInput( or gateField( from the input gate', () => {
    const offenders: string[] = [];
    for (const f of walk(join(ROOT, 'src'))) {
      const rel = relative(ROOT, f).split('\\').join('/');
      const text = readFileSync(f, 'utf8');
      if (!/inputGate\.js/.test(text)) continue;
      if (!/\bgateInput\(|\bgateField\(/.test(text)) continue;
      if (!SYNC_ONLY.has(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
