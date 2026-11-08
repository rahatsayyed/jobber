import { describeProvider } from './_replay.js';
import { provider } from '../../src/sources/providers/gupy.js';

describeProvider({
  id: "gupy",
  provider,
  file: "gupy.json",
  host: "gupy.io",
  count: 1,
  first: {"title": "Desenvolvedor React", "company": "Acme", "url": "https://acme.gupy.io/jobs/1", "posted_at": "2025-10-02"},
  descStarts: "Location: Remoto, SP, Brasil",
  descHas: "Vaga invented",
  breakKey: "name",
});
