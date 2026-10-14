import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb, isSeen, saveJob } from '../db.js';
import { dbPath } from '../dbPath.js';
import { fetchAllJobs } from '../sources/index.js';
import { boardStatusPayload, dropBoardDuplicatesDetailed, recordDroppedDuplicates, type SeenRow } from '../sources/boards/index.js';

const db = openDb(dbPath());

const server = new McpServer({ name: 'job-fetch', version: '0.1.0' });

server.registerTool(
  'search_jobs',
  {
    description: 'Search job boards (Adzuna, Remotive, RemoteOK, Naukri, and the company boards (Greenhouse, Lever, Ashby, Workable, Recruitee, Personio, SmartRecruiters, Workday) and aggregator feeds (Hacker News Who is hiring, Himalayas, We Work Remotely) enabled in config/portals.json; boards use only the portals.json filters, not role/location) for a role',
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
      'Fetch jobs from all sources (Adzuna, Remotive, RemoteOK, Naukri, and the company boards (Greenhouse, Lever, Ashby, Workable, Recruitee, Personio, SmartRecruiters, Workday) and aggregator feeds (Hacker News Who is hiring, Himalayas, We Work Remotely) enabled in config/portals.json; boards use only the portals.json filters, not role/location) and return only ones not seen before, saving them to the db',
    inputSchema: {
      role: z.string(),
      location: z.string().optional(),
    },
  },
  async ({ role, location }) => {
    const jobs = await fetchAllJobs({ role, location, isKnown: (id) => isSeen(db, id) });
    const fresh = jobs.filter((job) => !isSeen(db, job.id));
    const recent = db
      .prepare("SELECT id, source, company_key, title_key FROM jobs WHERE created_at >= datetime('now', '-30 days') AND company_key IS NOT NULL AND title_key IS NOT NULL")
      .all() as SeenRow[];
    const { kept: newJobs, dropped } = dropBoardDuplicatesDetailed(fresh, recent);
    recordDroppedDuplicates(dropped);
    if (newJobs.length < fresh.length) console.error(`[boards] dropped ${fresh.length - newJobs.length} board job(s) duplicating a recently seen posting`);
    for (const job of newJobs) {
      saveJob(db, job);
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(newJobs) }],
    };
  }
);

server.registerTool(
  'board_status',
  {
    description:
      'Read-only: per-company counts and errors from the most recent company-board fetch (call it after list_new_jobs; it never fetches, and returns ran:false when no fetch has run in this session). Never writes to the db.',
    inputSchema: {},
  },
  async () => {
    return { content: [{ type: 'text', text: JSON.stringify(boardStatusPayload()) }] };
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
