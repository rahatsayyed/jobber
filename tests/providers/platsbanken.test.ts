import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/platsbanken.js';

describeProvider({
  id: "platsbanken",
  provider,
  file: "platsbanken.json",
  host: "jobtechdev.se",
  jobHost: "arbetsformedlingen.se",
  count: 1,
  first: {"title": "React Developer", "company": "Fjord AB", "url": "https://arbetsformedlingen.se/platsbanken/annonser/29000001", "posted_at": "2025-10-02"},
  descStarts: "Location: Malmo, Skane, Sverige",
  descHas: "Invented text.",
  breakKey: "headline",
});
