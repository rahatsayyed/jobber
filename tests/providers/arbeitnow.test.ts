import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/arbeitnow.js';

describeProvider({
  id: "arbeitnow",
  provider,
  file: "arbeitnow.json",
  host: "arbeitnow.com",
  count: 1,
  first: {"title": "Full Stack Engineer", "company": "Beta GmbH", "url": "https://www.arbeitnow.com/jobs/companies/beta/full-stack-engineer-beta", "posted_at": "2025-10-02"},
  descStarts: "Location: Munich (remote)",
  descHas: "Build invented things",
  breakKey: "title",
});
