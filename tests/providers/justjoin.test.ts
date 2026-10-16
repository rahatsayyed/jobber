import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/justjoin.js';

describeProvider({
  id: "justjoin",
  provider,
  file: "justjoin.json",
  host: "justjoin.it",
  count: 1,
  first: {"title": "React Developer", "company": "Lambda", "url": "https://justjoin.it/job-offer/lambda-react-developer-warsaw", "posted_at": "2025-10-02"},
  descStarts: "Location: remote, Warsaw (remote)",
  breakKey: "slug",
});
