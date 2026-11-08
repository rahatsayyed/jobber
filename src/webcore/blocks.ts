// Block detection (plan 8G task 5). Detects only; never solves, clicks through or waits out a block.
import type { RawFormSnapshot } from './formModel.js';

export type BlockKind = 'captcha' | 'mfa' | 'phone_verification' | 'bot_wall' | 'login_required' | 'consent_required';

const BOT_WALL = /access denied|unusual traffic|request blocked|checking your browser|pardon our interruption|are you a robot|automated (queries|requests)/i;
const CAPTCHA = /captcha|verify you are (a )?human|i'?m not a robot|prove you are (a )?human/i;
const PHONE = /(verify|confirm) your (phone|mobile)|text message/i;
const MFA = /two-factor|2-step|two-step|multi-factor|authenticator app|one-time (code|password)|security code|verification code/i;
const LOGIN_WALL = /(please )?(sign|log) ?in to (apply|continue|view)|you must (be )?(signed|logged) ?in|please (sign|log) ?in (first|again)|session (has )?expired/i;
const CONSENT = /we use cookies|cookie (consent|preferences|settings)|manage cookies|accept (all )?cookies/i;
const CODE_LABEL = /(verification|security|one-time|confirmation|sms|authenticator) code|\botp\b/i;

// The footer line of every page with an invisible reCAPTCHA / hCaptcha ("This site is protected by reCAPTCHA and the Google Privacy Policy
// and Terms of Service apply.") is a disclosure, not a challenge: it must not read as a captcha wall.
const CAPTCHA_DISCLOSURE = /(?:this (?:site|page|form|website) is )?protected by (?:google )?(?:re)?captcha[^\n]*/gi;

export function detectBlock(raw: RawFormSnapshot): BlockKind | null {
  const text = `${raw.title ?? ''}\n${raw.text ?? ''}`.replace(CAPTCHA_DISCLOSURE, ' ').slice(0, 20000);
  const vis = (raw.fields ?? []).filter((f) => !f.hidden);
  if (BOT_WALL.test(text)) return 'bot_wall';
  if (raw.captchaWidget || CAPTCHA.test(text)) return 'captcha';
  const codeField = vis.some((f) => f.autocomplete === 'one-time-code' || (f.type !== 'file' && CODE_LABEL.test(f.label)));
  if (codeField && PHONE.test(text)) return 'phone_verification';
  if (codeField && MFA.test(text)) return 'mfa';
  const nonPw = vis.filter((f) => f.type !== 'password' && f.type !== 'email' && f.type !== 'checkbox');
  if (LOGIN_WALL.test(text) && nonPw.length === 0) return 'login_required';
  if (CONSENT.test(text) && vis.length === 0) return 'consent_required';
  return null;
}
