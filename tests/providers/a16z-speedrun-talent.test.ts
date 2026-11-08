import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/a16z-speedrun-talent.js';

describeProvider({
  id: "a16z-speedrun-talent",
  provider,
  file: "a16z-speedrun-talent.json",
  host: "speedrun-talent-network.com",
  count: 1,
  first: {"title": "Full Stack Engineer", "company": "Nimbus", "url": "https://speedrun-talent-network.com/jobs/1", "posted_at": "2025-10-02"},
  descStarts: "Location: San Francisco",
  breakKey: "title",
});
