import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/agentic-jobs.js';

describeProvider({
  id: "agentic-jobs",
  provider,
  file: "agentic-jobs.json",
  host: "agentic-engineering-jobs.com",
  count: 1,
  first: {"title": "Agent Engineer", "company": "Orbit", "url": "https://agentic-engineering-jobs.com/jobs/agent-engineer-1", "posted_at": "2025-10-02"},
  descStarts: "Location: Germany",
  descHas: "Build agent loops.",
  breakKey: "title",
});
