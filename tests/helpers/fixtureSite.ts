// Hermetic fixture "site": turns an invented HTML fixture into the same RawFormSnapshot the in-page
// script produces, using the dependency-free parser (no browser).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseHtml, findAll, textOf, visibleText, type HtmlNode } from '../../src/linkedin/htmlVisible.js';
import type { RawField, RawFormSnapshot } from '../../src/webcore/formModel.js';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'web');

export function fixtureHtml(name: string): string {
  return readFileSync(join(DIR, name), 'utf8');
}

const rawText = (n: HtmlNode): string => (n.tag === '#text' ? n.text ?? '' : n.children.map(rawText).join(' '));
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export function snapshotFromHtml(html: string, url = 'https://jobs.example.test/apply'): RawFormSnapshot {
  const root = parseHtml(html);
  const all = (pred: (n: HtmlNode) => boolean) => findAll(root, pred);
  const labels = all((n) => n.tag === 'label');
  const labelOf = (inp: HtmlNode): string => {
    const id = inp.attrs['id'];
    if (id) {
      const l = labels.find((x) => x.attrs['for'] === id);
      if (l) return squash(rawText(l));
    }
    const wrap = labels.find((l) => findAll(l, (c) => c === inp).length > 0);
    if (wrap) return squash(wrap.children.filter((c) => c !== inp && c.tag !== 'input' && c.tag !== 'select').map((c) => (c.tag === '#text' ? c.text ?? '' : textOf(c))).join(' '));
    return squash(inp.attrs['aria-label'] ?? inp.attrs['placeholder'] ?? inp.attrs['name'] ?? '');
  };
  const fields: RawField[] = [];
  for (const n of all((x) => x.tag === 'input' || x.tag === 'select' || x.tag === 'textarea')) {
    const type = n.tag === 'input' ? (n.attrs['type'] ?? 'text').toLowerCase() : n.tag;
    if (['submit', 'button', 'image', 'reset'].includes(type)) continue;
    const f: RawField = {
      type, name: n.attrs['name'] ?? '', id: n.attrs['id'], label: labelOf(n), required: 'required' in n.attrs,
      filled: type === 'checkbox' || type === 'radio' ? false : (n.attrs['value'] ?? '') !== '',
      hidden: n.hidden, autocomplete: n.attrs['autocomplete'],
    };
    if (type === 'checkbox') f.checked = 'checked' in n.attrs;
    if (type === 'select') f.options = all((o) => o.tag === 'option' && n.children.includes(o)).map((o) => squash(textOf(o)));
    fields.push(f);
  }
  const controls = all((n) => (n.tag === 'button' || n.tag === 'a') && !n.hidden)
    .map((n) => ({ tag: n.tag, label: squash(textOf(n)) })).filter((c) => c.label);
  const titleNode = all((n) => n.tag === 'title')[0];
  const captchaWidget = all((n) => !n.hidden && /\b(g-recaptcha|h-captcha|cf-turnstile)\b/.test(n.attrs['class'] ?? '')).length > 0;
  return {
    url, title: titleNode ? squash(titleNode.children.map((c) => c.text ?? '').join('')) : '',
    text: visibleText(root), fields, controls, notices: [], captchaWidget,
  };
}

export function loadFixture(name: string, url?: string): RawFormSnapshot {
  return snapshotFromHtml(fixtureHtml(name), url);
}
