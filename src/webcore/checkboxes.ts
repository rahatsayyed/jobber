// Closed-rule checkbox classification (plan 8G task 5). Pure; no model involved.
export type CheckboxClass = 'marketing' | 'legal_required' | 'attestation' | 'third_party_sharing' | 'other';

const MARKETING = /promot|newsletter|marketing|offers|updates and news|job alerts?|stay in touch|receive (emails|messages|communications)|partners?/i;
const LEGAL = /privacy (notice|policy)|terms (of (use|service))?|acknowledge|agree to the processing/i;
const ATTEST = /certify|true and complete|background check|authori[sz]e .* verify/i;
const SHARING = /share .* (partners|third part)/i;

export function classifyCheckbox(label: string, required: boolean): CheckboxClass {
  const l = String(label ?? '').slice(0, 1000);
  if (SHARING.test(l)) return 'third_party_sharing';
  if (ATTEST.test(l)) return 'attestation';
  const m = MARKETING.test(l);
  const g = LEGAL.test(l);
  if (required && g) return 'legal_required';
  if (m) return 'marketing';
  return 'other';
}
