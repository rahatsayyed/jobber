// invented RSS feed
const FEED_URL = 'https://rss.invented.test/feed.xml';
export default { id: 'feedrss', async fetch(entry, ctx) { const t = await ctx.fetchText(FEED_URL); return t.split('<item>'); } };
