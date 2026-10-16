// Form model (plan 8G task 5): pure extraction from a raw snapshot. The snapshot comes from the
// in-page script below (live) or from tests/helpers/fixtureSite.ts (hermetic fixtures).
import { classifyCheckbox } from './checkboxes.js';
import { detectBlock, type BlockKind } from './blocks.js';

export const FIELD_ROLES = [
  'name.first', 'name.last', 'name.full', 'email', 'phone', 'resume', 'cover_letter', 'linkedin_url', 'location',
  'question', 'eeo', 'consent', 'marketing', 'password', 'password_confirm', 'otp', 'unknown',
] as const;
export type FieldRole = (typeof FIELD_ROLES)[number];
export type ControlKind = 'next' | 'submit' | 'back' | 'save' | 'apply' | 'sign_in' | 'create_account' | 'other';
export type StepKind = 'landing' | 'listing' | 'signin' | 'account' | 'form' | 'review' | 'confirmation' | 'blocked' | 'unknown';

export interface RawField {
  type: string; // text|email|tel|password|file|select|textarea|checkbox|radio|...
  name: string;
  id?: string;
  label: string;
  required: boolean;
  filled: boolean; // whether a value is present; the value itself is never captured
  checked?: boolean;
  options?: string[];
  hidden: boolean;
  autocomplete?: string;
}
export interface RawControl { label: string; tag?: string }
export interface RawFormSnapshot {
  url: string;
  title: string;
  text: string;
  fields: RawField[];
  controls: RawControl[];
  notices: string[];
  captchaWidget?: boolean;
}

export interface FormField {
  id: string; role: FieldRole; label: string; type: string; required: boolean; filled: boolean;
  checked?: boolean; options?: string[]; hidden: boolean;
}
export interface FormControl { id: string; kind: ControlKind; label: string }
export interface FormModel {
  url: string; host: string; stepKind: StepKind; stepIndex: number | null; stepCount: number | null;
  fields: FormField[]; controls: FormControl[]; notices: string[]; block: BlockKind | null;
}

// In-page script (string constant, evaluated by the runtime). Arrow functions only: no nested named
// function declarations (a bundler's __name helper does not exist in the page).
export const FORM_SNAPSHOT_SCRIPT = `(() => {
  const vis = (e) => { const s = getComputedStyle(e); const r = e.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0 && r.width > 1 && r.height > 1 && r.left > -900 && r.top > -900; };
  const labelOf = (e) => { const d = e.ownerDocument; let t = ''; if (e.id) { const l = d.querySelector('label[for="' + CSS.escape(e.id) + '"]'); if (l) t = l.textContent; } if (!t) { const w = e.closest('label'); if (w) t = w.textContent; } if (!t) t = e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('name') || ''; return t.replace(/\\s+/g, ' ').trim().slice(0, 300); };
  const fields = []; const seen = new Set();
  for (const e of document.querySelectorAll('input,select,textarea')) {
    const type = e.tagName === 'SELECT' ? 'select' : e.tagName === 'TEXTAREA' ? 'textarea' : (e.getAttribute('type') || 'text').toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'image' || type === 'reset') continue;
    if (type === 'radio') { const k = e.name || e.id; if (seen.has(k)) continue; seen.add(k); }
    const f = { type, name: e.name || '', id: e.id || '', label: labelOf(e), required: e.required || e.getAttribute('aria-required') === 'true', filled: type === 'checkbox' || type === 'radio' ? false : (type === 'file' ? !!(e.files && e.files.length) : !!e.value), hidden: type === 'hidden' || !vis(e), autocomplete: e.getAttribute('autocomplete') || '' };
    if (type === 'checkbox') f.checked = e.checked;
    if (type === 'select') f.options = Array.from(e.options).map((o) => o.textContent.trim()).slice(0, 30);
    if (type === 'radio') { const g = Array.from(document.querySelectorAll('input[type=radio]')).filter((r) => r.name === e.name); f.options = g.map((r) => labelOf(r)).slice(0, 30); f.filled = g.some((r) => r.checked); }
    fields.push(f);
  }
  const controls = Array.from(document.querySelectorAll('button,input[type=submit],a[href],[role=button]')).filter(vis).map((e) => ({ tag: e.tagName.toLowerCase(), label: (e.textContent || e.value || e.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 120) })).filter((c) => c.label).slice(0, 60);
  const notices = Array.from(document.querySelectorAll('[role=alert],.error,.errors,[aria-invalid=true]')).filter(vis).map((e) => (e.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200)).filter(Boolean).slice(0, 10);
  const captchaWidget = !!document.querySelector('.g-recaptcha,.h-captcha,.cf-turnstile,iframe[src*=recaptcha],iframe[src*=hcaptcha],iframe[src*=turnstile]');
  return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : '').slice(0, 20000), fields, controls, notices, captchaWidget };
})()`;

