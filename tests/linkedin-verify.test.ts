import { describe, it, expect } from 'vitest';
import {
  validateNoteLength,
  extractExpectedNameFromTitle,
  extractAboutText,
  extractDialogRecipientName,
  namesPlausiblyMatch,
  verifyRecipientName,
  extractProfileSlug,
  verifyProfileUrl,
} from '../src/linkedin/verify.js';

describe('validateNoteLength', () => {
  it('accepts a note at or under the 300-character LinkedIn cap', () => {
    const note = 'a'.repeat(300);
    expect(validateNoteLength(note)).toEqual({ ok: true, length: 300 });
  });

  it('rejects a note over the 300-character cap', () => {
    const note = 'a'.repeat(301);
    expect(validateNoteLength(note)).toEqual({ ok: false, length: 301 });
  });

  it('rejects an empty note', () => {
    expect(validateNoteLength('')).toEqual({ ok: false, length: 0 });
  });

  it('accepts a short, realistic note', () => {
    const note = 'Hi Jordan, saw the Full Stack Developer opening at Acme — would love to connect!';
    const result = validateNoteLength(note);
    expect(result.ok).toBe(true);
    expect(result.length).toBe(note.length);
  });
});

describe('extractAboutText', () => {
  // LinkedIn's About section textContent has no separator between the heading and the body —
  // live-confirmed 2026-08-29 on linkedin.com/in/example-person-4.
  it('strips the leading "About" heading text', () => {
    expect(extractAboutText('AboutBlockchain enthousiast Cardano developer')).toBe(
      'Blockchain enthousiast Cardano developer'
    );
  });

  it('is case-insensitive on the "About" prefix', () => {
    expect(extractAboutText('ABOUTSome bio text')).toBe('Some bio text');
  });

  it('returns null when the section is heading-only (empty About)', () => {
    expect(extractAboutText('About')).toBeNull();
    expect(extractAboutText('About   ')).toBeNull();
  });
});

describe('extractDialogRecipientName', () => {
  it('extracts the name from the real reported dialog copy ("Personalize your invitation to <Name>")', () => {
    expect(extractDialogRecipientName('Personalize your invitation to Vaishali S.')).toBe('Vaishali S');
  });

  it('extracts the name when the dialog copy ends with a question mark', () => {
    expect(extractDialogRecipientName('Add a note to your invitation to Jordan Lee?')).toBe('Jordan Lee');
  });

  it('returns an empty string when no "invitation to <Name>" pattern is present', () => {
    expect(extractDialogRecipientName('Send without a note')).toBe('');
  });

  it('extracts the name from the real pre-note "Add a note to your invitation?" dialog, which has a full paragraph of trailing copy after the name (false-negative regression: a legitimate Example Person Three send was fail-closed-aborted because this trailing copy defeated the old end-of-string-anchored regex)', () => {
    const dialogText =
      'Add a note to your invitation?\n\n' +
      'Personalize your invitation to Example Person Three by adding a note.\n\n' +
      'LinkedIn members are more likely to accept invitations that include a note.\n\n' +
      'You have unlimited notes with Premium\n\n' +
      'Add a note  Send without a note';
    expect(extractDialogRecipientName(dialogText)).toBe('Example Person Three');
  });

  it('still extracts correctly when the name is immediately followed by a sentence terminator (no regression on the original compose-dialog format)', () => {
    expect(extractDialogRecipientName('Personalize your invitation to Vaishali S.')).toBe('Vaishali S');
    expect(extractDialogRecipientName('Add a note to your invitation to Jordan Lee?')).toBe('Jordan Lee');
  });
});

