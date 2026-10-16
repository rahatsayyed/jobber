const FEED_URL = 'https://login.invented.test/api';
export default { id: 'loginboard', async fetch(entry, ctx) { return ctx.fetchJson(FEED_URL, { headers: { Authorization: 'Bearer ' + entry.token } }); } };
