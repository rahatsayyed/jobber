import { describe, it, expect } from 'vitest';
import { htmlToLines, htmlToText } from '../src/htmlText.js';
import { LANGUAGES } from '../src/languages.js';

describe('htmlToText / htmlToLines', () => {
  it('drops scripts/styles/tags and decodes named entities', () => {
    expect(htmlToText('<style>x{}</style><script>a()</script><h1>Dev &amp; Ops</h1><p>Apply&nbsp;now &lt;3</p>')).toBe('Dev & Ops Apply now <3');
  });
  it('decodes decimal and hex numeric entities, ampersand last', () => {
    expect(htmlToText('We&#8217;re hiring &#x2014; React &amp;lt; Vue &#39;ok&#39;')).toBe('We’re hiring — React &lt; Vue \'ok\'');
    expect(htmlToText('bad &#99999999; entity')).toBe('bad &#99999999; entity');
    expect(htmlToText('<p>Bilingual &mdash; English&hellip;</p>')).toBe('Bilingual — English...');
  });
  it('keeps list items and line breaks as separate lines', () => {
    expect(htmlToLines('<ul><li>React</li><li>German customers must be served</li></ul>Line one<br>Line two<p>Para</p>').split('\n').filter(Boolean))
      .toEqual(['React', 'German customers must be served', 'Line one', 'Line two', 'Para']);
  });
  it('plain text passes through and the language list is exported', () => {
    expect(htmlToText('a < b and c > d')).toBe('a < b and c > d');
    expect(LANGUAGES).toEqual(expect.arrayContaining(['English', 'Hindi', 'German']));
  });
});
