import { describe, it, expect } from 'vitest';
import { buildReplyQuery, classifyReply, decideReply, domainOf, emailAddress, matchReply, stripQuoted, type ReplyClass } from '../src/replies.js';
import type { SentEmail } from '../src/db.js';

const ON = { auto_record_enabled: true };
const OFF = { auto_record_enabled: false };

const sent = (over: Partial<SentEmail>): SentEmail => ({ job_id: 'j1', company: 'Acme Labs Pvt Ltd', title: 'Frontend Developer', email_to: 'hr@acme.dev', subject: 'Frontend role', body: 'Hi', message_id: 'm1', thread_id: 't1', sent_at: '2026-09-01 10:00:00', ...over });
const S = [sent({}), sent({ job_id: 'j2', company: 'Globex', email_to: 'jobs@globex.io', message_id: 'm2', thread_id: 't2', sent_at: '2026-09-02 10:00:00' })];

describe('stripQuoted', () => {
  it('drops quoted history so our own words cannot classify the reply', () => {
    expect(stripQuoted('Thanks, sounds good.\n\nOn Mon, 1 Sep 2026 at 10:00, Me <me@x.com> wrote:\n> happy to interview anytime')).toBe('Thanks, sounds good.');
    expect(stripQuoted('Sure.\n> unfortunately quoted\n-----Original Message-----\nold')).toBe('Sure.');
  });
  it('handles an "On ... wrote:" header wrapped over two lines', () => {
    expect(stripQuoted('Noted.\n\nOn Mon, Sep 1, 2026 at 10:00 AM Jane Doe <me@example.com>\nwrote:\n> could we set up a call')).toBe('Noted.');
  });
  it('handles Outlook underscore lines, From/Sent header blocks and forwarded messages', () => {
    expect(stripQuoted('Thanks.\n\n________________________________\nFrom: Jane\nSent: Monday, September 1, 2026 10:00 AM\nTo: hr@acme.dev\n\nHappy to interview')).toBe('Thanks.');
    expect(stripQuoted('Thanks.\nFrom: Jane\nSent: Monday\nSubject: Frontend role\nset up a call')).toBe('Thanks.');
    expect(stripQuoted('Adding Priya.\n\n---------- Forwarded message ---------\nFrom: Jane <me@x.com>\nhappy to interview')).toBe('Adding Priya.');
  });
  it('handles HTML-only bodies: cuts at gmail_quote / blockquote / Outlook reply header, strips tags, styles and entities', () => {
    expect(stripQuoted('<div dir="ltr">Thanks, noted.</div><br><div class="gmail_quote"><blockquote>Happy to interview</blockquote></div>')).toBe('Thanks, noted.');
    expect(stripQuoted('<html><head><style>.x{color:red}</style></head><body><p>Fine &amp; good.</p><blockquote>set up a call</blockquote></body></html>')).toBe('Fine & good.');
    expect(stripQuoted('<div>Got it.</div><div id="divRplyFwdMsg"><b>From:</b> Jane</div><div>happy to interview</div>')).toBe('Got it.');
    expect(stripQuoted('<p>Line one</p><p>Line two</p>')).toBe('Line one\nLine two');
  });
});

