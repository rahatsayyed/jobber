import { describe, it, expect } from 'vitest';
import { htmlEscape, isParseError, markdownToHtml, markdownToHtmlChunks, plainChunks } from '../src/telegram/format.js';

describe('telegram format', () => {
  it('escapes html in plain text and never passes raw tags through', () => {
    expect(htmlEscape('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d');
    const out = markdownToHtml('Subject: <script>alert(1)</script> & <b>x</b>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<b>x</b>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&amp;');
  });

  it('converts bold, italic, inline code, links, headings, lists and quotes', () => {
    const out = markdownToHtml('## Title\n\n**bold** and *it* and `a<b` and [site](https://example.com/a?x=1&y=2)\n- one\n- two\n> quoted');
    expect(out).toContain('<b>Title</b>');
    expect(out).toContain('<b>bold</b>');
    expect(out).toContain('<i>it</i>');
    expect(out).toContain('<code>a&lt;b</code>');
    expect(out).toContain('<a href="https://example.com/a?x=1&amp;y=2">site</a>');
    expect(out).toContain('- one\n- two');
    expect(out).toContain('<blockquote>quoted</blockquote>');
  });

  it('does not touch emphasis markers inside code and keeps snake_case plain', () => {
    expect(markdownToHtml('`**not bold**` and snake_case_name')).toBe('<code>**not bold**</code> and snake_case_name');
  });

  it('refuses unsafe link urls (stays literal text)', () => {
    const out = markdownToHtml('[x](javascript:alert(1))');
    expect(out).not.toContain('<a ');
  });

  it('code blocks are escaped and wrapped in pre', () => {
    const out = markdownToHtml('before\n```ts\nconst a = "<x>" && 1;\n```\nafter');
    expect(out).toContain('<pre>const a = "&lt;x&gt;" &amp;&amp; 1;</pre>');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('chunks stay under the limit and every chunk has balanced tags', () => {
    const para = Array.from({ length: 80 }, (_, i) => `line ${i} **bold ${i}** and \`code ${i}\` & more text here`).join('\n');
    const code = '```\n' + Array.from({ length: 300 }, (_, i) => `row ${i} <tag> & value`).join('\n') + '\n```';
    const quote = Array.from({ length: 200 }, (_, i) => `> quoted ${i}`).join('\n');
    const chunks = markdownToHtmlChunks(`${para}\n\n${code}\n\n${quote}`, 1000);
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(1000);
      for (const tag of ['b', 'i', 'code', 'pre', 'blockquote', 'a']) {
        const open = (c.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;
        const close = (c.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
        expect(open, `${tag} in chunk`).toBe(close);
      }
      // no entity cut in half
      expect(c).not.toMatch(/&[a-z]*$/);
    }
  });

  it('a single very long line is split and stays under the limit', () => {
    const chunks = markdownToHtmlChunks('word '.repeat(5000) + '&'.repeat(3000), 4000);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
  });

  it('plain chunks and parse error detection', () => {
    expect(plainChunks('a\n'.repeat(1000), 300).every((c) => c.length <= 300)).toBe(true);
    expect(isParseError("Bad Request: can't parse entities: Unsupported start tag")).toBe(true);
    expect(isParseError('Bad Request: chat not found')).toBe(false);
  });
});
