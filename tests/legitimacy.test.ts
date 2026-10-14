import { describe, it, expect } from 'vitest';
import { assessLegitimacy } from '../src/legitimacy.js';

const long = 'We build developer tools. You will own React and TypeScript features with our design team. '.repeat(5);
const base = { id: 'remotive:1', title: 'React Developer', description: long, url: 'https://remotive.com/jobs/1', apply_url: 'https://boards.greenhouse.io/acme/jobs/1', repost_count: 0, age_days: 3 };

describe('assessLegitimacy', () => {
  it('a normal posting is high', () => {
    expect(assessLegitimacy(base)).toEqual({ tier: 'high', signals: [] });
  });
  it('asking the applicant for money is suspicious', () => {
    expect(assessLegitimacy({ ...base, description: `${long} A refundable security deposit of Rs 5000 is required.` })).toEqual({ tier: 'suspicious', signals: ['asks the applicant for a fee or deposit'] });
  });
  it('anti-scam disclaimers, employer-paid fees and "a day off" are NOT suspicious', () => {
    for (const s of [
      'We never charge a registration fee.',
      'There is no security deposit or registration fee for any role.',
      'We pay the fee for your AWS certification.',
      'Employees earn a day off each week.',
      'We reimburse the training fee after you join.',
      'Earn 2 days off each month.',
    ]) expect(assessLegitimacy({ ...base, description: `${long} ${s}` })).toEqual({ tier: 'high', signals: [] });
  });
  it('real fee demands and money-per-day pitches stay suspicious', () => {
    expect(assessLegitimacy({ ...base, description: `${long} Pay a registration fee to start.` }).tier).toBe('suspicious');
    expect(assessLegitimacy({ ...base, description: `${long} Selected candidates must pay a training fee of Rs 3000.` }).tier).toBe('suspicious');
    expect(assessLegitimacy({ ...base, description: `${long} Earn Rs 2000 per day working from home.` })).toEqual({ tier: 'suspicious', signals: ['"earn per day/week" pay pitch'] });
    expect(assessLegitimacy({ ...base, description: `${long} Earn up to $500 a week, no experience needed.` }).tier).toBe('suspicious');
  });
  it('shortener or chat apply links are suspicious', () => {
    expect(assessLegitimacy({ ...base, apply_url: 'https://bit.ly/abc' }).tier).toBe('suspicious');
    expect(assessLegitimacy({ ...base, apply_url: 'https://wa.me/919999999999' }).tier).toBe('suspicious');
    expect(assessLegitimacy({ ...base, apply_url: 'https://evil-bit.ly.example.com/x' }).tier).toBe('high');
  });
  it('reposts, age and thin descriptions are caution', () => {
    expect(assessLegitimacy({ ...base, repost_count: 2 })).toEqual({ tier: 'caution', signals: ['reposted 2 times in 90 days on the same board'] });
    expect(assessLegitimacy({ ...base, age_days: 61 }).signals).toEqual(['posted 61 days ago']);
    expect(assessLegitimacy({ ...base, description: 'React dev needed.' }).signals).toEqual(['thin description (17 chars)']);
    expect(assessLegitimacy({ ...base, id: 'li-post:9', description: 'Hiring React devs, DM me.' }).tier).toBe('high');
  });
  it('thin-description caution skips snippet sources unless a snapshot exists, and measures description OR snapshot length', () => {
    expect(assessLegitimacy({ ...base, source: 'linkedin-jobs', description: 'India (Remote)' })).toEqual({ tier: 'high', signals: [] });
    expect(assessLegitimacy({ ...base, source: 'naukri', description: 'Bengaluru' }).tier).toBe('high');
    expect(assessLegitimacy({ ...base, source: 'adzuna', description: 'Short snippet...' }).tier).toBe('high');
    expect(assessLegitimacy({ ...base, source: 'remotive', description: 'React dev needed.' }).signals).toEqual(['thin description (17 chars)']);
    expect(assessLegitimacy({ ...base, source: 'remotive', description: 'React dev needed.', snapshot_chars: 5000 }).tier).toBe('high');
    expect(assessLegitimacy({ ...base, source: 'naukri', description: 'Bengaluru', snapshot_chars: 150 }).signals).toEqual(['thin description (150 chars)']);
  });
  it('personal-channel applications are caution; fixed-term is informational', () => {
    expect(assessLegitimacy({ ...base, description: `${long} Send your CV on WhatsApp to apply.` }).tier).toBe('caution');
    expect(assessLegitimacy({ ...base, description: `${long} Email your resume to hr.acme@gmail.com.` }).signals).toEqual(['applications go to a personal mailbox or chat app']);
    expect(assessLegitimacy({ ...base, description: `${long} This is a 6 month contract.` })).toEqual({ tier: 'high', signals: ['info: fixed-term contract'] });
  });
  it('missing both URLs is caution', () => {
    expect(assessLegitimacy({ ...base, url: null, apply_url: '' }).signals).toEqual(['no posting or apply URL']);
  });
});

const withText = (s: string, extra: object = {}) => assessLegitimacy({ ...base, description: `${long} ${s}`, ...extra });

