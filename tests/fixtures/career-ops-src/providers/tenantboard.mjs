export default { id: 'tenantboard', async fetch(entry, ctx) { return ctx.fetchJson(entry.careers_url + '/jobs.json'); } };
