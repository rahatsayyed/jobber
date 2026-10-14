import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fetchLinkedInJobs } from '../discover/linkedin-jobs.js';
import { fetchLinkedInPosts } from '../discover/linkedin-posts.js';

const server = new McpServer({ name: 'discover', version: '0.1.0' });

server.registerTool(
  'linkedin_jobs',
  {
    description:
      'Scrape LinkedIn job search results (from the URL configured in config/discover-linkedin.json) for new postings not seen before. Burner account only.',
    inputSchema: {},
  },
  async () => {
    const jobs = await fetchLinkedInJobs();
    return { content: [{ type: 'text', text: JSON.stringify(jobs) }] };
  }
);

server.registerTool(
  'linkedin_posts',
  {
    description:
      'Scrape LinkedIn content search for hiring-intent posts not seen before. Burner account only.',
    inputSchema: {
      role: z.string().optional(),
      geo: z.string().optional(),
    },
  },
  async ({ role, geo }) => {
    const jobs = await fetchLinkedInPosts({ role, geo });
    return { content: [{ type: 'text', text: JSON.stringify(jobs) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[discover] fatal error:', err);
  process.exit(1);
});
