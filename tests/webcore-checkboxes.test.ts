import { describe, it, expect } from 'vitest';
import { classifyCheckbox } from '../src/webcore/checkboxes.js';

describe('classifyCheckbox', () => {
  const rows: [string, boolean, string][] = [
    ['Send me promotional emails', false, 'marketing'],
    ['Subscribe to our newsletter', false, 'marketing'],
    ['Receive job alerts', false, 'marketing'],
    ['Stay in touch with updates and news', false, 'marketing'],
    ['I receive emails from our partners', false, 'marketing'],
    ['I acknowledge the Privacy Notice', true, 'legal_required'],
    ['I agree to the Terms of Use', true, 'legal_required'],
    ['I agree to the processing of my data', true, 'legal_required'],
    ['I acknowledge the Privacy Notice', false, 'other'],
    ['I agree to the privacy policy and to receive marketing offers', false, 'marketing'],
    ['I agree to the privacy policy and to receive marketing offers', true, 'legal_required'],
    ['I certify that my answers are true and complete', true, 'attestation'],
    ['I consent to a background check', false, 'attestation'],
    ['I authorize you to verify my employment', false, 'attestation'],
    ['Share my details with partners', false, 'third_party_sharing'],
    ['Share my profile with third parties', false, 'third_party_sharing'],
    ['Remember me', false, 'other'],
  ];
  for (const [label, req, want] of rows) {
    it(`${want}: ${label} (required=${req})`, () => {
      expect(classifyCheckbox(label, req)).toBe(want);
    });
  }
});
