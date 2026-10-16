import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPortals } from '../src/sources/boards/filters.js';
import { customSites } from '../src/scout/targets.js';

describe('custom portals entries', () => {
  it('the script boards skip a custom entry silently and the scout reads only enabled https ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobber-'));
    const file = path.join(dir, 'portals.json');
    fs.writeFileSync(file, JSON.stringify({
      tracked_companies: [
        { name: 'Zeta', ats: 'custom', url: 'https://careers.zeta.example.test/jobs', enabled: true },
        { name: 'Off', ats: 'custom', url: 'https://off.example.test/jobs', enabled: false },
        { name: 'Plain', ats: 'custom', url: 'http://plain.example.test/jobs', enabled: true },
        { name: 'NoUrl', ats: 'custom', enabled: true },
      ],
      title_filter: { positive: ['engineer'], negative: [] },
      location_filter: { allow: ['india'] },
    }));
    const r = loadPortals(file);
    expect(r.config?.tracked_companies ?? []).toEqual([]);
    expect(r.warnings ?? []).toEqual([]);
    expect(customSites(file)).toEqual([{ name: 'Zeta', url: 'https://careers.zeta.example.test/jobs' }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
