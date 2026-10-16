import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/4dayweek.js';

describeProvider({
  id: "4dayweek",
  provider,
  file: "4dayweek.json",
  host: "4dayweek.io",
  count: 1,
  first: {"title": "React Developer", "company": "Acme Co", "url": "https://4dayweek.io/job/react-developer-acme", "posted_at": "2025-10-02"},
  descStarts: "Location: Berlin, Germany (remote)",
  breakKey: "slug",
});
