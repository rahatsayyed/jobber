// src/settings/envCatalog.ts
// The single catalog of every owner-settable environment key (plan 8H, Task 2). Numeric limits are COMPOSED from
// LIMITS (src/setup/limitsCatalog.ts, which keeps its own drift test); everything else is authored here.
// .env.example is GENERATED from this list (npm run env:example, src/settings/exampleGen.ts); edit here, not there.
// Rules a test enforces over the whole list (D22): JOBBER_DRY_RUN is the only *_DRY_RUN, `safety` with a direction and a non-null default,
// type `path` and *_CMD/*_PATH/*_REMOTE/*_DIR are `never`, a LIMITS key with a raiseNote is `guarded` or stricter,
// secret === (type === 'secret'), a restart scope other than `stack` names an existing reader file.
import { APPLY_HOST_PLATFORM_IDS, hostCapKey, TOP_LEVEL_KEY } from '../webcore/hostCaps.js';
import { LIMITS } from '../setup/limitsCatalog.js';
import { fromLimit, type LimitOverride } from './fromLimits.js';
import type { EditTier, EnvSpec, EnvType, SectionId, Weakens } from './types.js';

/** Names the code reads that are NOT owner configuration, each with the reason (kept out of the catalog). */
export const INTERNAL_NAMES: Record<string, string> = {
  HOME: 'OS variable',
  PATH: 'OS variable',
  TZ: 'OS timezone, passed through to wakes',
  TERM: 'terminal type passed to interactive profiles',
  COLORTERM: 'terminal colour support passed to interactive profiles',
  NO_COLOR: 'standard terminal convention (no-color.org), read by src/ui/term.ts; documented in docs/setup-modes.md',
  FORCE_COLOR: 'standard terminal convention, read by src/ui/term.ts; documented in docs/setup-modes.md',
  VITEST: 'set by the test runner',
  JOBAPPLIER_DB: 'test harness only (vitest.config.ts points it at an in-memory database)',
  JOBBER_RUN_ID: 'set by the scheduler launcher per wake',
  SCHEDULER_RUN_ID: 'set by the scheduler per run',
  JOBBER_RUN_PROFILE: 'set by the restricted runner to the profile name',
  IS_SANDBOX: 'refused if set; never a configuration value',
  CCGRAM_CLAUDE_COMMAND: 'set by scripts/ccgram/run.sh for the bridge',
  HOOK_NO_LOG: 'set by the doctor when it probes the allowlist hook',
  HOOK_PROBE_NO_LOG: 'set by the hook probe test',
  COPYFILE_DISABLE: 'set by the restore code for tar',
  LINKEDIN_NO_MAIN: 'import guard so tests can load the linkedin MCP module',
  APPLIER_NO_MAIN: 'import guard so tests can load the applier MCP module',
  SCOUT_NO_MAIN: 'import guard so tests can load the scout MCP module',
  NAUKRI_NO_MAIN: 'import guard so tests can load the naukri MCP module',
  WELLFOUND_NO_MAIN: 'import guard so tests can load the wellfound MCP module',
  OUTREACH_NO_MAIN: 'import guard so tests can load the outreach MCP module',
  CLAUDE_PROJECT_DIR: 'set by Claude Code for hooks',
  PLAYWRIGHT_BROWSERS_PATH: 'third-party Playwright variable, read only to locate browsers',
  CAND: 'local shell variable in scripts/bootstrap.sh',
  KEY: 'placeholder in a generic helper',
};

const CLASSIFIER_IDS = ['protectai-deberta-v3-base-v2', 'llama-prompt-guard-2-22m'] as const;

type Over = Partial<EnvSpec> & { about: string };

const PLAIN = 'A plain preference. Changing it cannot widen what the agent may send, reach or spend.';

function e(key: string, section: SectionId, feature: string, type: EnvType, o: Over): EnvSpec {
  const secret = type === 'secret';
  return {
    key,
    section,
    feature,
    type,
    default: null,
    exampleActive: false,
    required: 'optional',
    secret,
    tier: 'normal',
    tierReason: PLAIN,
    weakens: null,
    restart: 'stack',
    blankMeansDefault: false,
    auditValue: !secret && (type === 'bool' || type === 'int' || type === 'enum'),
    ...o,
  };
}

const tier = (t: EditTier, tierReason: string, weakens: Weakens = null): Pick<EnvSpec, 'tier' | 'tierReason' | 'weakens'> => ({
  tier: t,
  tierReason,
  weakens,
});
const never = (why: string): Pick<EnvSpec, 'tier' | 'tierReason' | 'weakens'> => tier('never', why);

const R_DASH = 'Sign-in, identity, bind address or exposure of the dashboard: a wrong edit locks the owner out or opens the page. Edit .env by hand.';
const R_PATH = 'A path to credentials, code, data or backups: redirecting it could point the agent at attacker-chosen files. Edit .env by hand.';
const R_SESSION = 'Names which tmux session or window other tools act on: a wrong name sends commands to the wrong place. Edit .env by hand.';
const R_UPDATE = 'Where code comes from, how it is verified or where backups go: widening it is a supply chain risk (CLAUDE.md Safety rule 16). Edit .env by hand.';
const R_DRY = 'Decides whether real emails, messages, applications or account creations happen. Leaving dry run needs a fresh sign-in and a typed phrase.';
const R_SEND = 'Turns on a path that sends, applies or creates accounts for real, or widens an output allow-list. Enabling needs a fresh sign-in and a typed phrase.';
const R_VENDOR = 'Replacing a key for a fixed vendor host cannot redirect anything. The value is write-only.';

