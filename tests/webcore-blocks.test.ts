import { describe, it, expect } from 'vitest';
import { loadFixture, snapshotFromHtml } from './helpers/fixtureSite.js';
import { detectBlock } from '../src/webcore/blocks.js';
import { extractFormModel } from '../src/webcore/formModel.js';

describe('detectBlock', () => {
  it('captcha wall', () => expect(detectBlock(loadFixture('captcha-wall.html'))).toBe('captcha'));
  it('mfa code', () => expect(detectBlock(loadFixture('mfa-code.html'))).toBe('mfa'));
  it('phone verification', () => expect(detectBlock(loadFixture('phone-verify.html'))).toBe('phone_verification'));
  it('bot wall on a blocked results page', () => expect(detectBlock(loadFixture('serp-blocked.html'))).toBe('bot_wall'));
  it('login required wall', () => {
    const s = snapshotFromHtml('<html><body><p>Please sign in to continue.</p><a href="/x">Sign In</a></body></html>');
    expect(detectBlock(s)).toBe('login_required');
  });
  it('consent wall', () => {
    const s = snapshotFromHtml('<html><body><p>We use cookies.</p><button>Accept all cookies</button></body></html>');
    expect(detectBlock(s)).toBe('consent_required');
  });
  it('no block on ordinary pages, including a sign-in step and the ok results page', () => {
    for (const f of ['ats-a-form.html', 'wd-account.html', 'wd-signin.html', 'wd-step2-questions.html', 'serp-ok.html', 'wd-confirmation.html']) {
      expect(detectBlock(loadFixture(f)), f).toBeNull();
    }
  });
  it('widget-only captcha (no text) is detected', () => {
    expect(detectBlock(loadFixture('captcha-widget-only.html'))).toBe('captcha');
  });
  it('phone + postal code + promo code form is not a verification block', () => {
    expect(detectBlock(loadFixture('form-codes.html'))).toBeNull();
    expect(extractFormModel(loadFixture('form-codes.html')).stepKind).toBe('form');
  });
  it('autocomplete one-time-code alone suffices for mfa', () => {
    const s = snapshotFromHtml('<html><body><p>Two-factor</p><label for="a">Code</label><input id="a" autocomplete="one-time-code"></body></html>');
    expect(detectBlock(s)).toBe('mfa');
  });
  it('blocked pages get stepKind blocked', () => {
    expect(extractFormModel(loadFixture('captcha-wall.html')).stepKind).toBe('blocked');
  });
});
