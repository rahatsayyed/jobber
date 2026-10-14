import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkLiveness, checkLivenessDetailed, htmlToText } from '../src/liveness.js';
import { openDb, saveJdSnapshot, saveJob } from '../src/db.js';

afterEach(() => vi.unstubAllGlobals());

// A Response body can be read once. Every fetch call must get a FRESH Response, otherwise the second
// read throws and checkLivenessDetailed returns 'uncertain' (the test would then fail for the wrong reason).
const respond = (body: string, status: number) => vi.fn().mockImplementation(async () => new Response(body, { status }));

describe('htmlToText (re-exported from src/htmlText.ts)', () => {
  it('drops scripts/styles/tags and decodes entities', () => {
    expect(htmlToText('<style>x{}</style><script>a()</script><h1>Dev &amp; Ops</h1><p>Apply&nbsp;now &lt;3</p>')).toBe('Dev & Ops Apply now <3');
  });
  it('decodes numeric entities', () => {
    expect(htmlToText('<p>We&#8217;re hiring</p>')).toBe('We’re hiring');
  });
});

describe('checkLivenessDetailed', () => {
  it('returns the page text for a live 200 page', async () => {
    vi.stubGlobal('fetch', respond('<main><h1>React Dev</h1><button>Apply now</button></main>', 200));
    expect(await checkLivenessDetailed('https://x.com/jobs/123456')).toEqual({ liveness: 'active', text: 'React Dev Apply now' });
  });
  it('no text for a 404, and checkLiveness keeps its old return type', async () => {
    vi.stubGlobal('fetch', respond('gone', 404));
    expect(await checkLivenessDetailed('https://x.com/jobs/123456')).toEqual({ liveness: 'expired', text: null });
    expect(await checkLiveness('https://x.com/jobs/123456')).toBe('expired');
  });
});

describe('saveJdSnapshot', () => {
  it('stores only substantial, longer snapshots', () => {
    const db = openDb(':memory:');
    saveJob(db, { id: 'j1', source: 's', title: 't', company: 'c', url: 'u', apply_url: 'u', description: 'snippet' });
    expect(saveJdSnapshot(db, 'j1', 'short')).toBe(false);
    expect(saveJdSnapshot(db, 'j1', 'x'.repeat(300))).toBe(true);
    expect(saveJdSnapshot(db, 'j1', 'y'.repeat(250))).toBe(false);
    expect((db.prepare("SELECT length(jd_snapshot) AS n, jd_snapshot_at IS NOT NULL AS dated FROM jobs WHERE id = 'j1'").get() as any)).toEqual({ n: 300, dated: 1 });
    expect(saveJdSnapshot(db, 'missing', 'x'.repeat(300))).toBe(false);
  });
});
