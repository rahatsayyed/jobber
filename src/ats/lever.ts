import type { FieldMap } from './types.js';
import { hostMatches } from '../lib/hostClass.js';

const PLATFORM = 'lever';

export function detect(url: string): string | null {
  return hostMatches(url, 'lever.co') ? PLATFORM : null;
}

export const fieldMap: FieldMap = {
  name: 'input[name="name"]',
  email: 'input[name="email"]',
  phone: 'input[name="phone"]',
  resumeUpload: 'input[name="resume"]',
  coverLetter: 'textarea[name="comments"]',
  submitButton: 'button[type="submit"]',
};
