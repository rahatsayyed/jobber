import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd(), 'src', 'web', 'static');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const settingsFiles = readdirSync(join(ROOT, 'views')).filter((f) => /^settings.*\.js$/.test(f));
const SINKS = ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function'];

describe('settings frontend lint', () => {
  it('has a settings view and nav entry', () => {
    expect(settingsFiles).toContain('settings.js');
    expect(read('app.js')).toContain("['settings', 'Settings', settings]");
  });

  it('settings views and app.js use no forbidden sink', () => {
    const targets = [...settingsFiles.map((f) => read('views', f)), read('app.js')];
    for (const t of targets) for (const s of SINKS) expect(t.includes(s), s).toBe(false);
  });

  it('settings views never touch browser storage', () => {
    for (const f of settingsFiles) expect(/localStorage|sessionStorage/.test(read('views', f)), f).toBe(false);
  });

  it('banner element is outside the view root and is a polite status region', () => {
    const html = read('index.html');
    const bannerAt = html.indexOf('id="banner"');
    expect(bannerAt).toBeGreaterThan(-1);
    expect(html.slice(bannerAt, html.indexOf('>', bannerAt))).toMatch(/role="status"/);
    expect(html.slice(bannerAt, html.indexOf('>', bannerAt))).toMatch(/aria-live="polite"/);
    // the banner tag closes before #app opens, so it is not inside it
    expect(html.indexOf('</div>', bannerAt)).toBeLessThan(html.indexOf('id="app"'));
    const app = read('app.js');
    expect(app).toContain("getElementById('banner')");
    expect(app).toContain('60000');
    expect(app).toContain('clearInterval(bannerTimer)');
    expect(app).not.toMatch(/clear\(banner\)[\s\S]{0,20}root/);
    expect(app).toContain('DRY RUN');
    expect(app).toContain('LIVE');
  });

  it('api.js builds the settings base from two pieces and exposes the helpers', () => {
    const api = read('api.js');
    expect(api).toMatch(/export const SETTINGS_API = '\/api\/' \+ '[a-z]+'/);
    expect(api).toMatch(/export function getSettingsMeta/);
    expect(api).toMatch(/export function postSettings/);
    expect(api).not.toContain('no-cors');
  });

  it('settings view shows the exact read-only text and gates on editEnabled', () => {
    const t = read('views', 'settings.js');
    expect(t).toContain('Read only. To enable editing set WEB_SETTINGS_EDIT=true in .env and restart the dashboard.');
    expect(t).toContain('editEnabled');
    for (const tab of ['Environment', 'Files', 'Backups']) expect(t).toContain(tab);
  });

  it('every input created in settings views has a label association', () => {
    for (const f of settingsFiles) {
      const t = read('views', f);
      const inputs = (t.match(/el\('(input|textarea|select)'/g) || []).length;
      if (inputs === 0) continue;
      const labelled = (t.match(/'for':|\bfor:|aria-label|aria-labelledby/g) || []).length;
      expect(labelled, f).toBeGreaterThanOrEqual(inputs);
    }
  });

  it('css gives the banner distinct border styles and 44px targets', () => {
    const c = read('style.css');
    expect(c).toContain('#banner');
    expect(c).toMatch(/banner-dry[^}]*dashed/);
    expect(c).toMatch(/banner-live[^}]*double/);
    expect(c).toContain('min-height: 44px');
  });
});
