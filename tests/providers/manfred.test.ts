import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/manfred.js';

describeProvider({
  id: "manfred",
  provider,
  file: "manfred.json",
  host: "getmanfred.com",
  count: 1,
  first: {"title": "Senior Frontend", "company": "Mu", "url": "https://www.getmanfred.com/ofertas-empleo/42/mu-dev"},
  descStarts: "Location: Remote (remote)",
  breakKey: "slug",
});
