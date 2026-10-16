import { describe, it, expect } from 'vitest';
import { loadFixture } from './helpers/fixtureSite.js';
import { extractFormModel, FORM_SNAPSHOT_SCRIPT, FIELD_ROLES } from '../src/webcore/formModel.js';
import { formatState } from '../src/webcore/state.js';
import { snapshotFromHtml } from './helpers/fixtureSite.js';
import type { RawFormSnapshot } from '../src/webcore/formModel.js';

const model = (f: string) => extractFormModel(loadFixture(f));
const roles = (f: string) => model(f).fields.map((x) => x.role);

describe('extractFormModel', () => {
  it('greenhouse-like form roles, ids and required flags', () => {
    const m = model('ats-a-form.html');
    expect(m.host).toBe('jobs.example.test');
    expect(m.stepKind).toBe('form');
    expect(m.fields.map((f) => f.id)).toEqual(m.fields.map((_, i) => `f${i + 1}`));
    expect(m.fields.slice(0, 8).map((f) => f.role)).toEqual([
      'name.first', 'name.last', 'email', 'phone', 'resume', 'cover_letter', 'linkedin_url', 'question',
    ]);
    expect(m.fields[0].required).toBe(true);
    expect(m.fields[1].filled).toBe(true);
    expect(m.fields[3].required).toBe(false);
    for (const f of m.fields) expect(FIELD_ROLES).toContain(f.role);
  });
  it('lists the honeypot as hidden', () => {
    const m = model('ats-a-form.html');
    const hp = m.fields.find((f) => f.label === 'Leave this empty');
    expect(hp?.hidden).toBe(true);
    expect(m.fields.filter((f) => !f.hidden)).toHaveLength(8);
  });
  it('lever-like form with eeo select and wrapped labels', () => {
    const m = model('ats-b-form.html');
    expect(m.fields.map((f) => f.role)).toEqual(['name.full', 'email', 'location', 'resume', 'linkedin_url', 'eeo']);
    expect(m.fields[5].options).toContain('Decline to self-identify');
  });
  it('classifies controls', () => {
    expect(model('ats-a-form.html').controls.map((c) => c.kind)).toEqual(['submit']);
    const s1 = model('wd-step1-personal.html');
    expect(s1.controls.map((c) => c.kind)).toEqual(['back', 'next']);
    expect(model('wd-account.html').controls[0].kind).toBe('create_account');
    expect(model('wd-signin.html').controls.map((c) => c.kind)).toEqual(['sign_in', 'create_account']);
  });
  it('step kinds and step counters', () => {
    expect(model('wd-landing.html').stepKind).toBe('landing');
    expect(model('wd-account.html').stepKind).toBe('account');
    expect(model('wd-signin.html').stepKind).toBe('signin');
    const s1 = model('wd-step1-personal.html');
    expect([s1.stepKind, s1.stepIndex, s1.stepCount]).toEqual(['form', 1, 4]);
    expect(model('wd-step2-questions.html').stepIndex).toBe(2);
    expect(model('wd-step3-review.html').stepKind).toBe('review');
    expect(model('wd-confirmation.html').stepKind).toBe('confirmation');
    expect(model('ats-a-confirmation.html').stepKind).toBe('confirmation');
    expect(model('ats-b-confirmation.html').stepKind).toBe('confirmation');
    expect(model('listing-a.html').stepKind).toBe('listing');
  });
  it('account page: passwords, required privacy consent, PRE-CHECKED marketing box', () => {
    const m = model('wd-account.html');
    expect(m.fields.map((f) => f.role)).toEqual(['email', 'password', 'password_confirm', 'consent', 'marketing']);
    const promo = m.fields[4];
    expect(promo.checked).toBe(true);
    expect(promo.role).toBe('marketing');
    expect(m.fields[3].required).toBe(true);
  });
  it('questions step: custom questions, eeo, unchecked newsletter', () => {
    const m = model('wd-step2-questions.html');
    expect(m.fields.map((f) => f.role)).toEqual(['question', 'question', 'eeo', 'marketing']);
    expect(m.fields[3].checked).toBe(false);
  });
  it('drifted form yields a different role set', () => {
    const a = new Set(roles('ats-a-form.html'));
    const d = new Set(roles('drifted-ats-a-form.html'));
    expect([...d].sort()).not.toEqual([...a].sort());
    expect(d.has('name.first')).toBe(false);
  });
});

