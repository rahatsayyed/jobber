import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/pythonorg.js';

describeProvider({
  id: "pythonorg",
  provider,
  file: "pythonorg.xml",
  host: "python.org",
  count: 1,
  first: {"title": "Python Developer", "company": "Upsilon Corp", "url": "https://www.python.org/jobs/9999/", "posted_at": "2025-10-02"},
  descStarts: "Location: Berlin, Germany",
  descHas: "invented Django",
  breakKey: "title",
});
