// Shared in-page snapshot for the scout (plan 8G task 7): visible anchors with their nearest block
// context. Parsing is code (serp.ts, extract.ts); the page only reports raw anchors and text.
// Arrow functions only: no nested named function declarations (a bundler's __name helper does not exist in the page).
export interface RawAnchor { href: string; text: string; context: string }
export interface RawAnchorPage { url: string; title: string; text: string; captchaWidget?: boolean; anchors: RawAnchor[] }

export const ANCHORS_SCRIPT = `(() => {
  const vis = (e) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0 && r.width > 1 && r.height > 1; };
  const squash = (t) => (t || '').replace(/\\s+/g, ' ').trim();
  const ctxOf = (a) => { let n = a.parentElement; for (let i = 0; i < 4 && n && n.tagName !== 'BODY'; i++) { const t = squash(n.innerText); if (t.length > squash(a.innerText).length + 12) return t.slice(0, 500); n = n.parentElement; } return ''; };
  const anchors = Array.from(document.querySelectorAll('a[href]')).filter(vis).slice(0, 400).map((a) => ({ href: a.href, text: squash(a.innerText || a.getAttribute('aria-label') || '').slice(0, 300), context: ctxOf(a) }));
  const captchaWidget = !!document.querySelector('.g-recaptcha,.h-captcha,.cf-turnstile,iframe[src*=recaptcha],iframe[src*=hcaptcha],iframe[src*=turnstile]');
  return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 20000), captchaWidget, anchors };
})()`;

/** Page HTML for a captured fixture: no scripts, no hidden inputs, no input values. */
export const FIXTURE_HTML_SCRIPT = `(() => {
  const c = document.documentElement.cloneNode(true);
  c.querySelectorAll('script,style,noscript,iframe,svg,input[type=hidden]').forEach((e) => e.remove());
  c.querySelectorAll('input,textarea').forEach((e) => { e.removeAttribute('value'); });
  return c.outerHTML.slice(0, 1000000);
})()`;
