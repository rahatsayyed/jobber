// invented board-wide JSON feed
const FEED_URL = 'https://feed.invented.test/api/jobs';
export default { id: 'feedjson', async fetch(entry, ctx) { return await ctx.fetchJson(FEED_URL, { redirect: 'error' }); } };