// The 34 realistic probe replies from the pre-flight review: [label, from, subject, body, expected class].
// Auto-record classes are interview and rejected only; an auto-ack or out-of-office must never land there or in replied.
const HUMAN = 'Priya <priya@acme.dev>';
const PROBES: Array<[string, string, string, string, ReplyClass]> = [
  ['polite rej 1', HUMAN, 'Re: Frontend role', 'Hi, thanks for reaching out. Unfortunately we have decided to proceed with other applicants whose experience more closely matches our needs.', 'rejected'],
  ['polite rej 2', HUMAN, 'Re: Frontend role', 'Thank you for your interest. We will not be proceeding with your application at this time.', 'rejected'],
  ['polite rej 3', HUMAN, 'Re: Frontend role', "Thanks for the note. The role has been closed and we're not looking at new profiles.", 'rejected'],
  ['polite rej 4', HUMAN, 'Re: Frontend role', "Appreciate you writing in. We've gone with another candidate for this position, but we'll keep your resume on file.", 'rejected'],
  ['polite rej 5', HUMAN, 'Re: Frontend role', "Thanks, but we don't have a suitable opening matching your profile right now.", 'rejected'],
  ['polite rej 6', HUMAN, 'Re: Frontend role', 'Thanks for applying. After careful consideration we are not moving ahead with interviews for your profile.', 'rejected'],
  ['polite rej 7', HUMAN, 'Re: Frontend role', 'Hi, sorry, this position is no longer available.', 'rejected'],
  ['polite rej 8', HUMAN, 'Re: Frontend role', 'Thank you for your application. We have decided not to progress your application further.', 'rejected'],
  ['polite rej 9', HUMAN, 'Re: Frontend role', 'Unfortunately you were not shortlisted for the next round.', 'rejected'],
  ['polite rej 10', HUMAN, 'Re: Frontend role', "We're looking for someone with more backend experience, so it's not a fit right now. Best of luck!", 'rejected'],
  ['rej after interview', HUMAN, 'Re: Frontend role', 'Thank you for taking the time to interview with us. We regret to inform you that we will not move forward.', 'rejected'],
  ['ats rej', 'Acme Careers <no-reply@acme.dev>', 'Your application to Acme', 'Thank you for applying to Acme. We have reviewed your application and will not be moving forward.', 'rejected'],
  ['ooo 1', HUMAN, 'Out of Office: Re: Frontend role', 'I am currently on leave and will return on 20 Oct. For urgent matters contact hr@acme.dev.', 'auto_ack'],
  ['ooo 2', HUMAN, 'Auto-Reply: Frontend role', "I'm away until Monday with limited access to email.", 'auto_ack'],
  ['ooo 3', HUMAN, 'Re: Frontend role', 'Thank you for your email. I am on vacation until 25 October and will respond when I return.', 'auto_ack'],
  ['ooo with interview word', HUMAN, 'Automatic reply: Frontend role', 'I am out of the office conducting interviews this week; I will reply on Monday.', 'auto_ack'],
  ['auto-ack 1', 'careers@acme.dev', 'We received your message', 'Thanks for contacting Acme Careers. This mailbox is monitored; a recruiter will review your profile and reach out if there is a match.', 'auto_ack'],
  ['auto-ack 2', HUMAN, 'Re: Frontend role', 'Thank you for reaching out! Our team will review your profile and get back to you if shortlisted for an interview.', 'auto_ack'],
  ['auto-ack 3', 'support@acme.dev', 'Ticket #1234 created', 'Your request has been received. Our support team will respond within 48 hours.', 'auto_ack'],
  ['offer 1', HUMAN, 'Re: Frontend role', "We'd like to make you an offer! Details to follow.", 'offer'],
  ['offer 2', HUMAN, 'Offer letter - Acme', 'Please find your offer letter attached.', 'offer'],
  ['offer 3', HUMAN, 'Re: Frontend role', 'Congratulations! We are delighted to extend an offer for the Frontend Developer role.', 'offer'],
  ['schedule 1', HUMAN, 'Re: Frontend role', 'Are you free Thursday at 3 pm IST for a quick chat with our CTO?', 'interview'],
  ['schedule 2', HUMAN, 'Re: Frontend role', 'Can we connect tomorrow? Please share a good time.', 'interview'],
  ['schedule 3', 'Priya <calendar-notification@google.com>', 'Invitation: Intro call @ Thu Oct 16', 'You have been invited to the following event.', 'interview'],
  ['schedule 4', HUMAN, 'Re: Frontend role', 'Please book a slot here: https://calendly.com/acme/30min', 'interview'],
  ['schedule 5', HUMAN, 'Re: Frontend role', 'Our recruiter will call you tomorrow to discuss the next steps.', 'interview'],
  ['needs more info', HUMAN, 'Re: Frontend role', 'Thanks! What is your notice period and expected CTC?', 'replied'],
  ['bounce 1', 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'Delivery Status Notification (Failure)', "Address not found\n\nYour message wasn't delivered to hr@acme.dev because the address couldn't be found, or is unable to receive mail.\n\nThe response from the remote server was:\n550 5.1.1 The email account that you tried to reach does not exist.", 'bounce'],
  ['bounce 2', 'Microsoft Outlook <postmaster@acme.dev>', 'Undeliverable: Frontend role', "Delivery has failed to these recipients or groups: hr@acme.dev. The recipient's mailbox is full and can't accept messages now.", 'bounce'],
  ['html quoted', HUMAN, 'Re: Frontend role', '<div dir="ltr">Thanks, noted.</div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Mon, Sep 1, 2026 at 10:00 AM Jane wrote:<br></div><blockquote>Could we set up a 15-minute call this week? Happy to interview.</blockquote></div>', 'replied'],
  ['outlook quote', HUMAN, 'RE: Frontend role', 'Thanks, noted.\n\n________________________________\nFrom: Jane\nSent: Monday, September 1, 2026 10:00 AM\nTo: hr@acme.dev\nSubject: Frontend role\n\nCould we set up a 15-minute call this week? Happy to interview.', 'replied'],
  ['forwarded', HUMAN, 'Fwd: Frontend role', 'Adding Priya who runs hiring.\n\n---------- Forwarded message ---------\nFrom: Jane <me@x.com>\nDate: Mon, Sep 1\nSubject: Frontend role\n\nCould we schedule a call this week? Happy to interview.', 'replied'],
  ['newsletter', 'news@acme.dev', 'Acme Engineering Newsletter - October', 'This month: our new React design system. Unsubscribe here.', 'noise'],
];

