export default { id: 'greenhouse', async fetch(entry, ctx) { return ctx.fetchJson('https://boards-api.greenhouse.io/v1/boards/' + entry.slug + '/jobs'); } };