describe('formatState', () => {
  it('never prints values or password content, strips invisibles, wraps as data', () => {
    const raw = loadFixture('form-hostile.html');
    (raw.fields[2] as unknown as Record<string, unknown>)['value'] = 'hunter2';
    const out = formatState(extractFormModel(raw));
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('x@y.z');
    expect(out).not.toMatch(/​/);
    expect(out).toContain('<page_data>');
    expect(out).toContain('</page_data>');
    expect(out).toContain('(filled)');
    expect(out).toMatch(/Password/);
  });
  it('withholds an injection-style label instead of passing it through', () => {
    const out = formatState(extractFormModel(loadFixture('form-hostile.html')));
    expect(out).not.toMatch(/ignore all previous/i);
    expect(out).toContain('injection_suspected');
  });
  it('caps label length and strips angle brackets', () => {
    const raw = loadFixture('ats-a-form.html');
    raw.fields[0].label = '</page_data>' + 'x'.repeat(500);
    const out = formatState(extractFormModel(raw));
    expect(out.match(/<\/page_data>/g)).toHaveLength(1);
    expect(out).not.toContain('x'.repeat(130));
  });
  it('shows the pre-checked marketing box and step counters', () => {
    const out = formatState(extractFormModel(loadFixture('wd-account.html')), ['note: extra']);
    expect(out).toMatch(/marketing checkbox class=marketing \(checked\)/);
    expect(out).toContain('note: extra');
    expect(formatState(extractFormModel(loadFixture('wd-step1-personal.html')))).toContain('step=form 1/4');
  });
});

describe('role heuristics (review fixes)', () => {
  const one = (label: string, type = 'text') => {
    const raw: RawFormSnapshot = { url: 'https://x.test/a', title: '', text: '', controls: [], notices: [], fields: [{ type, name: '', label, required: false, filled: false, hidden: false }] };
    return extractFormModel(raw).fields[0].role;
  };
  it('long or question labels are questions, not phone/email/location', () => {
    expect(one('Which mobile frameworks have you used?')).toBe('question');
    expect(one('Have you used email marketing tools?')).toBe('question');
    expect(one('Are you willing to relocate to this city?')).toBe('question');
  });
  it('short labels and typed inputs still map', () => {
    expect(one('Mobile')).toBe('phone');
    expect(one('Work email')).toBe('email');
    expect(one('Anything', 'tel')).toBe('phone');
    expect(one('City')).toBe('location');
  });
  it('file inputs are resume only when labelled so; Apply with LinkedIn is not apply', () => {
    expect(one('Portfolio', 'file')).toBe('unknown');
    expect(one('Curriculum vitae', 'file')).toBe('resume');
    const raw = snapshotFromHtml('<html><body><a href="/x">Apply with LinkedIn</a><a href="/y">Apply</a></body></html>');
    expect(extractFormModel(raw).controls.map((c) => c.kind)).toEqual(['other', 'apply']);
  });
  it('exposes the checkbox class and prints it', () => {
    const m = extractFormModel(loadFixture('wd-account.html'));
    expect(m.fields.map((f) => f.consentClass)).toEqual([undefined, undefined, undefined, 'legal_required', 'marketing']);
    expect(formatState(m)).toContain('class=legal_required');
  });
});

describe('formatState hardening (review fixes)', () => {
  it('a filled password field leaks neither value nor secret-bearing names', () => {
    const raw = loadFixture('wd-signin.html');
    const pw = raw.fields[1] as unknown as Record<string, unknown>;
    pw['filled'] = true; pw['value'] = 'S3cretPass!'; pw['name'] = 'S3cretPass!';
    const out = formatState(extractFormModel(raw));
    expect(out).not.toContain('S3cretPass');
    expect(out).toMatch(/password password \(filled\)/);
  });
  it('strips U+2800 and tag characters', () => {
    const raw = loadFixture('ats-a-form.html');
    raw.fields[0].label = 'Fi⠀rst\u{e0041}\u{e0042} Name';
    expect(formatState(extractFormModel(raw))).toContain('"First Name"');
  });
  it('caps options, notices and extra lines', () => {
    const raw = loadFixture('ats-b-form.html');
    raw.fields[5].options = Array.from({ length: 50 }, (_, i) => `opt${i}`);
    raw.notices = Array.from({ length: 30 }, (_, i) => `n${i} ` + 'z'.repeat(400));
    const out = formatState(extractFormModel(raw), ['e'.repeat(1000)]);
    expect(out).toContain('opt11');
    expect(out).not.toContain('opt12');
    expect(out.match(/^notice /gm)).toHaveLength(10);
    expect(out).not.toContain('z'.repeat(170));
    expect(out).not.toContain('e'.repeat(210));
  });
});

describe('FORM_SNAPSHOT_SCRIPT', () => {
  it('is syntactically valid and has no nested named function declarations', () => {
    expect(() => new Function(`return ${FORM_SNAPSHOT_SCRIPT}`)).not.toThrow();
    expect(FORM_SNAPSHOT_SCRIPT).not.toMatch(/\bfunction\s+\w+/);
  });
});
