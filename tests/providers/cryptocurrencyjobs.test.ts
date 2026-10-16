import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/cryptocurrencyjobs.js';

describeProvider({
  id: "cryptocurrencyjobs",
  provider,
  file: "cryptocurrencyjobs.xml",
  host: "cryptocurrencyjobs.co",
  count: 1,
  first: {"title": "React Engineer", "company": "Xi", "url": "https://cryptocurrencyjobs.co/engineering/xi-react-engineer/", "posted_at": "2025-10-02"},
  descStarts: "Location: Remote (remote)",
  descHas: "Build invented wallets",
  breakKey: "link",
});
