import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/landingjobs.js';

describeProvider({
  id: "landingjobs",
  provider,
  file: "landingjobs.json",
  host: "landing.jobs",
  count: 1,
  first: {"title": "Backend Dev", "company": "Zeta Labs", "url": "https://landing.jobs/at/zeta-labs/backend-dev", "posted_at": "2025-10-02"},
  descStarts: "Location: Lisbon, PT",
  breakKey: "url",
});