describe('classifyReply on the 34 pre-flight probe replies', () => {
  it('has exactly 34 probes', () => expect(PROBES).toHaveLength(34));
  it.each(PROBES)('%s', (_label, from, subject, body, expected) => {
    expect(classifyReply(subject, body, from)).toBe(expected);
  });
  it('no probe is misclassified, and no auto-ack/out-of-office/bounce/newsletter lands in an auto-record or proposal class', () => {
    const wrong = PROBES.filter(([, from, s, b, e]) => classifyReply(s, b, from) !== e);
    expect(wrong).toEqual([]);
    for (const [, from, s, b, e] of PROBES) {
      if (['auto_ack', 'bounce', 'noise'].includes(e)) expect(['interview', 'rejected', 'replied', 'offer']).not.toContain(classifyReply(s, b, from));
    }
  });
});

describe('classifyReply other cases', () => {
  it.each([
    ['Job alert: 20 new React jobs', 'Recommended jobs for you', 'noise'],
    ['Re: Frontend role', 'Thanks for reaching out. We have decided to move forward with other candidates.', 'rejected'],
    ['Re: Frontend role', 'We are unable to offer you a position at this time.', 'rejected'],
    ['Re: Frontend role', 'We are not hiring for frontend right now.', 'rejected'],
    ['Offer', 'We are pleased to offer you the role. The offer letter is attached.', 'offer'],
    ['Re: Frontend role', 'We have received your email and will get back to you.', 'auto_ack'],
    ['Automatic reply: Out of office', 'I am out of the office until Monday.', 'auto_ack'],
    ['Re: Frontend role', 'Could you share your availability for a call this week?', 'interview'],
    ['Re: Frontend role', 'Please complete this HackerRank test.', 'interview'],
    ['Re: Frontend role', 'Thanks! Please apply through our careers page and mention me.', 'replied'],
    ['Re: Frontend role', 'Passing this to our hiring manager.', 'replied'],
    ['Re: Frontend role', '   ', 'unknown'],
    ['Re: Frontend role', 'Thank you for applying. If we would like to schedule an interview, we will contact you.', 'auto_ack'],
    ['Re: Frontend role', 'Your application will be reviewed. If you are not selected we will not contact you individually.', 'auto_ack'],
    ['Re: Frontend role', 'Thanks for your interest! When are you free for a call this week?', 'interview'],
  ] as Array<[string, string, ReplyClass]>)('%s / %s -> %s', (subject, body, expected) => {
    expect(classifyReply(subject, body)).toBe(expected);
  });
  it('bare "offer" or "unfortunately" alone do not decide the class', () => {
    expect(classifyReply('Re: x', 'What can we offer? Unfortunately Tuesday is busy, can we do Wednesday for the interview?')).toBe('interview');
  });
  it('words only in OUR quoted email never classify the reply', () => {
    expect(classifyReply('Re: Frontend role', 'Thanks.\n\nOn Mon, 1 Sep 2026 at 10:00, Jane <me@x.com> wrote:\n> I would love to set up a call or an interview. Unfortunately I cannot attend Friday.')).toBe('replied');
  });
  it('our own sentences pasted into the reply with no quote marker at all never classify it (defence in depth)', () => {
    const ours = 'I would love to set up a call or an interview this week. Unfortunately I cannot attend on Friday.';
    expect(classifyReply('Re: Frontend role', `Thanks, noted.\n\n${ours}`)).toBe('interview');
    expect(classifyReply('Re: Frontend role', `Thanks, noted.\n\n${ours}`, 'hr@acme.dev', ours)).toBe('replied');
    expect(classifyReply('Re: Frontend role', ours, 'hr@acme.dev', ours)).toBe('unknown');
  });
  it('a mailer-daemon sender is a bounce even when the text is bland', () => {
    expect(classifyReply('Re: x', 'See below.', 'MAILER-DAEMON@mail.acme.dev')).toBe('bounce');
  });
});

