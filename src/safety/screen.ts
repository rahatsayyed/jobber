// src/safety/screen.ts
// One fail-closed screen for third-party text: code gate, then the local classifier.
import { gateInputAsync, type ClassifierPort } from './inputGate.js';
import { getActiveClassifier } from './classifierSelect.js';
import { isDryRun } from './dryRun.js';

export type ScreenPurpose = 'read' | 'send' | 'escalate';

export interface ScreenDeps {
  env?: NodeJS.ProcessEnv;
  /** true when the caller's platform is in dry run. Default isDryRun(env). */
  dryRun?: boolean;
  classifier?: ClassifierPort | (() => Promise<ClassifierPort>);
  maxChars?: number; // default 6000
}

export interface ScreenVerdict {
  blocked: boolean;
  unscreened: boolean;
  text: string;
  flags: string[];
  code: 'ok' | 'injection_suspected' | 'classifier_unavailable' | 'classifier_truncated';
}

export function classifierRequired(purpose: ScreenPurpose, dryRun: boolean): boolean {
  return purpose !== 'escalate' && !dryRun;
}

export function defaultClassifier(dryRun: boolean, env?: NodeJS.ProcessEnv): () => Promise<ClassifierPort> {
  return () => getActiveClassifier(dryRun ? 'dry_run' : 'send', env ? { env } : {});
}

export async function screenUntrusted(
  raw: string,
  purpose: ScreenPurpose,
  deps: ScreenDeps = {},
): Promise<ScreenVerdict> {
  const env = deps.env ?? process.env;
  const dryRun = deps.dryRun ?? isDryRun(env);
  const required = classifierRequired(purpose, dryRun);
  const classifier = deps.classifier ?? defaultClassifier(dryRun, env);
  const r = await gateInputAsync(raw, {
    maxChars: deps.maxChars ?? 6000,
    classifier,
    requireClassifier: required,
  });
  const flags = r.flags.filter((f) => f !== 'classifier_skipped');
  const blocked = (code: ScreenVerdict['code']): ScreenVerdict => ({
    blocked: true,
    unscreened: false,
    text: '',
    flags,
    code,
  });
  if (flags.includes('classifier_injection')) return blocked('injection_suspected');
  if (flags.includes('classifier_truncated')) return blocked('classifier_truncated');
  if (r.blocked && !flags.includes('classifier_unavailable')) return blocked('injection_suspected');
  if (flags.includes('classifier_unavailable')) {
    if (r.blocked) return blocked('classifier_unavailable');
    return { blocked: false, unscreened: true, text: r.text, flags, code: 'ok' };
  }
  return { blocked: false, unscreened: false, text: r.text, flags, code: 'ok' };
}

/** Source files that must call screenUntrusted (each wiring task adds its lint test). */
export const SCREENED_SURFACES: ReadonlyArray<{ id: string; file: string }> = [
  { id: 'linkedin_state', file: 'src/mcp/linkedin.ts' },
  { id: 'linkedin_check_status', file: 'src/linkedin/checkStatus.ts' },
  { id: 'linkedin_connect_send', file: 'src/linkedin/connectSend.ts' },
  { id: 'linkedin_send_message', file: 'src/linkedin/sendMessage.ts' },
  { id: 'linkedin_accept_invite', file: 'src/linkedin/acceptInvite.ts' },
  { id: 'linkedin_find_profiles', file: 'src/linkedin/findProfiles.ts' },
  { id: 'linkedin_search_jobs', file: 'src/linkedin/discoverCommon.ts' },
  { id: 'linkedin_search_posts', file: 'src/linkedin/discoverCommon.ts' },
  { id: 'naukri_state', file: 'src/mcp/naukri.ts' },
  { id: 'naukri_search', file: 'src/mcp/naukri.ts' },
  { id: 'naukri_discover', file: 'src/naukri/discover.ts' },
  { id: 'naukri_inbox', file: 'src/mcp/naukri.ts' },
  { id: 'naukri_read_thread', file: 'src/mcp/naukri.ts' },
  { id: 'naukri_inbound_classify', file: 'src/naukri/inbound.ts' },
  { id: 'outreach_escalate', file: 'src/mcp/outreach.ts' },
  { id: 'scout_search', file: 'src/scout/tools/search.ts' },
  { id: 'scout_state', file: 'src/scout/tools/browse.ts' },
  { id: 'scout_extract_jobs', file: 'src/scout/tools/jobs.ts' },
  { id: 'site_state', file: 'src/mcp/scout.ts' },
];

/**
 * True when the source makes a real screen call: `screenUntrusted(`, `deps.screen(` or an injected
 * `screen(`. Comments and import statements are stripped first, so a comment, an import or an
 * unused identifier does not count. Used by both the surfaces lint and the doctor check.
 */
export function callsScreen(source: string): boolean {
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
    .replace(/^\s*import\s+[\s\S]*?\bfrom\s+['"][^'"]+['"];?/gm, ' ')
    .replace(/^\s*import\s+['"][^'"]+['"];?/gm, ' ');
  return /\bscreenUntrusted\s*\(|\bdeps\.screen\s*\(|\bscreen\s*\(/.test(code);
}
