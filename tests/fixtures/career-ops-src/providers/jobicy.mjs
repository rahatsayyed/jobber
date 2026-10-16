const FEED_URL = 'https://jobicy.com/api/v2/remote-jobs?count=50';
export default { id: 'jobicy', async fetch(entry, ctx) { return ctx.fetchJson(FEED_URL); } };
