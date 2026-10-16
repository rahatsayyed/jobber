import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/themuse.js';

describeProvider({
  id: "themuse",
  provider,
  file: "themuse.json",
  host: "themuse.com",
  count: 1,
  first: {"title": "Software Engineer", "company": "Epsilon", "url": "https://www.themuse.com/jobs/epsilon/software-engineer"},
  descStarts: "Location: Flexible / Remote (remote)",
  breakKey: "refs.landing_page",
});
