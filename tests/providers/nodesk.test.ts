import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/nodesk.js';

describeProvider({
  id: "nodesk",
  provider,
  file: "nodesk.xml",
  host: "nodesk.co",
  count: 1,
  first: {"title": "Frontend Engineer", "company": "Tau", "url": "https://nodesk.co/remote-jobs/tau-frontend-engineer/", "posted_at": "2025-10-02"},
  descStarts: "Location: (remote)",
  breakKey: "link",
});