describe('matchReply', () => {
  it('thread id wins', () => {
    expect(matchReply({ message_id: 'r', thread_id: 't2', from: 'x@other.com', subject: '', body: '' }, S)).toEqual({ job_id: 'j2', confidence: 'high', via: 'thread' });
  });
  it('exact recipient address is high, same non-shared domain is medium', () => {
    expect(matchReply({ message_id: 'r', from: 'HR Team <HR@acme.dev>', subject: '', body: '' }, S)).toEqual({ job_id: 'j1', confidence: 'high', via: 'sender' });
    expect(matchReply({ message_id: 'r', from: 'Priya <priya@acme.dev>', subject: '', body: '' }, S)).toEqual({ job_id: 'j1', confidence: 'medium', via: 'domain' });
  });
  it('shared domains never match by domain; company names match low', () => {
    expect(matchReply({ message_id: 'r', from: 'x@gmail.com', subject: 'Hello', body: 'hi' }, S)).toEqual({ job_id: null, confidence: 'none', via: 'none' });
    expect(matchReply({ message_id: 'r', from: 'no-reply@greenhouse.io', subject: 'Your application to Globex', body: '' }, S)).toEqual({ job_id: 'j2', confidence: 'low', via: 'company' });
  });
  it('a tie across two jobs is ambiguous, never a guess', () => {
    const two = [sent({}), sent({ job_id: 'j3', message_id: 'm3', thread_id: 't3' })];
    expect(matchReply({ message_id: 'r', from: 'hr@acme.dev', subject: '', body: '' }, two)).toEqual({ job_id: null, confidence: 'none', via: 'ambiguous', candidates: ['j1', 'j3'] });
  });
  it('short company names need a word boundary', () => {
    const io = [sent({ job_id: 'j9', company: 'IO', email_to: 'a@io-labs.dev', thread_id: null })];
    expect(matchReply({ message_id: 'r', from: 'z@zz.com', subject: 'Radio update', body: 'portfolio' }, io).via).toBe('none');
  });
});

