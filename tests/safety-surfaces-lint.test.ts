import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SCREENED_SURFACES, callsScreen } from '../src/safety/screen.js';

const ROOT = process.cwd();

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

const SURFACE_FILES = new Set(SCREENED_SURFACES.map((s) => s.file));

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('screened surfaces lint', () => {
  it('every surface file exists and calls the screen', () => {
    for (const s of SCREENED_SURFACES) {
      const p = join(ROOT, s.file);
      expect(existsSync(p), `${s.id}: ${s.file} missing`).toBe(true);
      expect(callsScreen(readFileSync(p, 'utf8')), `${s.id}: ${s.file} does not screen`).toBe(true);
    }
  });
  it('callsScreen needs a real call, not a comment, import or unused identifier', () => {
    expect(callsScreen("// screenUntrusted(raw, 'read')\nconst a = 1;")).toBe(false);
    expect(callsScreen("/* await screenUntrusted(x, 'read') */\nconst a = 1;")).toBe(false);
    expect(callsScreen("import { screenUntrusted } from '../safety/screen.js';\nconst a = 1;")).toBe(false);
    expect(callsScreen("import {\n  screenUntrusted(,\n} from './x.js';\n")).toBe(false);
    expect(callsScreen("import { screenUntrusted } from '../safety/screen.js';\nconst f = screenUntrusted;\n")).toBe(false);
    expect(callsScreen("const v = await screenUntrusted(raw, 'read');")).toBe(true);
    expect(callsScreen("const v = await deps.screen(raw, 'send');")).toBe(true);
    expect(callsScreen("const v = await screen(raw, 'read');")).toBe(true);
  });
  it('only allowlisted files call gateInput( or gateField( from the input gate', () => {
    const offenders: string[] = [];
    for (const f of walk(join(ROOT, 'src'))) {
      const rel = relative(ROOT, f).split('\\').join('/');
      const text = readFileSync(f, 'utf8');
      if (!/(inputGate|fieldGate)\.js/.test(text)) continue;
      if (!/\bgateInput\(|\bgateField\(/.test(text)) continue;
      // A caller must be an explicit SYNC_ONLY entry or a file that is itself a screened surface.
      if (!SYNC_ONLY.has(rel) && !SURFACE_FILES.has(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
