export default { id: 'pagehtml', async fetch(entry, ctx) { const html = await ctx.fetchText('https://html.invented.test/jobs'); return html.match(/<li class="job">/g); } };
