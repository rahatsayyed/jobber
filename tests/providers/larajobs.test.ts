import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/larajobs.js';

describeProvider({
  id: "larajobs",
  provider,
  file: "larajobs.xml",
  host: "larajobs.com",
  count: 1,
  first: {"title": "Laravel Developer", "company": "Sigma", "url": "https://larajobs.com/job/laravel-developer-sigma", "posted_at": "2025-10-02"},
  descStarts: "Location: Remote, Europe (remote)",
  breakKey: "link",
});
