// browserctl engine types and small shared helpers (kill switch, block detection on a tree).
import { existsSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';
import type { LinkedinConfig } from '../linkedin/config.js';
import type { SendStatus } from '../linkedin/toolDeps.js';
import { classifyUrl } from '../linkedin/urls.js';
import type { BlockKind } from '../linkedin/state.js';
import { haltReason } from '../outreach/limits.js';
import type { ScreenPurpose, ScreenVerdict } from '../safety/screen.js';
import { stopFileForRoot } from '../scheduler/control.js';
import { PROJECT_ROOT } from '../layout/config.js';
import type { BcPage } from './driver.js';
import type { IntentStore } from './intent.js';
import type { RawTree } from './snapshot.js';

export interface EngineDeps {
  db: BetterSqlite3.Database;
  now: () => Date;
  env: NodeJS.ProcessEnv;
  cfg: LinkedinConfig;
  /** The session page. The MCP layer (task 3b) owns launch, lock and idle close; null means no session. */
  getPage: () => Promise<BcPage | null>;
  intents: IntentStore;
  /** Classifier screen for third-party page text (fail closed live, unscreened in dry run). */
  screen: (text: string, purpose: ScreenPurpose) => Promise<ScreenVerdict>;
  /** `.jobber/STOP` path (default: the project's). */
  stopFile?: string;
  /** LINKEDIN_SCREENSHOT flag (ships off). */
  screenshotEnabled?: boolean;
  /** Advisory layout telemetry: sees every tree the engine reads; never fails an action. */
  layoutFeed?: (tree: RawTree) => void;
  /** Called after a block page halted the platform (the MCP layer closes the session without saving). */
  afterBlock?: () => Promise<void>;
  /** Pause before each action in ms (default 300 to 900). */
  paceMs?: () => number;
  settleMs?: number;
  confirmTimeoutMs?: number;
}

export interface EngineResult {
  ok: boolean;
  code: string;
  reason?: string;
  /** Wrapped, screened page tree (fresh snapshot) when the action produced one. */
  state?: string;
  epoch?: number;
  status?: SendStatus;
  touch_id?: number;
  /** screenshot only: raw pixels, never classifier screened. */
  base64?: string;
  unscreened?: boolean;
}

export const refused = (code: string, reason: string): EngineResult => ({ ok: false, code, reason });

/** Kill switch and halt flags: the reason text, or null when the platform may act. */
export function killReason(deps: Pick<EngineDeps, 'db' | 'env' | 'stopFile'>): string | null {
  const stop = deps.stopFile ?? stopFileForRoot(PROJECT_ROOT);
  try { if (existsSync(stop)) return 'kill switch: STOP file'; } catch { return 'kill switch: STOP path unreadable'; }
  if (deps.env.JOBBER_KILL === '1') return 'kill switch: JOBBER_KILL';
  const h = haltReason(deps.db, 'linkedin');
  return h === null ? null : `linkedin halted: ${h}`;
}

const CAPTCHA_RE = /(quick security check|verify (that )?you('| a)re (a )?human|complete the captcha|captcha)/i;
const RESTRICTION_RE = /(your account (has been|is) (temporarily )?(restricted|limited|suspended)|we('| ha)ve (temporarily )?restricted|account restriction|unusual activity)/i;

/** Same rules as linkedin/state.ts detectBlock, over a browserctl tree. */
export function detectTreeBlock(tree: RawTree): BlockKind | null {
  const kind = classifyUrl(tree.url);
  if (kind === 'checkpoint') return 'checkpoint';
  const text = tree.nodes.map((n) => (n.role === 'text' ? n.text : n.name)).join('\n');
  const scanBody = text.length < 1500 || kind === 'other' || kind === 'login';
  const hay = [tree.title, scanBody ? text : tree.nodes.filter((n) => n.dialog !== undefined || n.role === 'dialog').map((n) => n.text || n.name).join('\n')].join('\n');
  if (CAPTCHA_RE.test(hay)) return 'captcha';
  if (RESTRICTION_RE.test(hay)) return 'restriction';
  if (kind === 'login' || tree.nodes.some((n) => n.secret)) return 'session_expired';
  return null;
}
