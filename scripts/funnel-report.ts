// Write an offline funnel report: npm run report  ->  reports/funnel-YYYY-MM-DD.html
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { dbPath } from '../src/dbPath.js';
import { funnelStats, renderFunnelHtml } from '../src/funnel.js';

const db = openDb(dbPath()); // never the literal 'data.sqlite': JOBAPPLIER_DB=:memory: gives a safe empty run for checks
const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
const html = renderFunnelHtml(funnelStats(db, Number(process.env.MATCH_THRESHOLD ?? 60)), now);
mkdirSync('reports', { recursive: true });
const file = path.join('reports', `funnel-${now.slice(0, 10)}.html`);
writeFileSync(file, html);
console.log(file);
