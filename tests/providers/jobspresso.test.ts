import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/jobspresso.js';

describeProvider({
  id: "jobspresso",
  provider,
  file: "jobspresso.xml",
  host: "jobspresso.co",
  count: 1,
  first: {"title": "Full Stack Developer", "company": "Rho", "url": "https://jobspresso.co/job/full-stack-developer-rho/", "posted_at": "2025-10-02"},
  descStarts: "Location: Anywhere (remote)",
  breakKey: "title",
});