const hand: EnvSpec[] = [
  // ---- Contact finding (Serper, Hunter, dorking, search cache)
  e('SERPER_API_KEY', 'contact-finding', 'contact finding', 'secret', {
    exampleActive: true,
    about: 'Serper search key (serper.dev). Optional, used for contact finding only, and only after the search cache and browser dorking miss, under the Serper budgets. Unset: Serper is never called.',
    ...tier('normal', R_VENDOR),
  }),
  e('HUNTER_API_KEY', 'contact-finding', 'contact finding', 'secret', {
    exampleActive: true,
    about: 'Hunter.io key (hunter.io). Optional, the last resort email source. Unset, or HUNTER_ENABLED not true: Hunter is never called.',
    ...tier('normal', R_VENDOR),
  }),
  e('HUNTER_ENABLED', 'contact-finding', 'contact finding', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'Whether Hunter lookups are allowed. Keep false for the first smoke test. Hunter credits cost money beyond the plan.',
    ...tier('safety', 'Spends paid Hunter credits and sends company names to a third party when on.', 'true'),
  }),
  e('DORK_ENABLED', 'contact-finding', 'contact finding', 'bool', {
    default: 'true',
    exampleActive: true,
    about: 'Whether contact finding may search through the browser first (a dork). false: the cache, then Serper under budget.',
  }),
  e('DORK_BLOCK_COOLDOWN_HOURS', 'contact-finding', 'contact finding', 'int', {
    default: '24',
    min: 0,
    max: 720,
    exampleActive: true,
    about: 'Hours the browser dork stays off after a search engine blocks it.',
  }),
  e('SEARCH_CACHE_TTL_DAYS', 'contact-finding', 'contact finding', 'int', {
    default: '14',
    min: 0,
    max: 365,
    exampleActive: true,
    about: 'Days a search result is reused before it is searched again. A longer time saves Serper credits and shows older results.',
  }),
  e('GEN_PROVIDER_MIN_JOBS', 'search', 'generated job sources', 'int', {
    default: '3',
    min: 1,
    max: 50,
    about: 'Jobs a captured page must reproduce before a proposed (agent-written) job-source provider counts as validated.',
    ...tier('guarded', 'A lower number validates agent-written providers on less evidence.', 'decrease'),
  }),
  e('GEN_PROVIDER_PROMOTE_N', 'search', 'generated job sources', 'int', {
    default: '3',
    min: 1,
    max: 20,
    about: 'Clean runs (over at least two distinct run ids) before a validated provider becomes trusted and is listed for your review. Its outreach stays held until you approve it with npm run providers -- approve <id>.',
    ...tier('guarded', 'A lower number trusts agent-written providers sooner.', 'decrease'),
  }),

  // ---- Credentials: Gmail
  e('GMAIL_OAUTH_PATH', 'credentials-gmail', 'email outreach', 'path', {
    default: './secrets/gcp-oauth.keys.json',
    exampleActive: true,
    about: 'Google OAuth client keys file. Needed for email outreach and reply checks. Put the client JSON there; the login token is written to GMAIL_CREDENTIALS_PATH after the one-time auth command (see docs).',
    ...never(R_PATH),
  }),
  e('GMAIL_CREDENTIALS_PATH', 'credentials-gmail', 'email outreach', 'path', {
    default: './secrets/gmail-credentials.json',
    exampleActive: true,
    about: 'Where the Gmail login token is stored.',
    ...never(R_PATH),
  }),
  e('GMAIL_USER', 'credentials-gmail', 'email outreach', 'email', {
    exampleActive: true,
    about: 'Legacy SMTP address. Unused with the OAuth server. Optional, leave blank.',
    ...tier('normal', R_VENDOR),
  }),
  e('GMAIL_APP_PASSWORD', 'credentials-gmail', 'email outreach', 'secret', {
    exampleActive: true,
    about: 'Legacy SMTP app password. Unused with the OAuth server. Optional, leave blank.',
    ...tier('normal', R_VENDOR),
  }),

  // ---- Safety and dry-run flags
  e('JOBBER_DRY_RUN', 'safety', 'safety', 'bool', {
    default: 'false',
    exampleValue: 'true',
    allowed: ['true', 'false', '1', '0'],
    exampleActive: true,
    about: 'The ONE dry-run flag for the whole system (scheduler, LinkedIn, Naukri, scout, applier, web actions and the Gmail send hook). Copying this file to .env gives true = DRY RUN: nothing is sent, connected or applied. Remove the line or set false = LIVE (an unset flag also runs LIVE). Only 1 or true (any case) mean dry; anything else is live. Default when unset: false (LIVE). Allowed: true, false, 1, 0. The old SCHEDULER_DRY_RUN, LINKEDIN_DRY_RUN, WEB_DRY_RUN, APPLY_DRY_RUN and SCOUT_DRY_RUN keys are ignored: delete them.',
    ...tier('safety', R_DRY, 'false'),
  }),
  e('JOBBER_KILL', 'safety', 'safety', 'bool', {
    default: '0',
    allowed: ['1', '0'],
    exampleActive: true,
    about: 'Kill switch. 1 stops every wake (same effect as the .jobber/STOP file); anything else is off. Prefer npm run jobber:control -- stop.',
    ...never('The kill switch is owner-only through npm run jobber:control (decision D21): a dashboard session must not be able to set or clear it.'),
  }),
  e('FOLLOWUPS_AUTONOMOUS', 'safety', 'email follow-ups', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'Autonomous email follow-ups. false is legacy mode (10+ days quiet, max 2 per job, each approved on Telegram). true sends up to 3 follow-ups then a feedback message with no per-draft approval, on a clean reply check, under the shared daily send cap.',
    ...tier('safety', 'Removes the per-draft human approval step for follow-up emails.', 'true'),
  }),
  e('JOBBER_NOTIFY_CMD', 'safety', 'notifications', 'secret', {
    exampleActive: true,
    about: 'Optional command run with the notice title as its only argument when the scheduler writes an owner notice. Unset: notices go only to SQLite and .jobber/notify.jsonl. It may embed a webhook token, so it is write-only.',
    ...never('Runs a command on this machine and may carry a token: command execution must not be settable from the dashboard.'),
  }),

  // ---- Classifier
  e('CLASSIFIER_MODEL', 'classifier', 'prompt-injection screen', 'enum', {
    allowed: CLASSIFIER_IDS,
    exampleActive: true,
    about: 'Active classifier profile id (config/classifier-models.json). Required for live LinkedIn and Naukri reads and sends: unset, unpinned, unfitted or erroring means live calls fail closed, dry runs continue unscreened. There is no implicit default and no fallback chain. Fetch, pin and fit the model first (docs/classifier-models.md), then restart every MCP server and session.',
    ...tier('safety', 'Selects the input screen for third-party text. Clearing it makes live calls refuse (safe) but switching profiles changes what is screened.', 'cleared'),
  }),
  e('SCHEDULER_NO_CLASSIFIER', 'classifier', 'prompt-injection screen', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'Skip the input classifier in scheduler runs. Honoured for dry runs only; a live run still needs a ready classifier.',
    ...never('Disables a safety layer (the injection screen).'),
  }),
  e('DOCTOR_SKIP_SMOKE', 'classifier', 'doctor', 'bool', {
    exampleValue: '1',
    allowed: ['1'],
    about: 'Doctor only. 1 skips the classifier smoke inference (a warning shows instead). Useful on a machine without the model weights.',
    restart: 'next_run',
    restartEvidence: 'src/platform/checks.ts',
  }),

  // ---- LinkedIn
  e('LINKEDIN_ACCEPT_UNKNOWN', 'linkedin', 'LinkedIn', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'Accept invitations from senders that are not in the people table.',
    ...tier('safety', 'Lets the agent accept connections from strangers.', 'true'),
  }),
  e('LINKEDIN_MAX_ACCEPTS_PER_DAY', 'linkedin', 'LinkedIn', 'int', {
    default: '30',
    min: 0,
    max: 1000,
    exampleActive: true,
    about: 'Daily cap on accepted invitations.',
    ...tier('guarded', 'More automatic accepts per day raises account-restriction risk.', 'increase'),
  }),
  e('LINKEDIN_ALLOWED_URLS', 'linkedin', 'LinkedIn', 'list', {
    exampleActive: true,
    about: 'Comma-separated URLs that outbound LinkedIn text may contain. Unset: none allowed.',
    ...tier('safety', 'Widens what links the agent may put in a message.', 'any'),
  }),
  e('LINKEDIN_ALLOWED_EMAILS', 'linkedin', 'LinkedIn', 'list', {
    exampleActive: true,
    about: 'Comma-separated email addresses that outbound LinkedIn text may contain. Unset: none allowed.',
    ...tier('safety', 'Widens what addresses the agent may put in a message.', 'any'),
  }),
  e('LINKEDIN_IDLE_MS', 'linkedin', 'LinkedIn', 'int', {
    default: '600000',
    min: 60000,
    max: 3600000,
    exampleActive: true,
    about: 'Close the LinkedIn browser after this idle time, in milliseconds.',
    restart: 'mcp',
    restartEvidence: 'src/linkedin/config.ts',
  }),
  e('LINKEDIN_SCREENSHOT', 'linkedin', 'LinkedIn', 'bool', {
    default: 'true',
    exampleActive: true,
    about: 'On by default: linkedin_screenshot and linkedin_click_at (a pointer click needs a snapshot and a screenshot at the current epoch). Set false to disable. Screenshot pixels are NOT checked by the injection classifier.',
    restart: 'mcp',
    restartEvidence: 'src/mcp/linkedin.ts',
    ...tier('guarded', 'Feeds unscreened page pixels to the model and allows pointer clicks.'),
  }),
  e('LINKEDIN_SESSION_MAX_AGE_DAYS', 'linkedin', 'LinkedIn', 'int', {
    default: '45',
    min: 1,
    max: 3650,
    about: 'Days a saved LinkedIn session file may age before it counts as expired.',
    restart: 'mcp',
    restartEvidence: 'src/linkedin/session.ts',
  }),

  // ---- Shared web browser (company sites, ATS pages)
  e('WEB_MIN_GAP_SEC', 'web-core', 'shared web browser', 'int', {
    default: '20',
    min: 0,
    max: 3600,
    about: 'Seconds between two page loads on the same host, plus code-drawn jitter.',
    ...tier('guarded', 'A shorter gap hits one company site faster and looks automated.', 'decrease'),
    restart: 'mcp',
    restartEvidence: 'src/webcore/config.ts',
  }),
  e('WEB_MAX_CALLS_PER_JOB', 'web-core', 'shared web browser', 'int', {
    default: '80',
    min: 1,
    max: 1000,
    about: 'Page loads allowed per job.',
    ...tier('guarded', 'A larger budget lets one job browse more pages.', 'increase'),
    restart: 'mcp',
    restartEvidence: 'src/webcore/config.ts',
  }),
  e('WEB_MAX_JOB_MIN', 'web-core', 'shared web browser', 'int', {
    default: '15',
    min: 1,
    max: 240,
    about: 'Minutes one job may keep the browser.',
    ...tier('guarded', 'A longer budget lets one job hold the browser longer.', 'increase'),
    restart: 'mcp',
    restartEvidence: 'src/webcore/config.ts',
  }),
  e('WEB_IDLE_MS', 'web-core', 'shared web browser', 'int', {
    default: '600000',
    min: 60000,
    max: 3600000,
    about: 'Close the web browser after this idle time, in milliseconds.',
    restart: 'mcp',
    restartEvidence: 'src/webcore/config.ts',
  }),
  e('WEB_SETTLE_MS', 'web-core', 'shared web browser', 'int', {
    default: '1500',
    min: 0,
    max: 30000,
    about: 'Wait after each page load, in milliseconds.',
    restart: 'mcp',
    restartEvidence: 'src/webcore/config.ts',
  }),

  // ---- Browser apply and site accounts
  e('APPLY_ALLOW_ACCOUNT_CREATION', 'apply', 'browser apply', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'Agent-driven account creation on apply sites (ATS hosts). Flip it per supervised check. Sign-up also needs every web dry-run flag false and room under SITE_MAX_ACCOUNTS_PER_DAY. Marketing boxes are always left unchecked.',
    ...tier('safety', R_SEND, 'true'),
  }),
  e('APPLY_ALLOW_UNKNOWN_HOSTS', 'apply', 'browser apply', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'Apply to a host that is not a known ATS (drives it with the browser agent). When false, a job on an unknown host is never applied to.',
    ...tier('safety', R_SEND, 'true'),
  }),
  e('APPLY_LINKEDIN_EASY', 'apply', 'browser apply', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'LinkedIn Easy Apply through the burner account.',
    ...tier('safety', R_SEND, 'true'),
  }),
  e('APPLY_SUBMIT_MODE', 'apply', 'browser apply', 'enum', {
    default: 'hold',
    allowed: ['hold', 'submit'],
    exampleActive: true,
    about: 'What apply_submit does at the review step. hold stops there and reports held; submit really clicks submit. Anything other than exactly submit holds. A real submit also needs every web dry-run flag false.',
    ...tier('safety', R_SEND, 'any'),
  }),
  e('APPLY_SCREENSHOT', 'apply', 'browser apply', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'Offer a screenshot tool to the applier. Screenshot pixels are NOT checked by the injection classifier, so leave it off unless you are debugging.',
    ...tier('guarded', 'Feeds unscreened page pixels to the model.', 'true'),
  }),
  e('APPLY_RECIPE_PROMOTE_N', 'apply', 'browser apply', 'int', {
    default: '3',
    min: 1,
    max: 50,
    exampleActive: true,
    about: 'Browser-applier recipes learn from confirmed submitted applications only. A learned recipe for a platform with no recipe is written after this many confirmed applications.',
    ...tier('guarded', 'A lower number learns a recipe from less evidence.', 'decrease'),
  }),
  e('APPLY_RECIPE_PROMOTE_RUNS', 'apply', 'browser apply', 'int', {
    default: '2',
    min: 1,
    max: 20,
    exampleActive: true,
    about: 'Confirmed applications for a learned recipe must be spread over at least this many distinct run ids.',
    ...tier('guarded', 'A lower number learns a recipe from fewer independent runs.', 'decrease'),
  }),
  e('SCOUT_ALLOW_SIGNUP', 'apply', 'source scout', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'Allow the scout to create accounts on discovery (job) sites. Needs every web dry-run flag false.',
    ...tier('safety', R_SEND, 'true'),
  }),
  e('SITE_MAIL_VERIFY', 'apply', 'site sign-up', 'enum', {
    default: 'owner_assist',
    allowed: ['owner_assist', 'gmail', 'off'],
    exampleActive: true,
    about: 'How a sign-up verification link reaches the browser. owner_assist: you paste the link or mail text. gmail: reads one message through the gmail read tools, only when SITE_MAIL_SENDERS is also non-empty. off: no verification help.',
    ...tier('safety', 'gmail mode lets the agent read mail from the listed senders.', 'any'),
  }),
  e('SITE_MAIL_SENDERS', 'apply', 'site sign-up', 'list', {
    exampleActive: true,
    about: 'Comma-separated sender addresses (or @domain) whose verification mail may be read in gmail mode. Unset: none.',
    ...tier('safety', 'Widens which senders the agent may read mail from.', 'any'),
  }),
  e('APPLY_ACCEPT_LEGAL_REQUIRED', 'apply', 'browser apply', 'bool', {
    default: 'true',
    exampleActive: true,
    about: 'Check a required privacy-notice or terms box that a site needs to submit. false: such forms wait for you. Attestations and data-sharing boxes always wait for you.',
    ...tier('safety', 'Lets the agent accept legal text on your behalf.', 'true'),
  }),
  e('SITE_ACCOUNTS_FILE', 'apply', 'site sign-up', 'path', {
    about: 'Optional override of the site accounts file, for tests and recovery. Default secrets/site-accounts.json.',
    ...never(R_PATH),
  }),

  // ---- Naukri
  e('NAUKRI_SCREENSHOT', 'naukri', 'Naukri', 'bool', {
    default: 'true',
    exampleActive: true,
    about: 'On by default: naukri_screenshot and naukri_click_at (a pointer click needs a snapshot and a screenshot at the current epoch). Set false to disable. Screenshot pixels are NOT checked by the injection classifier.',
    restart: 'mcp',
    restartEvidence: 'src/mcp/naukri.ts',
    ...tier('guarded', 'Feeds unscreened page pixels to the model and allows pointer clicks.'),
  }),
  // ---- Wellfound
  e('WELLFOUND_SCREENSHOT', 'wellfound', 'Wellfound', 'bool', {
    default: 'true',
    exampleActive: true,
    about: 'On by default: wellfound_screenshot and wellfound_click_at (a pointer click needs a snapshot and a screenshot at the current epoch). Set false to disable. Screenshot pixels are NOT checked by the injection classifier.',
    restart: 'mcp',
    restartEvidence: 'src/mcp/wellfound.ts',
    ...tier('guarded', 'Feeds unscreened page pixels to the model and allows pointer clicks.'),
  }),
  e('SCOUT_SCREENSHOT', 'apply', 'source scout', 'bool', {
    default: 'true',
    exampleActive: true,
    about: 'On by default: scout_screenshot and scout_click_at (a pointer click needs a scout_state and a screenshot since the last navigation or scroll). Set false to disable. Screenshot pixels are NOT checked by the injection classifier.',
    restart: 'mcp',
    restartEvidence: 'src/mcp/scout.ts',
    ...tier('guarded', 'Feeds unscreened page pixels to the model and allows pointer clicks.'),
  }),

  // ---- Scheduler
  e('SCHEDULER_ENABLED', 'scheduler', 'scheduler', 'bool', {
    default: 'true',
    exampleActive: true,
    about: 'Whether the scheduler daemon runs. false makes the daemon exit at start.',
    ...tier('safety', 'Turning the scheduler on starts unattended outreach wakes.', 'true'),
    restart: 'scheduler',
    restartEvidence: 'src/scheduler/driver.ts',
  }),
  e('SCHEDULER_TMUX_SESSION', 'scheduler', 'scheduler', 'string', {
    default: 'jobber-runs',
    maxLen: 64,
    exampleActive: true,
    about: 'tmux session that holds the wake windows. Letters, digits, underscore and hyphen.',
    ...never(R_SESSION),
  }),
  e('EMAIL_SEND_WINDOW_START', 'scheduler', 'mail drip lane', 'string', {
    default: '09:30',
    maxLen: 5,
    about: 'Start of the daily window (HH:MM, IST like quiet hours) in which the mail drip lane may send. Must be before EMAIL_SEND_WINDOW_END; an invalid value stops the lane and the doctor warns.',
    ...tier('guarded', 'A wider window lets email go out at more hours of the day.', 'any'),
    restart: 'scheduler',
    restartEvidence: 'src/scheduler/mailDrip.ts',
  }),
  e('EMAIL_SEND_WINDOW_END', 'scheduler', 'mail drip lane', 'string', {
    default: '19:00',
    maxLen: 5,
    about: 'End of the daily window (HH:MM, IST) in which the mail drip lane may send. Must be after EMAIL_SEND_WINDOW_START.',
    ...tier('guarded', 'A wider window lets email go out at more hours of the day.', 'any'),
    restart: 'scheduler',
    restartEvidence: 'src/scheduler/mailDrip.ts',
  }),
  e('RUN_MAX_WALL_SEC', 'scheduler', 'scheduler', 'int', {
    default: '3600',
    min: 30,
    max: 7200,
    exampleActive: true,
    about: 'Wall clock budget per wake, in seconds.',
    ...tier('guarded', 'A longer budget lets one unattended run work longer before it is stopped.', 'increase'),
    restart: 'scheduler',
    restartEvidence: 'src/scheduler/budget.ts',
  }),
  e('RUN_MAX_TOKENS_APPROX', 'scheduler', 'scheduler', 'int', {
    default: '1000000',
    min: 1000,
    max: 2000000,
    exampleActive: true,
    about: 'Approximate token budget per wake (stream characters divided by 4). Max turns is owned by the run profile and has no env override.',
    ...tier('guarded', 'A larger budget lets one unattended run use more of the subscription before it is stopped.', 'increase'),
    restart: 'scheduler',
    restartEvidence: 'src/scheduler/budget.ts',
  }),
  e('INBOX_EVERY_MIN', 'scheduler', 'scheduler', 'int', {
    default: '60',
    min: 1,
    max: 10000,
    exampleActive: true,
    about: 'Minutes between recruiter inbox sweeps.',
    restart: 'scheduler',
    restartEvidence: 'src/scheduler/plan.ts',
  }),
  e('NAUKRI_DISCOVER_EVERY_HOURS', 'scheduler', 'scheduler', 'int', {
    default: '6',
    min: 1,
    max: 10000,
    exampleActive: true,
    about: 'Hours between Naukri discover runs.',
    restart: 'scheduler',
    restartEvidence: 'src/scheduler/plan.ts',
  }),
  e('WELLFOUND_DISCOVER_EVERY_HOURS', 'scheduler', 'scheduler', 'int', {
    default: '6',
    min: 1,
    max: 10000,
    exampleActive: true,
    about: 'Hours between Wellfound discover runs (planned only once secrets/wellfound-state.json exists).',
    restart: 'scheduler',
    restartEvidence: 'src/scheduler/plan.ts',
  }),
  e('USAGE_LIMIT_BACKOFF_MIN', 'scheduler', 'scheduler', 'int', {
    default: '300',
    min: 1,
    max: 10080,
    exampleActive: true,
    about: 'Minutes to pause after the subscription usage limit is hit.',
    restart: 'scheduler',
    restartEvidence: 'src/scheduler/driver.ts',
  }),
  e('AUTO_UPDATE', 'scheduler', 'auto-update', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'Let the scheduler run the auto-update tick (needs scripts/auto-update.ts). Updates are fast-forward only, signed by default, test-gated and rolled back on failure.',
    ...tier('safety', 'Lets new code arrive and run without a human reading it first.', 'true'),
    restart: 'scheduler',
    restartEvidence: 'src/scheduler/hooks.ts',
  }),
  e('BACKUP_ENABLED', 'scheduler', 'backup', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'Let the scheduler run the backup tick (needs scripts/backup.ts). Needs BACKUP_DIR and BACKUP_AGE_RECIPIENT.',
    ...tier('safety', 'Turning backups off removes the recovery path for the database and sessions.', 'false'),
    restart: 'scheduler',
    restartEvidence: 'src/scheduler/hooks.ts',
  }),
  e('SCHEDULER_HOOK_TIMEOUT_SEC', 'scheduler', 'scheduler', 'int', {
    default: '120',
    min: 30,
    max: 3600,
    about: 'Seconds the scheduler waits for an update or backup tick to finish.',
    restart: 'scheduler',
    restartEvidence: 'src/scheduler/hooks.ts',
  }),
  e('HOOK_MIN_INTERVAL_MIN', 'scheduler', 'scheduler', 'int', {
    default: '60',
    min: 1,
    max: 1440,
    about: 'Minimum minutes between two update or backup ticks.',
    restart: 'scheduler',
    restartEvidence: 'src/scheduler/hooks.ts',
  }),

  // ---- Dashboard (npm run web)
  e('WEB_PORT', 'dashboard', 'dashboard', 'int', {
    blankMeansDefault: true,
    default: '8787',
    min: 1024,
    max: 65535,
    exampleActive: true,
    about: 'Local dashboard port.',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_TMUX_SESSION', 'dashboard', 'dashboard chat', 'string', {
    blankMeansDefault: true,
    default: 'ccgram',
    maxLen: 64,
    exampleActive: true,
    about: 'tmux session the dashboard chat box targets. Used only when WEB_CHAT_ENABLED=true.',
    ...never(R_SESSION),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_TMUX_WINDOW', 'dashboard', 'dashboard chat', 'string', {
    blankMeansDefault: true,
    default: 'JobApplier',
    maxLen: 64,
    exampleActive: true,
    about: 'tmux window the dashboard chat box targets. Used only when WEB_CHAT_ENABLED=true.',
    ...never(R_SESSION),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_AUTH_MODE', 'dashboard', 'dashboard sign-in', 'enum', {
    default: 'token',
    allowed: ['token', 'google_desktop', 'oidc'],
    exampleActive: true,
    about: 'Dashboard sign-in mode. Left unset on an existing OIDC install it keeps working (see docs/dashboard-exposure.md).',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_GOOGLE_KEYS_PATH', 'dashboard', 'dashboard sign-in', 'path', {
    exampleActive: true,
    about: 'google_desktop only: keys file of the Gmail Desktop OAuth client. Blank uses GMAIL_OAUTH_PATH.',
    ...never(R_PATH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_GOOGLE_REDIRECT_SHAPE', 'dashboard', 'dashboard sign-in', 'enum', {
    default: 'callback',
    allowed: ['callback', 'root'],
    exampleActive: true,
    about: 'google_desktop only: callback address shape. callback is /auth/callback, root is /. Try root if Google refuses callback.',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('DASHBOARD_ALLOWED_EMAIL', 'dashboard', 'dashboard sign-in', 'email', {
    exampleActive: true,
    about: 'The one Google account allowed to sign in (google_desktop and oidc). npm run setup fills it.',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_OIDC_ISSUER', 'dashboard', 'dashboard sign-in', 'url', {
    default: 'https://accounts.google.com',
    exampleActive: true,
    about: 'oidc only: issuer address (https).',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_OIDC_CLIENT_ID', 'dashboard', 'dashboard sign-in', 'string', {
    exampleActive: true,
    required: 'conditional',
    requiredWhen: 'WEB_AUTH_MODE is oidc',
    about: 'oidc only: Google OAuth Web client id. Required when WEB_AUTH_MODE=oidc.',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_OIDC_CLIENT_SECRET', 'dashboard', 'dashboard sign-in', 'secret', {
    exampleActive: true,
    required: 'conditional',
    requiredWhen: 'WEB_AUTH_MODE is oidc',
    about: 'oidc only: Google OAuth Web client secret. Required when WEB_AUTH_MODE=oidc.',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_OIDC_REDIRECT_URI', 'dashboard', 'dashboard sign-in', 'url', {
    default: 'http://127.0.0.1:8787/auth/callback',
    exampleActive: true,
    about: 'oidc only: sign-in callback address.',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_OIDC_REAUTH_PROMPT', 'dashboard', 'dashboard sign-in', 'string', {
    default: 'select_account',
    maxLen: 40,
    exampleActive: true,
    about: 'oidc only: how Google asks for re-authentication.',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_REAUTH_MAX_AGE_SEC', 'dashboard', 'dashboard sign-in', 'int', {
    default: '300',
    min: 60,
    max: 3600,
    exampleActive: true,
    about: 'Seconds a sign-in stays fresh before re-authentication is required for sensitive changes.',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_AUTH_DB', 'dashboard', 'dashboard sign-in', 'path', {
    default: '.dashboard/auth.sqlite',
    exampleActive: true,
    about: 'Path of the dashboard sign-in database.',
    ...never(R_PATH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_BIND', 'dashboard', 'dashboard exposure', 'string', {
    blankMeansDefault: true,
    default: '127.0.0.1',
    maxLen: 255,
    exampleActive: true,
    about: 'Listen address. Loopback only unless WEB_ALLOW_REMOTE_BIND=true.',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_ALLOW_REMOTE_BIND', 'dashboard', 'dashboard exposure', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'Allow a non-loopback listen address on purpose.',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_ALLOWED_HOSTS', 'dashboard', 'dashboard exposure', 'list', {
    blankMeansDefault: true,
    exampleActive: true,
    about: 'Comma list of extra Host values (tunnel hostnames), hostname or host:port. Unset: none.',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_TRUST_PROXY', 'dashboard', 'dashboard exposure', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'Trust forwarded headers from a reverse proxy. Set true only behind a trusted proxy.',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_CHAT_ENABLED', 'dashboard', 'dashboard chat', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'Enable the two-step dashboard chat send into the tmux window. Use a read_only permission set if you enable it.',
    ...never(R_DASH),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_SETTINGS_EDIT', 'dashboard', 'settings editor', 'bool', {
    blankMeansDefault: true,
    default: 'false',
    about: 'Master switch of the dashboard settings editor. While false the Settings page is read-only and every write route is refused. Turn it on by hand in .env and restart the dashboard.',
    ...never('The editor must not be able to switch itself on: only the owner, by hand in .env, can enable editing.'),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
  e('WEB_SETTINGS_REMOTE_SAFETY', 'dashboard', 'settings editor', 'bool', {
    default: 'false',
    about: 'Allow safety-tier weakening changes (going live and similar) while the dashboard is bound off loopback or behind a proxy. Ships false, so a stolen token over the network cannot go live.',
    ...never('Opens the remote-exposure refusal for safety changes: a dashboard session must not be able to open it.'),
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),

  // ---- Telegram
  e('TELEGRAM_BOT_TOKEN', 'telegram', 'Telegram bridge', 'secret', {
    exampleActive: true,
    about: 'Bot token from @BotFather. Required for the Telegram bridge. Unset: the bridge does not start (the setup step can be skipped by choice).',
    ...never('Controls who talks to the agent over Telegram: a stolen session must not swap the bot.'),
  }),
  e('ALLOWED_USERS', 'telegram', 'Telegram bridge', 'list', {
    exampleActive: true,
    about: 'Comma-separated numeric Telegram user ids allowed to talk to the bot. Required together with the bot token.',
    ...never('Decides who may command the bridge: widening it hands control to someone else.'),
  }),
  e('CCGRAM_DAEMON_SESSION', 'telegram', 'Telegram bridge', 'string', {
    default: 'ccgram-daemon',
    maxLen: 64,
    about: 'tmux session of the ccgram daemon. Letters, digits, underscore and hyphen.',
    ...never(R_SESSION),
  }),
  e('MANAGER_TMUX_SESSION', 'telegram', 'Telegram bridge', 'string', {
    exampleValue: 'ccgram',
    maxLen: 64,
    about: 'tmux session of the manager windows. Blank uses the session in config/manager-windows.json.',
    ...never(R_SESSION),
  }),

  // ---- Layout memory (plan 8B)
  e('LAYOUT_ENFORCE', 'layout', 'layout memory', 'enum', {
    default: 'warn',
    allowed: ['off', 'warn', 'enforce'],
    blankMeansDefault: true,
    about: 'off, warn or enforce. enforce refuses the irreversible typed LinkedIn sends on drift or unknown layouts; learn first (CLAUDE.md, Layout memory). Any change is treated as weakening because leaving enforce loosens the guard.',
    ...tier('safety', 'enforce is a guard on irreversible sends; leaving it, or switching off, loosens that guard.', 'any'),
    restart: 'mcp',
    restartEvidence: 'src/layout/config.ts',
  }),
  ...(
    [
      ['LAYOUT_PROMOTE_N', '3', 1, 1000, 'Observations before a layout variant is promoted.'],
      ['LAYOUT_PROMOTE_RUNS', '2', 1, 1000, 'Distinct run ids needed for promotion.'],
      ['LAYOUT_STALE_DAYS', '30', 1, 3650, 'Days before a learned kind counts as stale.'],
      ['LAYOUT_DRIFT_ESCALATE_N', '3', 1, 1000, 'Drift streak that writes an owner escalation.'],
      ['LAYOUT_DRIFT_HALT_N', '5', 1, 1000, 'Drift streak that halts the platform (it also needs 2 run ids and may not be below the escalate value).'],
      ['LAYOUT_DRIFT_WINDOW_HOURS', '24', 1, 8760, 'Window for the drift streak, in hours.'],
      ['LAYOUT_MAX_BYTES', '65536', 4096, 1048576, 'Layout file size cap, in bytes.'],
      ['LAYOUT_RENDER_MAX_CHARS', '1200', 100, 20000, 'Cap on the memory text shown to an operator.'],
      ['LAYOUT_UNLOADED_MAX_CHARS', '80', 1, 2000, 'Page text shorter than this counts as unloaded.'],
      ['LAYOUT_EXPLORE_BUDGET', '6', 0, 100, 'Parsed but prompt-only: the operators prompts state 6 and it is not enforced.'],
    ] as const
  ).map(([key, def, min, max, about]) =>
    e(key, 'layout', 'layout memory', 'int', {
      default: def,
      min,
      max,
      blankMeansDefault: true,
      about: `${about} Invalid values fall back to the default.`,
      restart: 'mcp',
      restartEvidence: 'src/layout/config.ts',
    }),
  ),
  e('LAYOUT_MATCH_MIN', 'layout', 'layout memory', 'string', {
    default: '0.9',
    maxLen: 8,
    blankMeansDefault: true,
    about: 'Landmark score for a layout match, a decimal from 0 to 1. Invalid values fall back to the default.',
    restart: 'mcp',
    restartEvidence: 'src/layout/config.ts',
  }),
  e('LAYOUT_PARTIAL_MIN', 'layout', 'layout memory', 'string', {
    default: '0.6',
    maxLen: 8,
    blankMeansDefault: true,
    about: 'Landmark score for a partial layout match, a decimal from 0 to 1, not above the match value. Invalid pairs fall back to the defaults.',
    restart: 'mcp',
    restartEvidence: 'src/layout/config.ts',
  }),
  e('LAYOUT_DIR', 'layout', 'layout memory', 'path', {
    default: '.jobber/layout',
    blankMeansDefault: true,
    about: 'Layout store directory. Must resolve inside the project, otherwise the default is used.',
    ...never(R_PATH),
    restart: 'mcp',
    restartEvidence: 'src/layout/config.ts',
  }),

  // ---- Update and backup (plan 7D)
  e('AUTO_UPDATE_REMOTE', 'update-backup', 'auto-update', 'string', {
    default: 'origin',
    maxLen: 100,
    exampleActive: true,
    about: 'Git remote the update fetches from. Use the upstream remote, not a fork you cannot trust.',
    ...never(R_UPDATE),
  }),
  e('AUTO_UPDATE_BRANCH', 'update-backup', 'auto-update', 'string', {
    default: 'main',
    maxLen: 100,
    exampleActive: true,
    about: 'Branch the update fast-forwards to.',
    ...never(R_UPDATE),
  }),
  e('AUTO_UPDATE_TAG_PATTERN', 'update-backup', 'auto-update', 'string', {
    exampleActive: true,
    maxLen: 100,
    about: 'Optional tag glob (for example v*). Empty follows the branch tip.',
    ...never(R_UPDATE),
  }),
  e('AUTO_UPDATE_REQUIRE_SIGNED', 'update-backup', 'auto-update', 'bool', {
    default: 'true',
    exampleActive: true,
    about: 'Require signed commits. Exactly false turns the signature check off (the doctor warns).',
    ...never(R_UPDATE),
  }),
  e('AUTO_UPDATE_SIGNERS_FILE', 'update-backup', 'auto-update', 'path', {
    exampleActive: true,
    required: 'conditional',
    requiredWhen: 'AUTO_UPDATE is true',
    about: 'allowed_signers file with the maintainer SSH public keys. Required while signatures are required.',
    ...never(R_UPDATE),
  }),
  e('AUTO_UPDATE_REVIEW_PATHS', 'update-backup', 'auto-update', 'list', {
    exampleActive: true,
    about: 'Comma list of paths that force a manual review. Empty keeps the built-in list.',
    ...never(R_UPDATE),
  }),
  e('BACKUP_DIR', 'update-backup', 'backup', 'path', {
    exampleActive: true,
    required: 'conditional',
    requiredWhen: 'BACKUP_ENABLED is true',
    about: 'Backup destination outside the project, ideally another disk (mode 700). Required for backups.',
    ...never(R_UPDATE),
  }),
  e('BACKUP_AGE_RECIPIENT', 'update-backup', 'backup', 'string', {
    exampleActive: true,
    required: 'conditional',
    requiredWhen: 'BACKUP_ENABLED is true',
    maxLen: 200,
    about: 'The age PUBLIC key (starts with age1) backups are encrypted to. Never a private key. Required for backups.',
    ...never(R_UPDATE),
  }),
  e('BACKUP_INCLUDE_SECRETS', 'update-backup', 'backup', 'bool', {
    default: 'false',
    exampleActive: true,
    about: 'Also archive secrets/ (OAuth tokens, browser sessions). See the runbook before enabling.',
    ...never(R_UPDATE),
  }),
  e('BACKUP_RCLONE_REMOTE', 'update-backup', 'backup', 'string', {
    exampleActive: true,
    maxLen: 200,
    about: 'Optional rclone mirror, for example gdrive:jobber-backups (name:path). Empty: no mirror.',
    ...never(R_UPDATE),
  }),
  e('BACKUP_RETAIN_DAILY', 'update-backup', 'backup', 'int', {
    default: '7',
    min: 0,
    max: 365,
    exampleActive: true,
    about: 'Daily archives kept.',
  }),
  e('BACKUP_RETAIN_WEEKLY', 'update-backup', 'backup', 'int', {
    default: '4',
    min: 0,
    max: 365,
    exampleActive: true,
    about: 'Weekly archives kept.',
  }),
  e('BACKUP_RETAIN_MONTHLY', 'update-backup', 'backup', 'int', {
    default: '6',
    min: 0,
    max: 365,
    exampleActive: true,
    about: 'Monthly archives kept.',
  }),

  // ---- Advanced
  e('ANTHROPIC_DEFAULT_OPUS_MODEL', 'advanced', 'model routing', 'string', {
    exampleValue: 'deepseek/deepseek-v4-pro',
    exampleActive: true,
    maxLen: 200,
    about: 'Model routing for the claude CLI (docs/model-auth-setup.md): heaviest-tier model name. Claude Code itself reads it; Jobber code does not. Remove the value to use the default.',
  }),
  e('ANTHROPIC_BASE_URL', 'advanced', 'model routing', 'secret', {
    about: 'Third-party endpoint, only with env-based auth. Do not run /login if you use it. It can carry credentials, so it is write-only.',
    ...never('Redirects all model traffic, together with the auth token, to another host.'),
  }),
  e('ANTHROPIC_AUTH_TOKEN', 'advanced', 'model routing', 'secret', {
    about: 'API key sent to the third-party endpoint.',
    ...never('A credential that is sent to whatever endpoint ANTHROPIC_BASE_URL names.'),
  }),
  e('ANTHROPIC_DEFAULT_SONNET_MODEL', 'advanced', 'model routing', 'string', {
    maxLen: 200,
    about: 'Main working model name for the third-party endpoint.',
  }),
  e('ANTHROPIC_DEFAULT_HAIKU_MODEL', 'advanced', 'model routing', 'string', {
    maxLen: 200,
    about: 'Small and fast subtask model name for the third-party endpoint.',
  }),
  e('CLAUDE_CLI_PATH', 'advanced', 'model routing', 'path', {
    default: 'claude',
    about: 'Path of the claude CLI used by the hybrid fallbacks. Blank means claude from PATH.',
    ...never('Names a program that is executed: command execution must not be settable from the dashboard.'),
  }),
  e('EVAL_MODEL', 'advanced', 'evaluation', 'string', {
    default: 'sonnet',
    maxLen: 100,
    about: 'Model alias for npm run eval:gen and eval:judge. A --model flag wins.',
    restart: 'next_run',
    restartEvidence: 'scripts/eval/lib.ts',
  }),
  e('JOBAPPLIER_USER_DATA', 'advanced', 'data location', 'path', {
    default: 'user-data',
    about: 'Folder holding the personal data files (resume.json and others). Relative paths resolve from the project root. Mode 700 is expected.',
    ...never(R_PATH),
  }),
  e('STACK_TMUX_SESSION', 'advanced', 'stack', 'string', {
    default: 'jobber-stack',
    maxLen: 64,
    about: 'tmux session holding the scheduler and web windows started by npm run up.',
    ...never(R_SESSION),
  }),
  e('STACK_DOWN_WAIT_SEC', 'advanced', 'stack', 'int', {
    default: '60',
    min: 5,
    max: 600,
    about: 'Seconds npm run down waits for the scheduler to finish its wake. Values outside the range are clamped.',
    restart: 'next_run',
    restartEvidence: 'src/stack/down.ts',
  }),
  e('BOOTSTRAP_MODEL_PROFILE', 'advanced', 'bootstrap', 'string', {
    maxLen: 100,
    about: 'Classifier model profile the bootstrap downloads. Empty means the default profile.',
    restart: 'next_run',
    restartEvidence: 'scripts/bootstrap.ts',
  }),
  e('SETTINGS_BACKUP_KEEP', 'advanced', 'settings editor', 'int', {
    blankMeansDefault: true,
    default: '10',
    min: 1,
    max: 100,
    about: 'Backups kept per target (the env file and each edited config file) by the settings editor. Older ones are removed after a save.',
    restart: 'dashboard',
    restartEvidence: 'src/web/env.ts',
  }),
];

// ---- Keys composed from LIMITS (defaults, ranges and meaning stay in src/setup/limitsCatalog.ts) ----

// Keys whose loader treats a blank value exactly like an unset one (a test runs the real loaders to prove it).
const BLANK_OK = new Set<string>([
  'LINKEDIN_MAX_INVITES_PER_DAY', 'LINKEDIN_MAX_MESSAGES_PER_DAY', 'NAUKRI_MAX_APPLIES_PER_DAY',
  'NAUKRI_MAX_MESSAGES_PER_DAY', 'WELLFOUND_MAX_APPLIES_PER_DAY', 'WELLFOUND_MAX_MESSAGES_PER_DAY',
  'WELLFOUND_MAX_DISCOVER_PER_DAY', 'APPLY_MAX_ATTEMPTS_PER_DAY', 'SITE_MAX_ACCOUNTS_PER_DAY',
  'LINKEDIN_MAX_DISCOVER_PER_DAY', 'COMPANY_CONTACT_LIMIT', 'SPECULATIVE_COMPANY_LIMIT', 'QUIET_HOURS_START',
  'QUIET_HOURS_END',
  'COOLDOWN_IGNORED_DAYS', 'COOLDOWN_NOT_NOW_DAYS', 'COOLDOWN_EXPLICIT_STOP_DAYS', 'CADENCE_GAPS_DAYS',
  'EMAIL_MAX_PER_DAY', 'EMAIL_DRIP_MIN_BATCH', 'EMAIL_DRIP_MAX_BATCH', 'EMAIL_DRIP_MIN_GAP_MIN', 'EMAIL_DRIP_MAX_GAP_MIN',
  'EMAIL_DRIP_INTRA_PAUSE_MIN_SEC', 'EMAIL_DRIP_INTRA_PAUSE_MAX_SEC',
  TOP_LEVEL_KEY, ...APPLY_HOST_PLATFORM_IDS.map(hostCapKey),
]);
const ACTIVE_IN_EXAMPLE = new Set([
  'MATCH_THRESHOLD', 'SEND_LIMIT_PER_RUN', 'MAX_APPLIES_PER_DAY', 'MAX_LINKEDIN_SEARCHES_PER_DAY',
  'FOLLOWUP_CHECK_MAX_AGE_MIN', TOP_LEVEL_KEY, 'APPLY_MAX_STEPS', 'APPLY_HOST_COOLDOWN_DAYS', 'HUNTER_MONTHLY_CAP',
  'SERPER_DAILY_BUDGET', 'SERPER_MONTHLY_BUDGET', 'DORK_DAILY_BUDGET',
]);
const CONTACT_FINDING = new Set(['HUNTER_MONTHLY_CAP', 'SERPER_DAILY_BUDGET', 'SERPER_MONTHLY_BUDGET', 'DORK_DAILY_BUDGET']);
const APPLY_KEYS = new Set(['APPLY_MAX_ATTEMPTS_PER_DAY', 'SITE_MAX_ACCOUNTS_PER_DAY', 'APPLY_HOST_COOLDOWN_DAYS', 'APPLY_MAX_STEPS']);

function limitOverride(key: string): LimitOverride {
  const o: LimitOverride = { exampleActive: ACTIVE_IN_EXAMPLE.has(key), blankMeansDefault: BLANK_OK.has(key) };
  if (CONTACT_FINDING.has(key)) {
    o.section = 'contact-finding';
    o.feature = 'contact finding';
  } else if (APPLY_KEYS.has(key) || key === TOP_LEVEL_KEY || key.startsWith(`${TOP_LEVEL_KEY}_`)) {
    o.section = 'apply';
    o.feature = 'browser apply';
  }
  if (key.startsWith('EMAIL_DRIP_') || key === 'EMAIL_MAX_PER_DAY') {
    o.section = 'scheduler';
    o.feature = 'mail drip lane';
    o.restart = 'scheduler';
    o.restartEvidence = 'src/scheduler/mailDrip.ts';
  }
  if (key === 'HUNTER_MONTHLY_CAP') o.aboutExtra = 'Needed only when HUNTER_ENABLED=true.';
  if (key === 'FOLLOWUP_CHECK_MAX_AGE_MIN') o.aboutExtra = 'Used only when FOLLOWUPS_AUTONOMOUS=true.';
  return o;
}

const fromLimits: EnvSpec[] = LIMITS.map((l) => fromLimit(l, limitOverride(l.key)));

const SECTION_ORDER: SectionId[] = [
  'credentials-sources', 'contact-finding', 'credentials-gmail', 'safety', 'classifier', 'limits', 'linkedin',
  'apply', 'web-core', 'search', 'naukri', 'wellfound', 'scheduler', 'dashboard', 'telegram', 'layout', 'update-backup', 'advanced',
];

/** Every owner-settable key, grouped by section in display order (the sort is stable inside a section). */
export const ENV_CATALOG: EnvSpec[] = [...hand, ...fromLimits].sort(
  (a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section),
);