const STEP_RE = /step\s+(\d+)\s+of\s+(\d+)/i;
const CONFIRM_RE = /thank you for applying|application (has been |was )?(submitted|received|sent)|we(?:'ve| have) received your application/i;
const REVIEW_RE = /review (your |and )?(application|submit)/i;
const EEO_RE = /gender|race|ethnic|veteran|disabilit|hispanic|latino|pronoun|sexual orientation|self-identify/i;

export function classifyControl(label: string): ControlKind {
  const l = label.trim();
  if (/^(submit|send)( application)?$/i.test(l) || /^submit application/i.test(l) || /^send application/i.test(l)) return 'submit';
  if (/create (an )?account|^register|^sign up/i.test(l)) return 'create_account';
  if (/^(sign|log) ?in/i.test(l)) return 'sign_in';
  if (/save and continue|^next\b|^continue\b/i.test(l)) return 'next';
  if (/^(back|previous)\b/i.test(l)) return 'back';
  if (/^save( draft| for later)?$/i.test(l)) return 'save';
  if (/^apply\b/i.test(l)) return 'apply';
  return 'other';
}

function roleOf(f: RawField): FieldRole {
  const label = f.label || '';
  const key = `${label} ${f.name}`;
  if (f.type === 'password') return /verify|confirm|re-?enter|repeat/i.test(key) ? 'password_confirm' : 'password';
  if (f.type === 'checkbox') {
    const c = classifyCheckbox(label, f.required);
    if (c === 'marketing') return 'marketing';
    return c === 'other' ? 'unknown' : 'consent';
  }
  if (f.type === 'file') return /cover/i.test(key) ? 'cover_letter' : 'resume';
  if (f.autocomplete === 'one-time-code' || /\b(otp|verification code|security code|enter code)\b/i.test(label)) return 'otp';
  if (f.type === 'email' || /e-?mail/i.test(key)) return 'email';
  if (f.type === 'tel' || /phone|mobile/i.test(key)) return 'phone';
  if (/linkedin/i.test(key)) return 'linkedin_url';
  if (EEO_RE.test(key)) return 'eeo';
  if (/first.?name|given name/i.test(key)) return 'name.first';
  if (/last.?name|surname|family name/i.test(key)) return 'name.last';
  if (/^\s*(full )?name\b|your name/i.test(label)) return 'name.full';
  if (/location|city|where .* (based|located)/i.test(key)) return 'location';
  if (f.type === 'textarea' || f.type === 'select' || f.type === 'radio' || label.includes('?')) return 'question';
  return 'unknown';
}

export function extractFormModel(raw: RawFormSnapshot): FormModel {
  let host = '';
  try { host = new URL(raw.url).hostname.toLowerCase(); } catch { /* keep empty */ }
  const fields: FormField[] = (raw.fields ?? []).map((f, i) => {
    const out: FormField = {
      id: `f${i + 1}`, role: roleOf(f), label: f.label ?? '', type: f.type, required: !!f.required,
      filled: !!f.filled, hidden: !!f.hidden,
    };
    if (f.checked !== undefined) out.checked = !!f.checked;
    if (f.options) out.options = f.options.slice(0, 30);
    return out;
  });
  const controls: FormControl[] = (raw.controls ?? []).map((c, i) => ({ id: `c${i + 1}`, kind: classifyControl(c.label), label: c.label }));
  const block = detectBlock(raw);
  const m = STEP_RE.exec(raw.text ?? '');
  const vis = fields.filter((f) => !f.hidden);
  const text = `${raw.title ?? ''}\n${raw.text ?? ''}`;
  const has = (k: ControlKind) => controls.some((c) => c.kind === k);
  let stepKind: StepKind = 'unknown';
  if (block) stepKind = 'blocked';
  else if (CONFIRM_RE.test(text) && !vis.some((f) => f.type !== 'checkbox')) stepKind = 'confirmation';
  else if (vis.some((f) => f.role === 'password_confirm') || (has('create_account') && !has('sign_in') && vis.some((f) => f.role === 'password'))) stepKind = 'account';
  else if (vis.some((f) => f.role === 'password')) stepKind = 'signin';
  else if (vis.length === 0 && controls.filter((c) => c.kind === 'apply').length >= 2) stepKind = 'listing';
  else if (vis.length === 0 && has('apply')) stepKind = 'landing';
  else if (REVIEW_RE.test(text) && vis.length === 0) stepKind = 'review';
  else if (vis.length > 0) stepKind = 'form';
  return {
    url: raw.url, host, stepKind, stepIndex: m ? Number(m[1]) : null, stepCount: m ? Number(m[2]) : null,
    fields, controls, notices: (raw.notices ?? []).slice(0, 10), block,
  };
}
