import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/workingnomads.js';

describeProvider({
  id: "workingnomads",
  provider,
  file: "workingnomads.json",
  host: "workingnomads.com",
  count: 1,
  first: {"title": "Frontend Developer", "company": "Delta", "url": "https://www.workingnomads.com/jobs/frontend-developer-1"},
  descStarts: "Location: Worldwide (remote)",
  breakKey: "title",
});
