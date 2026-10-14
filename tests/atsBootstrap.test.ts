import { describe, it, expect, vi } from 'vitest';
import {
  bootstrapFieldMap,
  BOOTSTRAP_REQUIRED_FIELDS,
  UNRESOLVED_OPTIONAL_SELECTOR,
} from '../src/lib/atsBootstrap.js';
import type { FormControlSnapshot } from '../src/lib/domSnapshot.js';

const snapshot: FormControlSnapshot = {
  inputs: [
    { selector: '#full_name', type: 'text' },
    { selector: '#email_addr', type: 'email' },
    { selector: 'input[name="resume"]', type: 'file' },
    { selector: '#phone_num', type: 'tel' },
  ],
  buttons: [{ selector: '#submit_btn', text: 'Submit Application' }],
};

describe('bootstrapFieldMap', () => {
  it('returns a complete FieldMap when Claude resolves every required and optional field to real snapshot selectors', async () => {
    const runClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        fieldMap: {
          name: '#full_name',
          email: '#email_addr',
          resumeUpload: 'input[name="resume"]',
          submitButton: '#submit_btn',
          phone: '#phone_num',
        },
      })
    );

    const result = await bootstrapFieldMap(snapshot, { runClaude });

    expect(result).toEqual({
      fieldMap: {
        name: '#full_name',
        email: '#email_addr',
        resumeUpload: 'input[name="resume"]',
        submitButton: '#submit_btn',
        phone: '#phone_num',
        coverLetter: UNRESOLVED_OPTIONAL_SELECTOR,
      },
    });
  });

  it('fills an unresolved optional field (coverLetter) with UNRESOLVED_OPTIONAL_SELECTOR instead of failing', async () => {
    const runClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        fieldMap: {
          name: '#full_name',
          email: '#email_addr',
          resumeUpload: 'input[name="resume"]',
          submitButton: '#submit_btn',
        },
      })
    );

    const result = await bootstrapFieldMap(snapshot, { runClaude });

    expect('fieldMap' in result).toBe(true);
    if ('fieldMap' in result) {
      expect(result.fieldMap.phone).toBe(UNRESOLVED_OPTIONAL_SELECTOR);
      expect(result.fieldMap.coverLetter).toBe(UNRESOLVED_OPTIONAL_SELECTOR);
    }
  });

  it('rejects a required-field selector Claude invented that is not actually in the snapshot (never-invent enforcement)', async () => {
    const runClaude = vi.fn().mockResolvedValue(
      JSON.stringify({
        fieldMap: {
          name: '#full_name',
          email: '#a-selector-that-does-not-exist',
          resumeUpload: 'input[name="resume"]',
          submitButton: '#submit_btn',
        },
      })
    );

    const result = await bootstrapFieldMap(snapshot, { runClaude });

    expect(result).toEqual({ missing: ['email'] });
  });

  it('returns the explicit missing list Claude reports when it cannot resolve a required field itself', async () => {
    const runClaude = vi
      .fn()
      .mockResolvedValue(JSON.stringify({ fieldMap: null, missing: ['resumeUpload'] }));

    const result = await bootstrapFieldMap(snapshot, { runClaude });

    expect(result).toEqual({ missing: ['resumeUpload'] });
  });

  it('falls back to the full required-field list as "missing" when the CLI call itself fails', async () => {
    const runClaude = vi.fn().mockResolvedValue(null);

    const result = await bootstrapFieldMap(snapshot, { runClaude });

    expect(result).toEqual({ missing: [...BOOTSTRAP_REQUIRED_FIELDS] });
  });

  it('falls back to the full required-field list as "missing" when the CLI returns unparseable output', async () => {
    const runClaude = vi.fn().mockResolvedValue('not json at all');

    const result = await bootstrapFieldMap(snapshot, { runClaude });

    expect(result).toEqual({ missing: [...BOOTSTRAP_REQUIRED_FIELDS] });
  });
});
