import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { APPLIER_TOOL_SCHEMAS } from '../src/applier/tools/index.js';
import { checkRoleRef, DECLINE_RE, yesNoOption } from '../src/applier/refs.js';
import { findPreparedResumePath } from '../src/applier/resume.js';
import { openDb } from '../src/db.js';

interface Node { type?: string; properties?: Record<string, Node>; items?: Node; anyOf?: Node[]; oneOf?: Node[]; enum?: unknown[]; const?: unknown; pattern?: string; maxLength?: number }

const ALLOWED_PROPS = new Set([
  'job_id', 'field', 'ref', 'kind', 'key', 'option', 'control',
  'recipe', 'schema', 'id', 'platform', 'steps', 'confirmation', 'match', 'roles', 'minFields', 'fields', 'role', 'selector', 'type',
  'required', 'next', 'submit', 'urlPath', 'roles_absent',
]);
const BANNED = /^(value|text|answer|content|body|message|password|secret|cover_letter_text|free_text|input|fill|typed)$/i;

function walk(n: Node, name: string, out: Array<{ name: string; node: Node }>): void {
  if (n.type === 'string' || n.enum || n.const !== undefined) out.push({ name, node: n });
  for (const [k, v] of Object.entries(n.properties ?? {})) walk(v, k, out);
  if (n.items) walk(n.items, name, out);
  for (const v of [...(n.anyOf ?? []), ...(n.oneOf ?? [])]) walk(v, name, out);
}

describe('tool input schemas', () => {
  it('tool schemas contain no free value or text property', () => {
    expect(Object.keys(APPLIER_TOOL_SCHEMAS).sort()).toEqual(['apply_autofill', 'apply_choose', 'apply_fill', 'apply_next', 'apply_open', 'apply_propose_recipe', 'apply_recipe', 'apply_state', 'apply_submit', 'apply_upload']);
    for (const [tool, schema] of Object.entries(APPLIER_TOOL_SCHEMAS)) {
      const json = z.toJSONSchema(schema) as Node;
      const strings: Array<{ name: string; node: Node }> = [];
      walk(json, '', strings);
      const names = new Set<string>();
      const collect = (n: Node): void => {
        for (const [k, v] of Object.entries(n.properties ?? {})) { names.add(k); collect(v); }
        if (n.items) collect(n.items);
        for (const v of [...(n.anyOf ?? []), ...(n.oneOf ?? [])]) collect(v);
      };
      collect(json);
      for (const n of names) {
        expect(BANNED.test(n), `${tool}.${n}`).toBe(false);
        expect(ALLOWED_PROPS.has(n), `${tool}.${n} not allowed`).toBe(true);
      }
      for (const { name, node } of strings) {
        const bounded = !!node.enum || node.const !== undefined || !!node.pattern || (node.maxLength !== undefined && node.maxLength <= 200);
        expect(bounded, `${tool}.${name} must be an enum, a pattern or a short bounded string`).toBe(true);
      }
    }
    // `option` (a label picked from the page's own list, checked in code) exists only on apply_choose.
    for (const [tool, schema] of Object.entries(APPLIER_TOOL_SCHEMAS)) {
      const has = JSON.stringify(z.toJSONSchema(schema)).includes('"option"');
      expect(has, tool).toBe(tool === 'apply_choose');
    }
  });

  it('rejects unknown properties and malformed ids', () => {
    expect(APPLIER_TOOL_SCHEMAS.apply_fill.safeParse({ field: 'f1', ref: { kind: 'resume_pdf' }, value: 'x' }).success).toBe(false);
    expect(APPLIER_TOOL_SCHEMAS.apply_fill.safeParse({ field: '#email', ref: { kind: 'profile', field: 'email' } }).success).toBe(false);
    expect(APPLIER_TOOL_SCHEMAS.apply_fill.safeParse({ field: 'f1', ref: { kind: 'profile', field: 'email' } }).success).toBe(true);
    expect(APPLIER_TOOL_SCHEMAS.apply_next.safeParse({ control: 'c2' }).success).toBe(true);
    expect(APPLIER_TOOL_SCHEMAS.apply_next.safeParse({ control: 'Next' }).success).toBe(false);
    expect(APPLIER_TOOL_SCHEMAS.apply_open.safeParse({ job_id: 'job-1', url: 'https://x.test' }).success).toBe(false);
  });
});

describe('role / ref compatibility', () => {
  it('role/ref mismatch refused', () => {
    expect(checkRoleRef('email', { kind: 'profile', field: 'email' })).toBe('ok');
    expect(checkRoleRef('email', { kind: 'profile', field: 'phone' })).toBe('mismatch');
    expect(checkRoleRef('name.first', { kind: 'profile', field: 'name.last' })).toBe('mismatch');
    expect(checkRoleRef('name.full', { kind: 'profile', field: 'name.full' })).toBe('ok');
    expect(checkRoleRef('phone', { kind: 'profile', field: 'phone' })).toBe('ok');
    expect(checkRoleRef('phone', { kind: 'answer', key: 'phone' })).toBe('ok');
    expect(checkRoleRef('phone', { kind: 'answer', key: 'years_experience' })).toBe('mismatch');
    expect(checkRoleRef('linkedin_url', { kind: 'answer', key: 'linkedin_profile_url' })).toBe('ok');
    expect(checkRoleRef('location', { kind: 'profile', field: 'location' })).toBe('ok');
    expect(checkRoleRef('location', { kind: 'profile', field: 'email' })).toBe('mismatch');
    expect(checkRoleRef('email', { kind: 'resume_pdf' })).toBe('mismatch');
    expect(checkRoleRef('resume', { kind: 'resume_pdf' })).toBe('ok');
    expect(checkRoleRef('resume', { kind: 'profile', field: 'email' })).toBe('mismatch');
    for (const role of ['eeo', 'consent', 'marketing', 'password', 'password_confirm', 'otp', 'unknown', 'cover_letter'] as const) {
      expect(checkRoleRef(role, { kind: 'profile', field: 'email' }), role).toBe('mismatch');
    }
  });

  it('yes/no mapping and the decline pattern', () => {
    expect(yesNoOption(true, ['Select', 'Yes', 'No'])).toBe('Yes');
    expect(yesNoOption(false, ['yes', 'NO'])).toBe('NO');
    expect(yesNoOption(true, ['Maybe', 'Sure'])).toBeNull();
    expect(DECLINE_RE.test('Decline to self-identify')).toBe(true);
    expect(DECLINE_RE.test('I prefer not to say')).toBe(true);
    expect(DECLINE_RE.test('Female')).toBe(false);
  });
});

describe('findPreparedResumePath', () => {
  it('reads outreach_queue and falls back to the legacy outreach table', () => {
    const db = openDb(':memory:');
    expect(findPreparedResumePath(db, 'none')).toBeUndefined();
    db.prepare("INSERT INTO outreach (job_id, contact_email, subject, body, resume_path) VALUES ('j','a@b.c','s','b','/tmp/legacy.pdf')").run();
    expect(findPreparedResumePath(db, 'j')).toBe('/tmp/legacy.pdf');
    db.prepare("INSERT INTO outreach_queue (job_id, resume_pdf_path, created_at) VALUES ('j','/tmp/queue.pdf','2999-01-01 00:00:00')").run();
    expect(findPreparedResumePath(db, 'j')).toBe('/tmp/queue.pdf');
  });
});
