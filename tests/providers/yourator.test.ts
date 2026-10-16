import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/yourator.js';

describeProvider({
  id: "yourator",
  provider,
  file: "yourator.json",
  host: "yourator.co",
  count: 1,
  first: {"title": "Frontend Engineer", "company": "Iota", "url": "https://www.yourator.co/companies/iota/jobs/1"},
  descStarts: "Location: Taipei",
  breakKey: "path",
});
