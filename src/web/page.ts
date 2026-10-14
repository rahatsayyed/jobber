// src/web/page.ts
// One HTML string. The script is static (no data is interpolated into it) and renders only with textContent.

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#15171a;--card:#fff;--line:#d9dde3;--mute:#5d6672;--acc:#2757d6;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#111316;--fg:#e8eaed;--card:#1b1e22;--line:#2d3238;--mute:#9aa3ad;--acc:#7aa2ff;--bad:#ff8a80}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:12px 16px 32px}
h1{font-size:18px;margin:8px 0 12px}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--mute);margin:0 0 8px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:0 0 12px}
ul{margin:0;padding-left:18px}
.bad{color:var(--bad)}
.mute{color:var(--mute)}
pre{margin:0;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;max-height:50vh;overflow:auto}
form.row{display:flex;gap:8px}
input[type=text],input[type=password]{flex:1;min-width:0;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
button{padding:10px 16px;border:0;border-radius:8px;background:var(--acc);color:#fff;font:inherit;cursor:pointer}
`;

const SCRIPT = `
(function () {
  'use strict';
  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text !== undefined) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  }
  function fill(id, nodes) {
    var box = document.getElementById(id);
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!nodes.length) nodes = [el('p', 'nothing to show', 'mute')];
    var ul = el('ul');
    nodes.forEach(function (n) { ul.appendChild(n); });
    box.appendChild(ul);
  }
  function li(text, cls) { return el('li', text, cls); }
  function render(s) {
    var lim = [];
    Object.keys(s.ceilings || {}).forEach(function (k) {
      var c = s.ceilings[k];
      lim.push(li(k + ': ' + c.used + ' / ' + c.limit + (c.ok ? '' : ' (at ceiling)'), c.ok ? '' : 'bad'));
    });
    (s.dailyCounters || []).forEach(function (c) { lim.push(li(c.key + ': ' + c.count)); });
    fill('limits', lim);

    var work = [];
    (s.queue || []).forEach(function (q) { work.push(li('queue ' + q.status + ': ' + q.count)); });
    (s.halts || []).forEach(function (h) { work.push(li('HALT ' + h.platform + ': ' + h.reason + ' (' + h.setAt + ')', 'bad')); });
    var f = s.funnel;
    if (f) work.push(li('funnel: discovered ' + f.discovered + ', matched ' + f.matched + ', contacted ' + f.contacted + ', replied ' + f.replied + ', interview ' + f.interview + ', offer ' + f.offer));
    if (s.lastSend) work.push(li('last send: ' + s.lastSend.kind + ' at ' + s.lastSend.at));
    fill('working', work);

    var health = [li('snapshot: ' + s.generatedAt)];
    var d = s.degraded || [];
    if (d.length) health.push(li('degraded (table missing): ' + d.join(', '), 'bad'));
    else health.push(li('all sections readable'));
    fill('health', health);
  }
  function getJson(url) {
    return fetch(url, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) {
      if (r.status === 401) { location.reload(); throw new Error('auth'); }
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  }
  function refresh() {
    getJson('/api/status').then(render).catch(function () {
      fill('health', [li('status unavailable', 'bad')]);
    });
    getJson('/api/pane').then(function (p) {
      document.getElementById('pane').textContent = p.text;
    }).catch(function () {
      document.getElementById('pane').textContent = '(pane unavailable)';
    });
  }
  var note = document.getElementById('sendnote');
  document.getElementById('sendform').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var box = document.getElementById('msg');
    var text = box.value;
    if (!text) return;
    note.textContent = 'sending...';
    fetch('/api/send', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text })
    }).then(function (r) {
      if (r.ok) { box.value = ''; note.textContent = 'sent'; refresh(); }
      else if (r.status === 429) note.textContent = 'too fast, wait 2 seconds';
      else if (r.status === 400) note.textContent = 'rejected: text not allowed';
      else note.textContent = 'failed (' + r.status + ')';
    }).catch(function () { note.textContent = 'failed'; });
  });
  refresh();
  setInterval(refresh, 5000);
})();
`;

export function renderPage(opts: { nonce: string; authenticated: boolean }): string {
  const head =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Jobber status</title><style>' +
    STYLE +
    '</style></head><body><main>';
  if (!opts.authenticated) {
    return (
      head +
      '<h1>Jobber</h1><section><h2>Sign in</h2>' +
      '<form class="row" method="post" action="/login">' +
      '<input type="password" name="token" autocomplete="current-password" placeholder="access token" required>' +
      '<button type="submit">Sign in</button></form></section></main></body></html>'
    );
  }
  return (
    head +
    '<h1>Jobber</h1>' +
    '<section><h2>Limits</h2><div id="limits"><p class="mute">loading</p></div></section>' +
    '<section><h2>Working</h2><div id="working"><p class="mute">loading</p></div></section>' +
    '<section><h2>Health</h2><div id="health"><p class="mute">loading</p></div></section>' +
    '<section><h2>Live pane</h2><pre id="pane">loading</pre></section>' +
    '<section><h2>Send</h2><form class="row" id="sendform">' +
    '<input type="text" id="msg" maxlength="2000" autocomplete="off" placeholder="message or /limits">' +
    '<button type="submit">Send</button></form><p class="mute" id="sendnote"></p></section>' +
    `</main><script nonce="${opts.nonce}">${SCRIPT}</script></body></html>`
  );
}
