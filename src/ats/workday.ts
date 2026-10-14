import type { FieldMap } from './types.js';
import { hostMatches } from '../lib/hostClass.js';

const PLATFORM = 'workday';

export function detect(url: string): string | null {
  return hostMatches(url, 'myworkdayjobs.com') ? PLATFORM : null;
}

export const fieldMap: FieldMap = {
  // Workday's application form also splits legal name into separate first/last
  // inputs (data-automation-id="legalNameSection_firstName"/"legalNameSection_lastName").
  name: '[data-automation-id="legalNameSection_firstName"]',
  firstName: '[data-automation-id="legalNameSection_firstName"]',
  lastName: '[data-automation-id="legalNameSection_lastName"]',
  email: '[data-automation-id="email"]',
  phone: '[data-automation-id="phone-number"]',
  resumeUpload: '[data-automation-id="file-upload-input-ref"]',
  coverLetter: '[data-automation-id="coverLetter"]',
  submitButton: '[data-automation-id="bottom-navigation-next-button"]',
};
