// Shared contracts for the LinkedIn MCP (plan 6C).
export type PageKind =
  | 'profile' | 'search' | 'feed' | 'messaging' | 'invitations' | 'jobs'
  | 'login' | 'checkpoint' | 'other';

export interface RawProfile {
  name: string;                       // from the visible header heading
  headline: string;
  degree: '1st' | '2nd' | '3rd' | null;
  location: string;
  about: string | null;
  actions: string[];                  // visible header action labels, e.g. ['Connect', 'Message', 'More']
  pending: boolean;                   // the Pending control is visible near the name
  hasBell: boolean;                   // "Manage notifications about <Name>" present (1st-degree signal)
  hasMessageButton: boolean;
}
export interface RawResult { name: string; headline: string; href: string }
export interface RawInvitation { index: number; name: string; headline: string; href: string }
export interface RawMessage { from: 'them' | 'me'; text: string }

export interface RawSnapshot {
  url: string;
  title: string;
  profile: RawProfile | null;
  results: RawResult[];               // search result cards (max 12)
  invitations: RawInvitation[];       // invitation manager rows (max 20)
  messages: RawMessage[];             // open message overlay or thread, last 6
  messageHeaderName: string | null;   // name shown in the open overlay header
  notices: string[];                  // visible toast/alert/banner text only
  dialogText: string | null;          // visible <dialog>/[role=dialog] text
  hasPasswordInput: boolean;
  bodyText: string;                   // visible text of the page, capped at 60000, NEVER surfaced to the model
}

// Structural browser types so fakes can implement them (patchright's real objects satisfy these).
export interface LiLocator {
  count(): Promise<number>;
  first(): LiLocator;
  nth(i: number): LiLocator;
  click(opts?: { timeout?: number; force?: boolean }): Promise<void>;
  fill(text: string, opts?: { timeout?: number }): Promise<void>;
  textContent(opts?: { timeout?: number }): Promise<string | null>;
  waitFor(opts?: { state?: 'visible' | 'hidden'; timeout?: number }): Promise<void>;
  evaluateAll<T>(fn: (els: any[]) => T): Promise<T>;
}
export interface LiPage {
  goto(url: string, opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  url(): string;
  title(): Promise<string>;
  evaluate<T = unknown>(src: string): Promise<T>;
  locator(selector: string): LiLocator;
  waitForTimeout(ms: number): Promise<void>;
  waitForResponse(pred: (r: any) => boolean, opts?: { timeout?: number }): Promise<unknown>;
  goBack(opts?: { timeout?: number; waitUntil?: string }): Promise<unknown>;
  keyboard: { press(key: string): Promise<void> };
  screenshot(opts?: { type?: 'png'; fullPage?: boolean }): Promise<Buffer>;
}
export interface LiContext {
  newPage(): Promise<LiPage>;
  storageState(opts?: { path?: string }): Promise<unknown>;
  waitForEvent(name: 'page', opts?: { timeout?: number }): Promise<LiPage>;
}
export interface LiBrowser { newContext(opts: Record<string, unknown>): Promise<LiContext>; close(): Promise<void> }
export interface LiLauncher { launch(opts: Record<string, unknown>): Promise<LiBrowser> }

export type SendStatus =
  | 'sent' | 'dry_run' | 'already_sent' | 'refused' | 'rate_limited'
  | 'halted' | 'unconfirmed' | 'failed';
export interface TypedResult {
  status: SendStatus;
  code: string;            // machine reason, e.g. 'recipient_mismatch', 'style_gate', 'quiet_hours'
  reason?: string;         // short human text, no page text
  touch_id?: number;
  would_send?: { kind: string; chars: number; recipient: string }; // dry_run only
}
