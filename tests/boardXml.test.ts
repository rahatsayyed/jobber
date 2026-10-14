import { describe, it, expect } from 'vitest';
import { parseXml, childOf, childrenOf, descendantsOf, textOf, MAX_XML_DEPTH, MAX_XML_NODES } from '../src/sources/boards/xml.js';

describe('parseXml', () => {
  it('parses nested elements, skips declaration and comments, ignores attributes', () => {
    const root = parseXml('<?xml version="1.0" encoding="UTF-8"?><!-- c --><rss version="2.0"><channel><item id="1" a=">"><title>Acme: Dev</title><link>https://x.test/1</link></item><item/></channel></rss>');
    const items = childrenOf(childOf(childOf(root, 'rss'), 'channel'), 'item');
    expect(items).toHaveLength(2);
    expect(textOf(items[0], 'title')).toBe('Acme: Dev');
    expect(textOf(items[0], 'link')).toBe('https://x.test/1');
    expect(items[1].children).toEqual([]);
  });
  it('decodes entities exactly once and keeps CDATA raw', () => {
    const root = parseXml('<a><b>Tom &amp;amp; Jerry &lt;3 &#8211; &uuml;</b><c><![CDATA[<p>Hi &amp; bye</p>]]></c><d>&lt;p&gt;x&lt;/p&gt;</d></a>');
    const a = childOf(root, 'a');
    expect(textOf(a, 'b')).toBe('Tom &amp; Jerry <3 – &uuml;');
    expect(textOf(a, 'c')).toBe('<p>Hi &amp; bye</p>');
    expect(textOf(a, 'd')).toBe('<p>x</p>');
  });
  it('supports namespaced names and finds descendants in document order', () => {
    const root = parseXml('<r><x><tt:city>Oslo</tt:city></x><tt:city>Rome</tt:city><y><z><tt:city>Bonn</tt:city></z></y></r>');
    expect(descendantsOf(childOf(root, 'r'), 'tt:city').map((n) => n.text)).toEqual(['Oslo', 'Rome', 'Bonn']);
  });
  it('rejects DOCTYPE, mismatched and unclosed input, bad tags and oversized shapes', () => {
    expect(() => parseXml('<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>')).toThrow('xml: DOCTYPE');
    expect(() => parseXml('<a><b></a></b>')).toThrow('xml: mismatched closing tag');
    expect(() => parseXml('<a><b>')).toThrow('xml: unclosed element');
    expect(() => parseXml('<a>x < y</a>')).toThrow('xml: malformed tag');
    expect(() => parseXml('<a><!-- nope</a>')).toThrow('xml: unterminated comment');
    expect(() => parseXml('<a><![CDATA[ nope</a>')).toThrow('xml: unterminated CDATA');
    expect(() => parseXml('<a ')).toThrow('xml: unterminated tag');
    expect(() => parseXml('<a>'.repeat(MAX_XML_DEPTH + 2))).toThrow('xml: nesting too deep');
    expect(() => parseXml(`<a>${'<b/>'.repeat(MAX_XML_NODES + 1)}</a>`)).toThrow('xml: too many elements');
  });
  it('is linear on hostile input (many unterminated openers, long runs)', () => {
    const t0 = Date.now();
    expect(() => parseXml('<'.repeat(200000))).toThrow();
    expect(() => parseXml('<a>' + '<b '.repeat(60000))).toThrow();
    expect(() => parseXml('<a>' + '&amp;'.repeat(500000) + '</a>')).not.toThrow();
    expect(() => parseXml('<a>' + '<![CDATA['.repeat(50000))).toThrow();
    expect(Date.now() - t0).toBeLessThan(3000);
  });
  it('tolerates empty and junk input', () => {
    expect(parseXml('').children).toEqual([]);
    expect(parseXml('just text').children).toEqual([]);
    expect(textOf(undefined, 'x')).toBe('');
  });
});
