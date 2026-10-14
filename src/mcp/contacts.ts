import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { openDb, saveContact, type Contact } from '../db.js';
import { dbPath } from '../dbPath.js';
import { extractEmails, classify, rankEmails, genPatterns } from '../lib/emails.js';
import { scrapeEmails } from '../lib/scrape.js';
import { verifyEmail } from '../lib/verify.js';
import { hunterDomainSearch } from '../lib/hunter.js';

const db = openDb(dbPath());

const SOCIAL_HOSTS = [
  'linkedin.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'github.com',
  'youtube.com',
];

function stripWww(host: string): string {
  return host.replace(/^www\./, '');
}

async function serperSearch(query: string): Promise<any> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query }),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function findDomain(company: string): Promise<string | null> {
  const results = await serperSearch(`"${company}" official website`);
  const organic: any[] = results?.organic ?? [];
  for (const item of organic) {
    try {
      const url = new URL(item.link);
      const host = stripWww(url.hostname.toLowerCase());
      if (!SOCIAL_HOSTS.some((social) => host === social || host.endsWith(`.${social}`))) {
        return host;
      }
    } catch {
      // ignore malformed links
    }
  }
  return null;
}

async function searchDomainEmails(domain: string): Promise<string[]> {
  const results = await serperSearch(`"@${domain}" (careers OR hr OR recruiting OR jobs)`);
  const organic: any[] = results?.organic ?? [];
  const text = organic
    .map((item) => `${item.title ?? ''} ${item.snippet ?? ''} ${item.link ?? ''}`)
    .join('\n');
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
    description: 'Find and verify company emails via scraping, search, Hunter.io, and pattern generation',
    inputSchema: {
      company: z.string(),
      domain: z.string().optional(),
      person_name: z.string().optional(),
    },
  },
  async ({ company, domain, person_name }) => {
    const resolvedDomain = domain ?? (await findDomain(company));

    if (!resolvedDomain) {
      return { content: [{ type: 'text', text: JSON.stringify([]) }] };
    }

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

    return { content: [{ type: 'text', text: JSON.stringify(output) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[contacts] fatal error:', err);
  process.exit(1);
});
