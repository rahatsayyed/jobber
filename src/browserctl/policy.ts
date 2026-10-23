// browserctl platform policy: the few things that differ per platform inside the one engine. Which URLs
// the session may be on, what the page kind is (the guard needs 'thread'), what counts as a block page
// (and whether it halts the platform), and the tool prefix used in messages and dry-run records.
import { naukriKind } from '../layout/fingerprint.js';
import { isBlockedNaukriPath, isNaukriUrl } from '../naukri/page.js';
import { isBlockedWellfoundPath, isWellfoundUrl, wellfoundKind } from '../wellfound/page.js';
import { classifyUrl, isBlockedPath, isLinkedInUrl } from '../linkedin/urls.js';
import { detectTreeBlock } from './engineTypes.js';
import type { RawTree } from './snapshot.js';

export type BlockVerdict = { kind: string; halt: boolean };
export type UrlCheck = { ok: true } | { ok: false; code: string; why: string };

export interface PlatformPolicy {
  platform: 'linkedin' | 'naukri' | 'wellfound';
  /** Tool prefix: `linkedin`, `naukri` or `wellfound` (messages say "call <tool>_open first"). */
  tool: string;
  /** Env flag that turns screenshot and click_at on. */
  screenshotFlag: string;
  checkUrl(url: string): UrlCheck;
  pageKind(url: string): string;
  /** A block page for this tree, or null. `halt` false means refuse without halting the platform. */
  detectBlock(tree: RawTree): BlockVerdict | null;
}

export const LINKEDIN_POLICY: PlatformPolicy = {
  platform: 'linkedin',
  tool: 'linkedin',
  screenshotFlag: 'LINKEDIN_SCREENSHOT',
  checkUrl(url) {
    if (!isLinkedInUrl(url)) return { ok: false, code: 'not_linkedin', why: 'only https linkedin.com URLs may be opened' };
    const b = isBlockedPath(url);
    return b.blocked ? { ok: false, code: 'blocked_path', why: b.why ?? 'path is blocked' } : { ok: true };
  },
  pageKind: (url) => classifyUrl(url),
  detectBlock(tree) {
    const k = detectTreeBlock(tree);
    return k ? { kind: k, halt: true } : null;
  },
};

const ACCESS_DENIED_RE = /access denied|403 forbidden|request blocked|unusual traffic|you don'?t have permission to access/i;

export const NAUKRI_POLICY: PlatformPolicy = {
  platform: 'naukri',
  tool: 'naukri',
  screenshotFlag: 'NAUKRI_SCREENSHOT',
  checkUrl(url) {
    if (!isNaukriUrl(url)) return { ok: false, code: 'not_naukri', why: 'only https naukri.com URLs may be opened' };
    return isBlockedNaukriPath(url) ? { ok: false, code: 'blocked_path', why: 'path is blocked' } : { ok: true };
  },
  pageKind: (url) => naukriKind(url),
  detectBlock(tree) {
    // Akamai wall: tested on the title and the first lines only, like the layout fingerprint.
    const head = [tree.title, ...tree.nodes.slice(0, 6).map((n) => (n.role === 'text' ? n.text : n.name))].join('\n');
    if (ACCESS_DENIED_RE.test(head)) return { kind: 'blocked', halt: true };
    if (naukriKind(tree.url) === 'login' || tree.nodes.some((n) => n.secret)) return { kind: 'login_required', halt: false };
    return null;
  },
};

// Bot walls and CAPTCHA pages (Wellfound sits behind a bot-protection layer; the exact wall text is unverified live).
const WELLFOUND_WALL_RE = /access denied|403 forbidden|request blocked|unusual traffic|verify (?:that )?you(?:'|’)?re (?:a )?human|are you a robot|captcha|checking your browser|attention required|just a moment/i;

export const WELLFOUND_POLICY: PlatformPolicy = {
  platform: 'wellfound',
  tool: 'wellfound',
  screenshotFlag: 'WELLFOUND_SCREENSHOT',
  checkUrl(url) {
    if (!isWellfoundUrl(url)) return { ok: false, code: 'not_wellfound', why: 'only https wellfound.com URLs may be opened' };
    return isBlockedWellfoundPath(url) ? { ok: false, code: 'blocked_path', why: 'path is blocked' } : { ok: true };
  },
  pageKind: (url) => wellfoundKind(url),
  detectBlock(tree) {
    // A bot wall, CAPTCHA or access-denied page halts the platform: tested on the title and the first lines only.
    const head = [tree.title, ...tree.nodes.slice(0, 6).map((n) => (n.role === 'text' ? n.text : n.name))].join('\n');
    if (WELLFOUND_WALL_RE.test(head)) return { kind: /captcha|human|robot/i.test(head) ? 'captcha' : 'blocked', halt: true };
    if (wellfoundKind(tree.url) === 'login' || tree.nodes.some((n) => n.secret)) return { kind: 'login_required', halt: false };
    return null;
  },
};
