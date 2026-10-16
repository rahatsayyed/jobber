import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/startup-jobs.js';

describeProvider({
  id: "startup-jobs",
  provider,
  file: "startup-jobs.xml",
  host: "startup.jobs",
  count: 1,
  first: {"title": "Full Stack Developer", "company": "Phi", "url": "https://startup.jobs/full-stack-developer-at-phi-123", "posted_at": "2025-10-02"},
  descStarts: "Location: Remote (remote)",
  breakKey: "link",
});
