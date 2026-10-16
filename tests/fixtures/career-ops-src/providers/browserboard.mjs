import { chromium } from 'playwright';
export default { id: 'browserboard', async fetch() { const b = await chromium.launch(); return b; } };
