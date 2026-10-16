import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/thehub.js';

describeProvider({
  id: "thehub",
  provider,
  file: "thehub.json",
  host: "thehub.io",
  count: 1,
  first: {"title": "React Developer", "company": "Eta ApS", "url": "https://thehub.io/jobs/abc123"},
  descStarts: "Location: Copenhagen, Denmark (remote)",
  breakKey: "id",
});
