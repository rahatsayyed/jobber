import type { FieldMap } from './types.js';
import { hostMatches } from '../lib/hostClass.js';

const PLATFORM = 'ashby';

export function detect(url: string): string | null {
  return hostMatches(url, 'ashbyhq.com') ? PLATFORM : null;
}

export const fieldMap: FieldMap = {
  name: 'input[id^="_systemfield_name"]',
  email: 'input[id^="_systemfield_email"]',
  phone: 'input[id^="_systemfield_phone"]',
  resumeUpload: 'input[type="file"]',
  coverLetter: 'textarea[name="coverLetter"]',
  submitButton: 'button[type="submit"]',
};
