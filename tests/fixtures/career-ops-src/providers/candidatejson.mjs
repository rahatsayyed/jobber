const API_BASE = 'https://candidate.invented.test/api/v1/jobs';
export default { id: 'candidatejson', async fetch(entry, ctx) { return ctx.fetchJson(API_BASE + '?page=1'); } };
