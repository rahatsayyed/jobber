import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/higheredjobs.js';

describeProvider({
  id: "higheredjobs",
  provider,
  file: "higheredjobs.xml",
  host: "higheredjobs.com",
  count: 1,
  first: {"title": "Web Developer", "company": "Example University", "url": "https://www.higheredjobs.com/details.cfm?JobCode=1", "posted_at": "2025-10-02"},
  descStarts: "Location: Springfield, IL",
  breakKey: "title",
});
