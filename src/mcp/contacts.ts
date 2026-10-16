import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb, saveContact, type Contact } from '../db.js';
import { dbPath } from '../dbPath.js';
import { extractEmails, classify, rankEmails, genPatterns } from '../lib/emails.js';
import { scrapeEmails } from '../lib/scrape.js';
import { verifyEmail } from '../lib/verify.js';
import { hunterDomainSearch } from '../lib/hunter.js';
import { withHnGate } from '../lib/postingDomains.js';
import { searchWithBudget } from '../search/index.js';
import { resolveDomainForJob } from '../search/ladder.js';

const db = openDb(dbPath());

// Search goes through src/search (cache, then browser dork, then Serper under budget).
async function searchDomainEmails(domain: string): Promise<string[]> {
  const out = await searchWithBudget(db, 'domain_emails', { domain });
  const text = out.results.map((item) => `${item.title} ${item.snippet} ${item.url}`).join('\n');
  return extractEmails(text);
}

const CONFIDENCE = {
  role: 0.9,
  generic: 0.6,
  verifiedPersonal: 0.7,
  unverified: 0.2,
};

const server = new McpServer({ name: 'contacts', version: '0.1.0' });

server.registerTool(
  'find_company_emails',
  {
    description: 'Contact finding: resolve the company domain (param, apply_url, HN posting, budgeted search), then find and verify company emails via scraping, budgeted search (cache, browser, Serper), Hunter.io, and pattern generation',
    inputSchema: {
      company: z.string(),
      domain: z.string().optional(),
      person_name: z.string().optional(),
      job_id: z.string().max(200).optional(),
    },
  },
  async ({ company, domain, person_name, job_id }) => {
    // source, apply_url and description come from the jobs table, never from the model.
    const { job, ladder } = await resolveDomainForJob(db, { company, domain, job_id });
    const resolvedDomain = ladder.domain;

    // Without job_id the tool is unchanged (returns the bare array).
    if (job_id === undefined) {
      const out = resolvedDomain ? await gather(company, resolvedDomain, person_name) : [];
      return { content: [{ type: 'text', text: JSON.stringify(out) }] };
    }

    const gated = await withHnGate(job ?? null, resolvedDomain ?? '', async () =>
      resolvedDomain ? gather(company, resolvedDomain, person_name) : [],
    );
    const result = { contacts: gated.contacts, hn_check: gated.hn_check, domain: resolvedDomain ?? null, domain_source: ladder.domain_source };
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }
);

async function gather(company: string, resolvedDomain: string, person_name?: string): Promise<unknown[]> {
    const scraped = await scrapeEmails(resolvedDomain);
    const searched = await searchDomainEmails(resolvedDomain);
    const hunter = await hunterDomainSearch(resolvedDomain);
    const patterns = person_name
      ? genPatterns(person_name, resolvedDomain, hunter?.pattern ?? undefined)
      : [];

    type Candidate = { email: string; source: string };
    const candidates = new Map<string, Candidate>();

    for (const email of scraped) {
      if (!candidates.has(email)) candidates.set(email, { email, source: 'scraped' });
    }
    for (const email of searched) {
      if (!candidates.has(email)) candidates.set(email, { email, source: 'search' });
    }
    for (const email of hunter?.emails ?? []) {
      const lower = email.toLowerCase();
      if (!candidates.has(lower)) candidates.set(lower, { email: lower, source: 'hunter' });
    }
    for (const email of patterns) {
      if (!candidates.has(email)) candidates.set(email, { email, source: 'pattern' });
    }

    const contacts: Contact[] = [];

    for (const { email, source } of candidates.values()) {
      const type = classify(email);
      const trusted = (source === 'scraped' || source === 'hunter') && type !== 'personal';
      const verified = await verifyEmail(email, { trusted });

      let confidence: number;
      if (verified) {
        confidence =
          type === 'role'
            ? CONFIDENCE.role
            : type === 'generic'
              ? CONFIDENCE.generic
              : CONFIDENCE.verifiedPersonal;
      } else {
        confidence = CONFIDENCE.unverified;
      }

      contacts.push({
        company,
        email,
        type,
        verified,
        source,
        confidence,
      });
    }

    const ranked = rankEmails(contacts.map((c) => c.email))
      .map((r) => contacts.find((c) => c.email === r.email)!)
      .sort((a, b) => Number(b.verified) - Number(a.verified));

    for (const contact of ranked) {
      saveContact(db, contact);
    }

    const anyVerified = ranked.some((c) => c.verified);
    const output = anyVerified
      ? ranked
      : ranked.length > 0
        ? [{ ...ranked[0], note: 'unverified — flag to human' }]
        : [];

    return output;
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[contacts] fatal error:', err);
  process.exit(1);
});