describe('assessLegitimacy: rupee abbreviations and clause splitting', () => {
  it('"Rs." does not end the clause', () => {
    expect(withText('Registration charges Rs. 1500 payable before the interview.').tier).toBe('suspicious');
    expect(withText('Candidates must deposit INR. 5000 to confirm.').tier).toBe('suspicious');
    expect(withText('Earn Rs. 2000 per day from home.').tier).toBe('suspicious');
  });
});

describe('assessLegitimacy: India scam pairs (legit stays high, scam flags)', () => {
  const pairs: Array<[string, string, string, 'suspicious' | 'caution', object?]> = [
    ['sensitive documents', 'Salary is credited to your bank account monthly.', 'Send your Aadhaar card and PAN card to start the process.', 'suspicious'],
    ['sensitive documents (post-offer)', 'Background verification requires your Aadhaar after the offer is accepted.', 'Share your bank account details and OTP to activate your profile.', 'suspicious'],
    ['sensitive negated', 'We never ask for your OTP or bank account details.', 'Please share the OTP you receive to confirm.', 'suspicious'],
    ['pay by UPI', 'We use UPI for expense reimbursements.', 'Pay Rs 500 via UPI to confirm your slot.', 'suspicious'],
    ['pay by transfer', 'Salary is paid by bank transfer on the last working day.', 'Candidates must transfer the registration amount to our account.', 'suspicious'],
    ['deposit', 'Direct deposit of salary is available for all employees.', 'Candidates should deposit 5000 as a security.', 'suspicious'],
    ['deposit (employer)', 'We will deposit 5000 into your account as a joining bonus.', 'Applicants need to deposit Rs 5000 before joining.', 'suspicious'],
    ['telegram community', 'Join our Telegram community to meet the team.', 'To apply, message our Telegram group.', 'caution', { apply_url: '' }],
    ['telegram with company mailbox', 'To apply message our Telegram group or write to careers@acme.com.', 'Contact us on WhatsApp number +91 98765 43210 to apply.', 'caution', { apply_url: '' }],
    ['guarantee', 'We offer mentorship and a structured onboarding plan.', 'Guaranteed job after our course, 100% placement.', 'caution'],
    ['no experience with earnings', 'No experience needed for our internship program, stipend 15000 per month.', 'No experience needed, earn Rs 1500 per day.', 'suspicious'],
    ['data entry pay', 'Data entry operator, Rs 200 per hour.', 'Typing job, earn 800 rupees per hour at home.', 'caution'],
    ['earn rupees daily', 'You can earn a day off every week.', 'Earn 5000 rupees daily from home.', 'suspicious'],
  ];
  for (const [name, legit, scam, tier, extra] of pairs) {
    it(name, () => {
      expect(withText(legit, extra).tier).toBe('high');
      expect(withText(scam, extra).tier).toBe(tier);
    });
  }
  it('company mailbox next to a chat number is not the only channel', () => {
    expect(withText('Contact us on WhatsApp number +91 98765 43210 to apply, or email careers@acme.com.', { apply_url: '' }).tier).toBe('high');
  });
  it('signals name the reason', () => {
    expect(withText('Send your Aadhaar card to start.').signals).toEqual(['asks the applicant for sensitive documents or credentials']);
    expect(withText('Pay Rs 500 via UPI to confirm your slot.').signals).toEqual(['asks the applicant to pay by UPI, wire or transfer']);
  });
  it('earlier must-not-flag sentences still high', () => {
    for (const s of ['We never charge a registration fee.', 'We pay the fee for your AWS certification.', 'earn a day off each week', 'no security deposit', 'We reimburse the training fee.']) {
      expect(withText(s).tier).toBe('high');
    }
  });
});

describe('assessLegitimacy: inputs', () => {
  it('lower-cases and trims the source', () => {
    expect(assessLegitimacy({ ...base, source: 'NAUKRI', description: 'Bengaluru' }).tier).toBe('high');
    expect(assessLegitimacy({ ...base, source: ' Linkedin-Jobs ', description: 'India' }).tier).toBe('high');
  });
  it('handles html, null, undefined and empty descriptions', () => {
    expect(assessLegitimacy({ ...base, description: `<p>${long}</p><p>Send your <b>Aadhaar</b> card to start.</p>` }).tier).toBe('suspicious');
    expect(assessLegitimacy({ ...base, description: `<div>${long}</div>` })).toEqual({ tier: 'high', signals: [] });
    for (const d of [null, undefined, '']) {
      expect(assessLegitimacy({ ...base, description: d as never }).signals).toEqual(['thin description (0 chars)']);
    }
  });
  it('pathological inputs finish fast', () => {
    for (const d of ['a.'.repeat(50000), 'registration fee '.repeat(100000), 'a'.repeat(1_000_000), '<div>'.repeat(100000), 'Rs. '.repeat(50000)]) {
      const t = Date.now();
      assessLegitimacy({ ...base, description: d });
      expect(Date.now() - t).toBeLessThan(1000);
    }
  });
  it('scans only the first 20000 characters', () => {
    expect(assessLegitimacy({ ...base, description: `${'x '.repeat(11000)} Pay a registration fee to start.` }).tier).toBe('high');
  });
});
