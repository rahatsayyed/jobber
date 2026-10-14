import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { checkLivenessDetailed } from '../liveness.js';
import { vetoResults } from '../vetoes.js';
import BetterSqlite3 from 'better-sqlite3';
import { openDb, saveGateResults, saveJdSnapshot } from '../db.js';
import { dbPath } from '../dbPath.js';
import { jobFactsFromDb } from '../gateFacts.js';
import { loadLanguageConfigStatus } from '../languageGate.js';
import { loadTargetRegionsStatus } from '../targetRegions.js';

let db: BetterSqlite3.Database | null = null;
const getDb = () => (db ??= openDb(dbPath()));

const server = new McpServer({ name: 'gates', version: '0.1.0' });

server.registerTool(
  'check_liveness',
  {
    description: 'Check whether a job posting URL is still live: returns {liveness: active|expired|uncertain, snapshot_saved}. With job_id, an active page\'s full text is archived to jobs.jd_snapshot (URLs rot; some boards only give snippets).',
    inputSchema: { url: z.string().url(), job_id: z.string().optional() },
  },
  async ({ url, job_id }) => {
    const { liveness, text } = await checkLivenessDetailed(url);
    const snapshot_saved = !!(job_id && liveness === 'active' && text && saveJdSnapshot(getDb(), job_id, text));
    return { content: [{ type: 'text', text: JSON.stringify({ liveness, snapshot_saved }) }] };
  }
);

const verdict = z.enum(['PASS', 'FAIL', 'FLAG']);

server.registerTool(
  'apply_vetoes',
  {
    description:
      'Apply veto gates to match results (pass each result\'s STORED score from save_match_result.scores): location/language FAIL (model + deterministic language gate vs user-data/languages.json; FAIL only once that file has "confirmed": true), deal-breaker keywords, hard stops from the requirement table, "deadline passed: <date>" (stored ISO-day deadline before today, UTC; not applied to a job already emailed, connected or applied to), suspicious legitimacy, and "gate data unreadable: hard_stops" (corrupt stored hard_stops: fail closed). Location FAIL from the model is shown as a FLAG when the posting names a target region from config/target-regions.json (Gulf by default; "target regions config invalid: <why>" is flagged and no downgrade happens). Flags (never exclude): location/language FLAG, "language gate config missing" or "language gate config invalid: <entry>", stale postings (>30 days), legitimacy caution (reposts, age, thin JD, personal channels). Reads per-job facts from the db and persists legitimacy + flags on jobs.',
    inputSchema: {
      results: z.array(
        z.object({
          job_id: z.string(),
          score: z.number(),
          location_verdict: verdict.optional(),
          language_gate: verdict.optional(),
        })
      ),
      jobs: z.array(z.object({ id: z.string(), title: z.string(), description: z.string().nullable().optional(), location: z.string().nullable().optional(), remote: z.boolean().nullable().optional() })),
    },
  },
  async ({ results, jobs }) => {
    const d = getDb();
    const facts = new Map(results.map((r) => [r.job_id, jobFactsFromDb(d, r.job_id)]));
    const lc = loadLanguageConfigStatus();
    const tr = loadTargetRegionsStatus();
    const out = vetoResults(results, jobs, undefined, { facts, now: new Date(), languages: lc.config, languagesInvalid: lc.invalid, targetRegions: tr.config, targetRegionsInvalid: tr.invalid });
    saveGateResults(d, out);
    return { content: [{ type: 'text', text: JSON.stringify(out) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[gates] fatal error:', err);
  process.exit(1);
});
