import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { getBaseResume, renderResumeChecked } from '../resume.js';
import { checkTextWithNormalized } from '../resumeFacts.js';
import { applyReviewEdits, jobDescriptionSchema } from '../reviewEdits.js';

const server = new McpServer({ name: 'resume', version: '0.1.0' });

server.registerTool(
  'get_base_resume',
  {
    description: 'Get the base resume JSON',
    inputSchema: {},
  },
  async () => {
    return {
      content: [{ type: 'text', text: JSON.stringify(getBaseResume()) }],
    };
  }
);

const keywordSchema = z.object({
  term: z.string(),
  priority: z.enum(['required', 'preferred']),
  synonyms: z.array(z.string()).optional(),
});

server.registerTool(
  'render_resume',
  {
    description:
      'Fact-check (v2) a tailored resume against the base resume, make its text ATS-safe, render a one-page PDF ' +
      '(auto-cuts the lowest-relevance bullets on overflow), and classify posting keywords. THROWS on unsupported claims. ' +
      'ats statuses: covered | synonym_only | missing_have_it (base prose shows it) | skills_only (base lists it only as a skill; never claim it as work) | gap. ' +
      'Returns {pdf_path, resume_json (as rendered), facts {verdict, invented, unsupported, forbidden, warnings}, ats, ats_coverage, trimmed, fill_ratio}.',
    inputSchema: {
      resume_json: z.record(z.string(), z.any()),
      job_description: jobDescriptionSchema,
      job_title: z.string().optional(),
      keywords: z.array(keywordSchema).optional(),
    },
  },
  async ({ resume_json, job_description, job_title, keywords }) => {
    const r = await renderResumeChecked(resume_json, { jobDescription: job_description, jobTitle: job_title, keywords });
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ pdf_path: r.pdfPath, resume_json: r.resume, facts: r.facts, ats: r.ats, ats_coverage: r.atsCoverage, trimmed: r.trimmed, fill_ratio: r.fillRatio }),
      }],
    };
  }
);

server.registerTool(
  'check_text',
  {
    description:
      'Fact-check a drafted email, connect note or follow-up against the base resume (metrics, tools, titles, scope escalations, forbidden phrases). ' +
      'extra_source = text the claims may also come from (e.g. the original sent email). job_title and company are blanked out of the text first, so quoting the posting title or the employer is not a claim; ' +
      'honest gap lines ("I haven\'t worked with X yet") are not claims. The text is normalized first (invisible format characters stripped, ' +
      'smart quotes/dashes to ASCII) and THAT text is gated. Returns {verdict: pass|warn|block, invented, unsupported, forbidden, warnings, normalized_text}; ' +
      'enqueue/send normalized_text, never the text you passed in.',
    inputSchema: {
      text: z.string(),
      job_description: jobDescriptionSchema,
      extra_source: z.string().optional(),
      job_title: z.string().optional(),
      company: z.string().optional(),
    },
  },
  async ({ text, job_description, extra_source, job_title, company }) => {
    const r = checkTextWithNormalized(text, getBaseResume(), { jobDescription: job_description, extraSource: extra_source, jobTitle: job_title, company });
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  }
);

server.registerTool(
  'apply_review_edits',
  {
    description:
      'Apply a reviewer\'s structured edits to a tailored resume (and optionally an email draft) one at a time. Each edit must quote a unique ' +
      'old_string at its path; any edit that would add an unsupported claim (fact gate v2) is rejected, never applied. Resume, email and edits are ' +
      'normalized first (invisible format characters stripped, smart quotes/dashes to ASCII); the returned resume/email are that normalized text. Returns {resume, email, applied, rejected, facts, emailFacts}.',
    inputSchema: {
      resume_json: z.record(z.string(), z.any()),
      email: z.object({ subject: z.string().max(2000), body: z.string().max(2000) }).strict().optional(),
      edits: z.array(z.object({
        target: z.enum(['resume', 'email']),
        path: z.string().max(2000),
        old_string: z.string().max(2000),
        new_string: z.string().max(2000),
        reason: z.enum(['keyword', 'reframing', 'style', 'grounding', 'cut', 'fact-gate']),
      }).strict()).max(20),
      job_description: jobDescriptionSchema,
      job_title: z.string().max(2000).optional(),
      company: z.string().max(2000).optional(),
    },
  },
  async ({ resume_json, email, edits, job_description, job_title, company }) => {
    const r = applyReviewEdits(getBaseResume(), resume_json, email ?? null, edits, { jobDescription: job_description, jobTitle: job_title, company });
    return { content: [{ type: 'text', text: JSON.stringify(r) }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[resume] fatal error:', err);
  process.exit(1);
});
