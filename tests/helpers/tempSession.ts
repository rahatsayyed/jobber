import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeTempSession(): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'jobber-sess-'));
  const path = join(dir, 'state.json');
  writeFileSync(path, JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });
  chmodSync(path, 0o600);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
