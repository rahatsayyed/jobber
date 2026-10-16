import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/jobicy.js';

describeProvider({
  id: "jobicy",
  provider,
  file: "jobicy.json",
  host: "jobicy.com",
  count: 1,
  first: {"title": "Node Engineer", "company": "Gamma", "url": "https://jobicy.com/jobs/1-node-engineer", "posted_at": "2025-10-02"},
  descStarts: "Location: Anywhere (remote)",
  breakKey: "jobTitle",
});
