import { describe, expect, it } from 'vitest';
import { treeToRawSnapshot } from '../src/browserctl/layoutAdapter.js';
import { buildTreeFromHtml } from '../src/browserctl/snapshot.js';
import { observeLinkedin } from '../src/layout/fingerprint.js';
import { profileHtml, URL_ } from './helpers/bcWorld.js';

describe('browserctl layout adapter', () => {
  it('turns a profile tree into the RawSnapshot shape the observer reads', () => {
    const raw = treeToRawSnapshot(buildTreeFromHtml(profileHtml(), URL_));
    expect(raw.url).toBe(URL_);
    expect(raw.profile).toMatchObject({ name: 'Jane Example', degree: '3rd', hasMessageButton: true, pending: false, hasBell: false });
    expect(raw.profile?.headline).toBe('Technical Recruiter at Acme');
    expect(raw.profile?.actions).toEqual(expect.arrayContaining(['Connect', 'Message', 'More', 'Follow']));
    expect(raw.hasPasswordInput).toBe(false);
    expect(raw.bodyText).toContain('Jane Example');
  });

  it('a connected profile has no Connect action and a dialog is reported', () => {
    const html = profileHtml({ status: 'connected', dialog: '<dialog open aria-label="Messaging"><h2>Jane Example</h2><textarea></textarea></dialog>' });
    const raw = treeToRawSnapshot(buildTreeFromHtml(html, URL_));
    expect(raw.profile?.degree).toBe('1st');
    expect(raw.profile?.actions).not.toContain('Connect');
    expect(raw.dialogText).toContain('Jane Example');
  });

  it('the observer fingerprints the adapted snapshot with the profile landmarks', () => {
    const raw = treeToRawSnapshot(buildTreeFromHtml(profileHtml(), URL_));
    const obs = observeLinkedin(raw, null);
    expect(obs.kind).toBe('profile');
    expect(obs.landmarks).toEqual(expect.arrayContaining(['profile.name', 'profile.headline', 'profile.degree', 'profile.message_button', 'action:connect']));
  });

  it('a password field is reported as a password input (logged-out telemetry)', () => {
    const raw = treeToRawSnapshot(buildTreeFromHtml(profileHtml({ extra: '<input type="password">' }), URL_));
    expect(raw.hasPasswordInput).toBe(true);
  });

  it('non-profile pages carry no profile', () => {
    const raw = treeToRawSnapshot(buildTreeFromHtml('<html><body><main><h1>Feed</h1></main></body></html>', 'https://www.linkedin.com/feed/'));
    expect(raw.profile).toBeNull();
  });
});
