import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/getonbrd.js';

describeProvider({
  id: "getonbrd",
  provider,
  file: "getonbrd.json",
  host: "getonbrd.com",
  count: 1,
  first: {"title": "Full Stack Developer", "company": "Kappa", "url": "https://www.getonbrd.com/jobs/programming/full-stack-kappa", "posted_at": "2025-10-02"},
  descStarts: "Location: Remote (remote)",
  breakKey: "attributes.title",
});
