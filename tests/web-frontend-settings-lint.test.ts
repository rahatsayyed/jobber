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

  it('environment editor: secret input is password, no autofill, never rendered from state', () => {
    const t = read('views', 'settings-env.js');
    expect(t).toContain("type: 'password'");
    expect(t).toMatch(/\.autocomplete = 'new-password'/);
    expect(t).toMatch(/\.spellcheck = false/);
    // no secret value reaches a value attribute, text node or URL: the secret path never reads state.value
    expect(t).toMatch(/if \(isSecretSpec\(spec\)\) return '';/);
    expect(t).not.toMatch(/value:\s*(s|st|staged\.get\([^)]*\))\.value/);
    expect(t).not.toMatch(/location\.(hash|search)\s*=[^;]*value/);
    // the API base comes from api.js (two pieces), never spelled out here
    expect(t).toContain('SETTINGS_API');
    expect(t).toContain('Type ${fr.phrase} to confirm');
    expect(t).toContain('Needs a fresh sign-in');
    expect(t).toContain('The file changed on disk since you opened this page.');
    expect(t).toContain("role: 'status'");
    expect(t).toContain('aria-live');
  });

  it('files editor and backups views: two-piece API use, accessible status, wired into the shell', () => {
    for (const f of ['settings-files.js', 'settings-backups.js']) {
      expect(settingsFiles).toContain(f);
      const t = read('views', f);
      expect(t).toContain('SETTINGS_API');
      expect(t.includes('/api/' + 'settings'), f).toBe(false);
      expect(t).toContain("role: 'status'");
      expect(t).toContain('aria-live');
      expect(/\.(href|src)\s*=/.test(t), f).toBe(false);
    }
    const files = read('views', 'settings-files.js');
    expect(files).toContain('Form');
    expect(files).toContain('Raw JSON');
    expect(read('views', 'settings-diff.js')).toContain('The file changed on disk since you opened this page.');
    expect(files).toMatch(/\.spellcheck = false/);
    const settings = read('views', 'settings.js');
    expect(settings).toContain('renderFiles');
    expect(settings).toContain('renderBackups');
    const backups = read('views', 'settings-backups.js');
    expect(backups).toContain('Compare with current');
    expect(backups).toContain('Restore');
    expect(backups).toContain('/rollback/preview');
    expect(backups).toContain('/rollback/apply');
    expect(backups).toContain('frictionControls');
    expect(read('views', 'settings-diff.js')).toContain('Type ${fr.phrase} to confirm');
  });

  it('css gives the banner distinct border styles and 44px targets', () => {
    const c = read('style.css');
    expect(c).toContain('#banner');
    expect(c).toMatch(/banner-dry[^}]*dashed/);
    expect(c).toMatch(/banner-live[^}]*double/);
    expect(c).toContain('min-height: 44px');
  });
});
