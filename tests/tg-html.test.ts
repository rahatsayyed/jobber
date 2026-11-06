// The HTML helper for code-sent Telegram notices (src/platform/tgHtml.ts), its transport (send.ts html option) and the formatter gaps
// fixed in src/telegram/format.ts. Fakes only: no Telegram, no network.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ApiResult, TelegramApi } from '../src/telegram/api.js';
import { sendToTopic } from '../src/telegram/send.js';
import { markdownToHtml } from '../src/telegram/format.js';
import { telegramNotifier } from '../src/platform/notify.js';
import { openDb } from '../src/db.js';
import { pingAssist } from '../src/applier/assistPing.js';
import { composeReminder } from '../src/scheduler/windowTick.js';
import { runEscalationDigest } from '../src/scheduler/escalationDigest.js';
import {
  BLANK, E, b, bullets, clean, code, esc, excerpt, headline, html, htmlToPlain, i, join, line, lines, link, pre, section, splitHtml, truncateHtml,
} from '../src/platform/tgHtml.js';

const TOKEN = '123456:SECRET-token_abc';
let root: string;
beforeEach(() => { root = mkdtempSync(path.join(tmpdir(), 'tgh-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const balanced = (c: string): boolean => {
  for (const tag of ['b', 'i', 'code', 'pre', 'a', 's']) {
    const open = (c.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;
    const close = (c.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    if (open !== close) return false;
  }
  return true;
};

describe('builders', () => {
  it('plain strings are always escaped, Html values pass through', () => {
    expect(String(b('<i>x</i> & y'))).toBe('<b>&lt;i&gt;x&lt;/i&gt; &amp; y</b>');
    expect(String(b(i('x')))).toBe('<b><i>x</i></b>');
    expect(String(code('a<b'))).toBe('<code>a&lt;b</code>');
    expect(String(pre('x\n<y>'))).toBe('<pre>x\n&lt;y&gt;</pre>');
    expect(String(esc('<b>'))).toBe('&lt;b&gt;');
    // an Html value interpolated into a plain template string is escaped again (the safe default), join keeps it
    expect(html(`${b('x')}`)).toBe('&lt;b&gt;x&lt;/b&gt;');
    expect(html(join([b('x'), 'y']))).toBe('<b>x</b> y');
  });

  it('link: real anchor for a safe url, label only for an unsafe one, attribute escaped', () => {
    expect(String(link('site', 'https://e.com/a?x=1&y=2'))).toBe('<a href="https://e.com/a?x=1&amp;y=2">site</a>');
    expect(String(link('site', 'https://e.com/a"onclick=1'))).toBe('site'); // a quote in the url is refused
    expect(String(link('x', 'javascript:alert(1)'))).toBe('x');
    expect(String(link('<b>', null))).toBe('&lt;b&gt;');
  });

  it('line, section, bullets, lines, headline', () => {
    expect(String(line('Label', 'v<'))).toBe('<b>Label:</b> v&lt;');
    expect(String(line('Label', ''))).toBe('');
    expect(String(section('Title', [bullets(['a', 'b']), '', false]))).toBe('<b>Title</b>\n• a\n• b');
    expect(String(section('Title', [null, false]))).toBe('');
    expect(String(bullets(['a', null, 'b']))).toBe('• a\n• b');
    expect(String(headline(E.warn, 'Wake <x>'))).toBe('⚠️ <b>Wake &lt;x&gt;</b>');
    expect(String(lines(['a', '', 'b', BLANK, 'c']))).toBe('a\nb\n\nc');
  });

  it('clean: one line, control characters gone, secrets redacted, bounded on a code point edge', () => {
    expect(clean('a\u0000b\n\tc‮ d', 50)).toBe('a b c d');
    expect(clean(`key sk-ant-api03-${'A'.repeat(40)}`)).not.toContain('sk-ant');
    expect(clean('x'.repeat(500), 40)).toHaveLength(40);
    const emoji = clean('😀'.repeat(50), 10);
    expect(Array.from(emoji)).toHaveLength(10);
    expect(emoji.endsWith('…')).toBe(true);
    expect(excerpt('y'.repeat(900), 900).length).toBeLessThanOrEqual(200);
    expect(clean(null)).toBe('');
  });
});

describe('truncate and split never break tags or entities', () => {
  it('truncateHtml closes open tags and does not cut an entity or a tag', () => {
    const src = `<b>${'&amp; word '.repeat(100)}</b>`;
    for (const max of [30, 31, 55, 100, 333]) {
      const t = truncateHtml(src, max);
      expect(t.length).toBeLessThanOrEqual(max);
      expect(balanced(t)).toBe(true);
      expect(t).not.toMatch(/&[a-z]*$/);
      expect(t).not.toMatch(/<[^>]*$/);
    }
    expect(truncateHtml('short', 100)).toBe('short');
  });

  it('splitHtml cuts on lines, keeps every chunk under the limit and reopens a pre block', () => {
    const rows = Array.from({ length: 300 }, (_, n) => `row ${n} &lt;tag&gt; value`);
    const text = `<b>head</b>\n<pre>${rows.join('\n')}</pre>\ntail ${'z'.repeat(5000)}`;
    const chunks = splitHtml(text, 1000);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1000);
      expect(balanced(c)).toBe(true);
    }
    expect(chunks.filter((c) => c.includes('<pre>')).length).toBeGreaterThan(1);
  });

  it('a single huge line is truncated, never an unbounded chunk', () => {
    const chunks = splitHtml(`<b>${'x'.repeat(9000)}</b>`, 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length).toBeLessThanOrEqual(1000);
    expect(balanced(chunks[0]!)).toBe(true);
  });
});

describe('plain-text fallback', () => {
  it('drops tags, decodes entities, shows a link as text (url)', () => {
    expect(htmlToPlain('<b>a</b> &lt;x&gt; &amp; <code>c</code>')).toBe('a <x> & c');
    expect(htmlToPlain('<a href="https://e.com/a?x=1&amp;y=2">site</a>')).toBe('site (https://e.com/a?x=1&y=2)');
    expect(htmlToPlain('<a href="mailto:a@b.example">a@b.example</a>')).toBe('a@b.example');
    expect(htmlToPlain('<a href="https://e.com">https://e.com</a>')).toBe('https://e.com');
  });
});

describe('transport: sendToTopic with html', () => {
  interface Call { method: string; payload: Record<string, unknown> }
  const fake = (handler?: (c: Call) => ApiResult | undefined): { api: TelegramApi; calls: Call[] } => {
    const calls: Call[] = [];
    const api: TelegramApi = {
      async call<T>(method: string, payload: Record<string, unknown>): Promise<ApiResult<T>> {
        const c = { method, payload };
        calls.push(c);
        return (handler?.(c) ?? { ok: true, result: {} }) as ApiResult<T>;
      },
    };
    return { api, calls };
  };
  const env = { TELEGRAM_BOT_TOKEN: TOKEN, ALLOWED_USERS: '42' } as NodeJS.ProcessEnv;

  it('sends the HTML as is with parse_mode HTML (no markdown conversion)', async () => {
    const { api, calls } = fake();
    const text = '✅ <b>Cold email sent</b>\n<b>To:</b> a_b@x.example *not italic*';
    const r = await sendToTopic('drips', text, { env, root, api, html: true });
    expect(r.ok).toBe(true);
    const sent = calls.filter((c) => c.method === 'sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ text, parse_mode: 'HTML' });
  });

  it('a parse error resends the same notice as plain text', async () => {
    let n = 0;
    const { api, calls } = fake((c) => (c.method === 'sendMessage' && n++ === 0 ? { ok: false, description: "Bad Request: can't parse entities: Unsupported start tag" } as ApiResult : undefined));
    const r = await sendToTopic('alerts', '<b>Wake</b> &lt;x&gt; <a href="https://e.com">l</a>', { env, root, api, html: true });
    expect(r.ok).toBe(true);
    const sent = calls.filter((c) => c.method === 'sendMessage');
    expect(sent).toHaveLength(2);
    expect(sent[1]!.payload.parse_mode).toBeUndefined();
    expect(sent[1]!.payload.text).toBe('Wake <x> l (https://e.com)');
  });

  it('a long notice is split over several messages, each balanced and under 4096', async () => {
    const { api, calls } = fake();
    const big = Array.from({ length: 400 }, (_, k) => `<b>#${k}</b> ${'text '.repeat(10)}`).join('\n');
    await sendToTopic('inbox', big, { env, root, api, html: true });
    const sent = calls.filter((c) => c.method === 'sendMessage');
    expect(sent.length).toBeGreaterThan(2);
    for (const c of sent) {
      expect(String(c.payload.text).length).toBeLessThanOrEqual(4096);
      expect(balanced(String(c.payload.text))).toBe(true);
    }
  });

  it('the notifier passes html through; without it text still goes through markdown', async () => {
    const bodies: string[] = [];
    const fetchFn = (async (_u: string, init: { body: string }) => {
      bodies.push(init.body);
      return { ok: true, json: async () => ({ ok: true, result: { message_thread_id: 5 } }), text: async () => '{}' };
    }) as unknown as typeof fetch;
    const n = telegramNotifier(env, fetchFn, root);
    await n.send('<b>x</b>', { topic: 'alerts', html: true });
    await n.send('**x**', { topic: 'alerts' });
    const msgs = bodies.map((x) => JSON.parse(x) as Record<string, unknown>).filter((x) => 'text' in x);
    expect(msgs.map((m) => m.text)).toEqual(['<b>x</b>', '<b>x</b>']);
  });
});

describe('format.ts gaps (free chat replies)', () => {
  it('bold plus italic is one nested pair; strike works; star bullets and numbered lists survive', () => {
    expect(markdownToHtml('***both***')).toBe('<b><i>both</i></b>');
    expect(markdownToHtml('**bold *it* more**')).toBe('<b>bold <i>it</i> more</b>');
    expect(markdownToHtml('~~gone~~ and kept')).toBe('<s>gone</s> and kept');
    expect(markdownToHtml('* one\n* two')).toBe('- one\n- two');
    expect(markdownToHtml('1. one\n2. two')).toBe('1. one\n2. two');
    expect(markdownToHtml('# Title\n> quote')).toBe('<b>Title</b>\n<blockquote>quote</blockquote>');
  });

  it('a markdown table becomes an aligned escaped code block', () => {
    const out = markdownToHtml('before\n| name | n |\n|---|---|\n| <b>a</b> | 22 |\nafter');
    expect(out).toContain('<pre>name      n\n&lt;b&gt;a&lt;/b&gt;  22</pre>');
    expect(out).toContain('before');
    expect(out).toContain('after');
    expect(out).not.toContain('<b>a');
  });

  it('hostile input stays escaped everywhere', () => {
    const out = markdownToHtml('**<img src=x onerror=1>** ~~<script>~~ [a](https://e.com/"><x>)');
    expect(out).not.toMatch(/<(img|script|x)/);
  });
});

describe('other notices', () => {
  it('assist ping: HTML, command in code, hostile host and title escaped', async () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO jobs (id, source, title, company, apply_url) VALUES ('j1','x','<b>Dev</b> & Co','Acme','https://a.example/a')").run();
    const sent: string[] = [];
    const r = await pingAssist(db, { host: 'h.example<x>', jobId: 'j1', reason: 'captcha', notifier: { send: async (t) => { sent.push(t); return { ok: true, detail: 'x' }; } }, now: new Date('2026-11-02T10:00:00Z'), env: {} });
    expect(r).toBe('sent');
    expect(sent[0]).toContain('🔔 <b>Jobber needs you on h.example&lt;x&gt;</b>');
    expect(sent[0]).toContain('<b>Run:</b> <code>npm run apply:assist -- j1</code>');
    expect(sent[0]).toContain('&lt;b&gt;Dev&lt;/b&gt; &amp; Co at Acme');
    expect(sent[0]).not.toContain('<b>Dev');
  });

  it('handoff reminder: bullets under a bold window title, text escaped', () => {
    const T0 = Date.parse('2026-11-04T12:00:00.000Z');
    const text = composeReminder([{ id: 'h1', window: 'mail', what: '<b>x</b> & y', why: 'cap', since: new Date(T0 - 3600_000).toISOString() }], T0);
    expect(text).toBe('🔔 <b>Handoff: 1 pending item need attention</b>\n<b>mail:</b>\n• &lt;b&gt;x&lt;/b&gt; &amp; y (cap) <i>[h1, 1h 0m]</i>\nList: <code>npx tsx scripts/handoff.ts list</code>'.replace('item need', 'item need'));
  });

  it('escalation digest: owner addresses in a reply text stay in full, hostile text is escaped', async () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO escalations (platform, reason, detail, created_at) VALUES ('linkedin', 'linkedin_reply_needed', ?, ?)").run('mail me at jane.doe@acme.example <b>now</b>', '2026-11-04T11:00:00.000Z');
    const sent: string[] = [];
    await runEscalationDigest(db, { send: async (t) => { sent.push(t); return { ok: true }; }, now: new Date('2026-11-04T12:00:00.000Z'), url: 'http://127.0.0.1:8787/#/inbox' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('jane.doe@acme.example');
    expect(sent[0]).toContain('&lt;b&gt;now&lt;/b&gt;');
    expect(sent[0]).toContain('<a href="http://127.0.0.1:8787/#/inbox">http://127.0.0.1:8787/#/inbox</a>');
    expect(sent[0]).toContain('<code>/escalations</code>');
    expect(sent[0]!.length).toBeLessThanOrEqual(3500);
    expect(balanced(sent[0]!)).toBe(true);
  });
});
