import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/flowxtra.js';

describeProvider({
  id: "flowxtra",
  provider,
  file: "flowxtra.json",
  host: "flowxtra.com",
  count: 1,
  first: {"title": "Full Stack Developer", "company": "Theta", "url": "https://careers.flowxtra.com/job/123", "posted_at": "2025-10-02"},
  descStarts: "Location: Dubai, UAE (remote)",
  breakKey: "urlJobApplay",
});
