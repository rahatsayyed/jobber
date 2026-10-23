import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb, isSeen, saveJob } from '../db.js';
import { dbPath } from '../dbPath.js';
import { fetchAllJobs, fetchAllJobsDetailed } from '../sources/index.js';
import { boardStatusPayload, dropBoardDuplicatesDetailed, recordDroppedDuplicates, type SeenRow } from '../sources/boards/index.js';
import { boardStatusReply, finishRun, setDroppedDuplicates, sourceStatusReply } from '../sources/status.js';

const db = openDb(dbPath());

const server = new McpServer({ name: 'job-fetch', version: '0.1.0' });

server.registerTool(
  'search_jobs',
  {
    description: 'Search job boards (Remotive, RemoteOK, Naukri, and the company boards (Greenhouse, Lever, Ashby, Workable, Recruitee, Personio, SmartRecruiters, Workday) and aggregator feeds (Hacker News Who is hiring, Himalayas, We Work Remotely) enabled in config/portals.json; boards use only the portals.json filters, not role/location) for a role',
    inputSchema: {
      role: z.string(),
      location: z.string().optional(),
    },
  },
  async ({ role, location }) => {
    const jobs = await fetchAllJobs({ role, location });
    return {
      content: [{ type: 'text', text: JSON.stringify(jobs) }],
    };
  }
);

server.registerTool(
  'list_new_jobs',
  {
    description:
      'Fetch jobs from all sources (Remotive, RemoteOK, Naukri, and the company boards (Greenhouse, Lever, Ashby, Workable, Recruitee, Personio, SmartRecruiters, Workday) and aggregator feeds (Hacker News Who is hiring, Himalayas, We Work Remotely) enabled in config/portals.json; boards use only the portals.json filters, not role/location) and return only ones not seen before, saving them to the db',
    inputSchema: {
      role: z.string(),
      location: z.string().optional(),
    },
  },
  async ({ role, location }) => {
    const { jobs, outcomes } = await fetchAllJobsDetailed({ role, location, isKnown: (id) => isSeen(db, id), db });
    const fresh = jobs.filter((job) => !isSeen(db, job.id));
    const recent = db
      .prepare("SELECT id, source, company_key, title_key FROM jobs WHERE created_at >= datetime('now', '-30 days') AND company_key IS NOT NULL AND title_key IS NOT NULL")
      .all() as SeenRow[];
    const { kept: newJobs, dropped } = dropBoardDuplicatesDetailed(fresh, recent);
    recordDroppedDuplicates(dropped);
    setDroppedDuplicates(dropped);
    if (newJobs.length < fresh.length) console.error(`[boards] dropped ${fresh.length - newJobs.length} board job(s) duplicating a recently seen posting`);
    for (const job of newJobs) {
      saveJob(db, job);
    }
    // Status never fails the fetch: a status write error is logged and the jobs are still returned.
    try { finishRun(db, outcomes, newJobs); } catch (e) { console.error('[job-fetch] source status not recorded:', e); }
    return {
      content: [{ type: 'text', text: JSON.stringify(newJobs) }],
    };
  }
);

server.registerTool(
  'board_status',
  {
    description:
      'DEPRECATED, use source_status. Read-only: per-company counts and errors from the most recent company-board fetch (call it after list_new_jobs; it never fetches, and returns ran:false when no fetch has run in this session). Never writes to the db.',
    inputSchema: {},
  },
  async () => {
    return boardStatusReply(boardStatusPayload());
  }
);

server.registerTool(
  'source_status',
  {
    description:
      'Read-only: one row per discovery source from the most recent list_new_jobs run: fetched, kept, new (saved in that call), redacted error, fallback_used. Call it after list_new_jobs; it never fetches and returns ran:false when no run has been stored.',
    inputSchema: {},
  },
  async () => {
    return sourceStatusReply(db);
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[job-fetch] fatal error:', err);
  process.exit(1);
});