describe('namesPlausiblyMatch', () => {
  it('matches on first name alone, tolerating a last-initial abbreviation in the dialog', () => {
    // The real incident: dialog said "Vaishali S." for a profile whose full name is
    // "Vaishali Sharma" — first names must match even though the surnames are formatted
    // completely differently (full surname vs. a single initial).
    expect(namesPlausiblyMatch('Vaishali Sharma', 'Vaishali S.')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(namesPlausiblyMatch('jordan lee', 'JORDAN L.')).toBe(true);
  });

  it('does not match two genuinely different first names (the real incident\'s failure mode)', () => {
    expect(namesPlausiblyMatch('Jane Doe', 'Vaishali S.')).toBe(false);
  });

  it('returns false when either name is empty (cannot verify a match against nothing)', () => {
    expect(namesPlausiblyMatch('', 'Jordan Lee')).toBe(false);
    expect(namesPlausiblyMatch('Jordan Lee', '')).toBe(false);
  });
});

describe('verifyRecipientName', () => {
  it('is ok (does not block) when the dialog text matches the profile name', () => {
    const result = verifyRecipientName('Jordan Lee', 'Personalize your invitation to Jordan Lee');
    expect(result.ok).toBe(true);
    expect(result.recipientName).toBe('Jordan Lee');
  });

  it('is NOT ok when the dialog names a different real person than the profile navigated to', () => {
    const result = verifyRecipientName('Jane Doe', 'Personalize your invitation to Vaishali S.');
    expect(result.ok).toBe(false);
    expect(result.recipientName).toBe('Vaishali S');
  });

  it('FAILS CLOSED (blocks) when the profile name could not be extracted at all (INCIDENT #2: prior leniency silently disabled this gate)', () => {
    const result = verifyRecipientName('', 'Personalize your invitation to Vaishali S.');
    expect(result.ok).toBe(false);
  });

  it('FAILS CLOSED (blocks) when the dialog recipient name could not be extracted at all (INCIDENT #2)', () => {
    const result = verifyRecipientName('Jordan Lee', 'Send without a note');
    expect(result.ok).toBe(false);
  });
});

describe('extractProfileSlug', () => {
  it('extracts the /in/<slug> segment, lowercased', () => {
    expect(extractProfileSlug('https://www.linkedin.com/in/example-person-three-2a19222a2/')).toBe(
      'example-person-three-2a19222a2'
    );
  });

  it('returns empty string when no /in/ segment is present', () => {
    expect(extractProfileSlug('https://www.linkedin.com/feed/')).toBe('');
  });
});

describe('verifyProfileUrl', () => {
  it('is ok when both URLs resolve to the same slug', () => {
    const result = verifyProfileUrl(
      'https://www.linkedin.com/in/example-person-three-2a19222a2/',
      'https://www.linkedin.com/in/example-person-three-2a19222a2/?trk=nav'
    );
    expect(result.ok).toBe(true);
  });

  it('FAILS (blocks) when the current URL is a different profile than requested', () => {
    const result = verifyProfileUrl(
      'https://www.linkedin.com/in/example-person-three-2a19222a2/',
      'https://www.linkedin.com/in/example-person-four/'
    );
    expect(result.ok).toBe(false);
    expect(result.expectedSlug).toBe('example-person-three-2a19222a2');
    expect(result.actualSlug).toBe('example-person-four');
  });

  it('FAILS CLOSED when either URL has no parseable slug', () => {
    expect(verifyProfileUrl('', 'https://www.linkedin.com/in/example/').ok).toBe(false);
    expect(verifyProfileUrl('https://www.linkedin.com/in/example/', '').ok).toBe(false);
  });
});

describe('extractExpectedNameFromTitle', () => {
  it('strips the "| LinkedIn" suffix', () => {
    expect(extractExpectedNameFromTitle('Tanvi Gaharwar | LinkedIn')).toBe('Tanvi Gaharwar');
    expect(extractExpectedNameFromTitle('  Jane Doe ')).toBe('Jane Doe');
  });
});

describe('ported incident guards', () => {
  it('fails closed on an empty name or an unextractable dialog', () => {
    expect(verifyRecipientName('', 'Add a note to your invitation to Jane').ok).toBe(false);
    expect(verifyRecipientName('Jane Example', 'Some unrelated dialog').ok).toBe(false);
  });
});
