import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseHtml, visibleText, isHiddenByAttrs, findAll, textOf } from '../src/linkedin/htmlVisible.js';

const fx = (n: string) => readFileSync(new URL(`./fixtures/linkedin/${n}`, import.meta.url), 'utf8');
const vt = (h: string) => visibleText(parseHtml(h));

describe('visibleText', () => {
  it('keeps visible text and drops every hidden injection payload', () => {
    const t = visibleText(parseHtml(fx('profile-injection.html')));
    expect(t).toContain('Visible sentence that must survive.');
    expect(t).toContain('Jane Example');
    for (const leaked of ['Ignore all previous', 'admin mode', 'white on white', 'offscreen', 'aria hidden', 'hidden attr', 'attacker.test', 'opacity zero', 'secrets/'])
      expect(t.toLowerCase()).not.toContain(leaked.toLowerCase());
  });
  it('never throws on malformed markup', () => {
    expect(() => visibleText(parseHtml('<div><p>unclosed <b>bold <span style="display:none>x'))).not.toThrow();
    expect(() => visibleText(parseHtml(''))).not.toThrow();
    expect(() => visibleText(parseHtml('<<<>>></ / <a <b ="'))).not.toThrow();
  });
  it('isHiddenByAttrs covers the documented rules', () => {
    expect(isHiddenByAttrs('p', { style: 'display: none' })).toBe(true);
    expect(isHiddenByAttrs('p', { style: 'font-size:3px' })).toBe(true);
    expect(isHiddenByAttrs('p', { style: 'color:transparent' })).toBe(true);
    expect(isHiddenByAttrs('input', { type: 'hidden' })).toBe(true);
    expect(isHiddenByAttrs('p', { style: 'font-size:14px' })).toBe(false);
  });

  it('drops HTML comments', () => {
    const t = vt('<p>a<!-- secret instruction -->b</p><!-- unterminated');
    expect(t).toBe('ab');
  });
  it('hidden attribute and aria-hidden', () => {
    expect(vt('<p hidden>x1</p><p aria-hidden="true">x2</p><p aria-hidden="false">ok</p>')).toBe('ok');
  });
  it('hidden tags', () => {
    for (const tag of ['script', 'style', 'template', 'noscript', 'head', 'svg', 'iframe'])
      expect(vt(`<div>ok</div><${tag}>LEAK</${tag}>`), tag).toBe('ok');
    expect(vt('<script>var a="<p>LEAK</p>";</script>ok')).toBe('ok');
  });
  it('input type hidden', () => {
    expect(isHiddenByAttrs('input', { type: 'text' })).toBe(false);
    expect(vt('<div>ok</div><input type="hidden" value="LEAK">')).toBe('ok');
  });
  it.each([
    ['display:none'], ['display: none !important'], ['visibility:hidden'], ['visibility:collapse'],
    ['opacity:0'], ['opacity:0.0'], ['font-size:0'], ['font-size:0px'], ['font-size:5px'], ['font-size:0em'], ['font-size:0rem'], ['font-size:0%'],
    ['width:0;overflow:hidden'], ['height:0px;overflow:hidden'], ['overflow:hidden;height:0'],
    ['position:absolute;left:-999px'], ['position:fixed;top:-9999px'], ['position:absolute;left:-5000px;top:0'],
    ['text-indent:-999px'], ['text-indent:-9999px'],
    ['clip:rect(0,0,0,0)'], ['clip: rect(0px, 0px, 0px, 0px)'], ['clip-path:inset(100%)'],
    ['color:transparent'], ['color:#fff;background:#fff'], ['color:white;background-color:#ffffff'], ['color:#000;background:#000 none'],
    ['color: rgb(255, 255, 255); background: rgb(255,255,255)'],
  ])('style hides: %s', (style) => {
    expect(isHiddenByAttrs('p', { style })).toBe(true);
    expect(vt(`<p style="${style}">LEAK</p><p>ok</p>`)).toBe('ok');
  });
  it.each([
    ['font-size:6px'], ['font-size:1em'], ['opacity:0.5'], ['opacity:1'], ['display:block'],
    ['width:0'], ['height:0'], // zero size alone, without overflow:hidden, does not hide
    ['position:absolute;left:-10px'], ['position:relative;left:-9999px'], ['text-indent:-10px'],
    ['color:#fff;background:#000'], ['color:#111'], ['clip:auto'],
  ])('style keeps: %s', (style) => {
    expect(isHiddenByAttrs('p', { style })).toBe(false);
    expect(vt(`<p style="${style}">seen</p>`)).toBe('seen');
  });
  it('hidden is inherited by all descendants', () => {
    const root = parseHtml('<div style="opacity:0"><ul><li><span>deep</span></li></ul></div><p>ok</p>');
    expect(visibleText(root)).toBe('ok');
    const deep = findAll(root, (n) => n.tag === 'span');
    expect(deep).toHaveLength(1);
    expect(deep[0].hidden).toBe(true);
    expect(textOf(deep[0])).toBe('');
    expect(findAll(root, (n) => n.tag === 'p')[0].hidden).toBe(false);
  });
  it('a hidden parent hides a child that is itself unstyled or visible-styled', () => {
    expect(vt('<div hidden><p style="display:block">LEAK</p></div>')).toBe('');
  });
  it('block tags break lines, whitespace collapses, entities decode', () => {
    expect(vt('<div>one   two</div><p>three&nbsp;&amp;&#52;</p><span>a</span><span>b</span>')).toBe('one two\nthree &4\nab');
  });
  it('textOf returns one subtree', () => {
    const root = parseHtml('<h1>Jane</h1><p>Other</p>');
    expect(textOf(findAll(root, (n) => n.tag === 'h1')[0])).toBe('Jane');
  });
  it('does not strip zero-width characters', () => {
    expect(vt('<p>a​b</p>')).toBe('a​b');
  });
  it('caps input at 2 MB and depth at 200 without throwing, failing closed past the cap', () => {
    const big = '<p>ok</p>' + 'x'.repeat(2 * 1024 * 1024 + 10) + '<p>LATE</p>';
    expect(vt(big)).not.toContain('LATE');
    const deep = '<div>'.repeat(300) + 'TOODEEP' + '</div>'.repeat(300) + '<p>after</p>';
    const t = vt(deep);
    expect(t).not.toContain('TOODEEP');
    expect(t).toContain('after');
    const evil = '<'.repeat(5000) + 'a'.repeat(5000);
    expect(() => vt(evil)).not.toThrow();
  });
  it('fixtures: search results drop the hidden card', () => {
    const t = vt(fx('search-results.html'));
    expect(t).toContain('Alex Sample');
    expect(t).not.toContain('Hidden Person');
  });
  it('fixtures: connected profile, overlay, checkpoint, invitations', () => {
    expect(vt(fx('profile-connected.html'))).toContain('1st');
    expect(vt(fx('message-overlay.html'))).toContain('Hi, thanks for connecting.');
    expect(vt(fx('checkpoint.html'))).toContain('CAPTCHA');
    expect(vt(fx('invitations.html'))).toContain('Ignore');
    expect(vt(fx('profile-not-connected.html'))).not.toContain('LinkedIn'); // title lives in head
  });
});