describe('decideReply', () => {
  const high = { job_id: 'j1', confidence: 'high' as const, via: 'thread' as const };
  it('with auto-record ENABLED auto-records only interview/rejected on a high-confidence match', () => {
    expect(decideReply('interview', high, null, ON)).toEqual({ action: 'auto_record', outcome: 'interview', reason: 'interview reply via thread' });
    expect(decideReply('rejected', high, null, ON).action).toBe('auto_record');
    expect(decideReply('rejected', high, 'no_response', ON).action).toBe('auto_record');
  });
  it('auto-record is OFF by default: the same decisions become proposals, bounce stays report, ignore classes stay ignore', () => {
    expect(decideReply('interview', high, null, OFF)).toEqual({ action: 'propose', outcome: 'interview', reason: 'auto-record is off (config/replies.json auto_record_enabled)' });
    expect(decideReply('rejected', high, null, OFF).action).toBe('propose');
    expect(decideReply('bounce', high, null, OFF).action).toBe('report');
    for (const c of ['noise', 'auto_ack', 'unknown'] as const) expect(decideReply(c, high, null, OFF).action).toBe('ignore');
    expect(decideReply('interview', high).action).toBe('propose'); // no config argument: the repository config ships disabled
  });
  it('proposes replied and offers (never auto-records them), weaker matches and non-eligible (weak-phrase) signals', () => {
    expect(decideReply('replied', high, null, ON)).toEqual({ action: 'propose', outcome: 'replied', reason: 'a plain reply is proposed, never auto-recorded' });
    expect(decideReply('offer', high, null, ON)).toEqual({ action: 'propose', outcome: 'offer', reason: 'offers always need approval' });
    expect(decideReply('rejected', { job_id: 'j1', confidence: 'medium', via: 'domain' }, null, ON)).toEqual({ action: 'propose', outcome: 'rejected', reason: 'medium-confidence match via domain' });
    expect(decideReply('rejected', high, null, ON, false)).toEqual({ action: 'propose', outcome: 'rejected', reason: 'signal is not strong enough to auto-record' });
  });
  it('ladder: auto-records only from nothing/no_response/replied, never rejected over interview or interview over rejected', () => {
    expect(decideReply('interview', high, 'interview', ON).action).toBe('propose');
    expect(decideReply('interview', high, 'rejected', ON).action).toBe('propose');
    expect(decideReply('interview', high, 'replied', ON).action).toBe('auto_record');
    expect(decideReply('rejected', high, 'replied', ON).action).toBe('auto_record');
    expect(decideReply('rejected', high, 'interview', ON).action).toBe('propose');
    expect(decideReply('rejected', high, 'rejected', ON).action).toBe('propose');
    expect(decideReply('rejected', high, 'offer', ON).action).toBe('propose');
    expect(decideReply('interview', high, 'hired', ON).action).toBe('propose');
  });
  it('reports bounces, ignores noise/auto-acks and unmatched mail', () => {
    expect(decideReply('bounce', high, null, ON)).toEqual({ action: 'report', outcome: null, reason: 'bounce for job j1 via thread' });
    expect(decideReply('bounce', { job_id: null, confidence: 'none', via: 'none' }, null, ON).action).toBe('report');
    expect(decideReply('auto_ack', high, null, ON).action).toBe('ignore');
    expect(decideReply('noise', high, null, ON).action).toBe('ignore');
    expect(decideReply('replied', { job_id: null, confidence: 'none', via: 'ambiguous' }, null, ON)).toEqual({ action: 'ignore', outcome: null, reason: 'unmatched (ambiguous)' });
  });
});

describe('buildReplyQuery', () => {
  it('ORs company names (newest send first), non-shared recipient domains and ATS senders; 60 days; never in:inbox', () => {
    const q = buildReplyQuery(S);
    expect(q).toBe('newer_than:60d -in:sent -in:drafts {"Globex" "Acme Labs Pvt Ltd" from:globex.io from:acme.dev from:greenhouse.io from:lever.co from:ashbyhq.com from:myworkday.com from:smartrecruiters.com from:icims.com}');
    expect(q).not.toContain('in:inbox');
  });
  it('shared-domain recipients get an exact from:<address>, never a bare from:gmail.com', () => {
    const q = buildReplyQuery([sent({ job_id: 'j5', company: 'Initech', email_to: 'candidate3@gmail.com' })]);
    expect(q).toContain('from:candidate3@gmail.com');
    expect(q).not.toContain('from:gmail.com');
  });
  it('keeps the NEWEST 20 companies when more than 20 jobs were emailed, and drops unsafe addresses', () => {
    const many = Array.from({ length: 25 }, (_, i) => sent({ job_id: `k${i}`, company: `Co${i}`, email_to: `a@co${i}.dev`, sent_at: `2026-09-${String(i + 1).padStart(2, '0')} 10:00:00` }));
    const q = buildReplyQuery(many);
    expect(q).toContain('"Co24"');
    expect(q).toContain('"Co5"');
    expect(q).not.toContain('"Co4"');
    expect(buildReplyQuery([sent({ email_to: 'a b}@gmail.com' })])).not.toContain('a b}');
  });
  it('address helpers', () => {
    expect(emailAddress('Priya <Priya@Acme.dev>')).toBe('priya@acme.dev');
    expect(emailAddress('bare@x.io')).toBe('bare@x.io');
    expect(domainOf('a@b.co.in')).toBe('b.co.in');
    expect(domainOf(null)).toBeNull();
  });
});
