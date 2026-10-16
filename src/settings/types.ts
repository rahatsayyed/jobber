// src/settings/types.ts
// One definition of an env key for the dashboard settings editor (plan 8H).

export type SectionId =
  | 'credentials-sources'
  | 'credentials-gmail'
  | 'safety'
  | 'classifier'
  | 'limits'
  | 'linkedin'
  | 'naukri'
  | 'scheduler'
  | 'dashboard'
  | 'telegram'
  | 'layout'
  | 'update-backup'
  | 'advanced'
  | 'web-core'
  | 'search'
  | 'apply';

export type EnvType = 'bool' | 'int' | 'enum' | 'string' | 'path' | 'url' | 'email' | 'list' | 'intList' | 'secret';
export type EditTier = 'never' | 'safety' | 'guarded' | 'normal';
export type RestartScope = 'none' | 'next_run' | 'dashboard' | 'scheduler' | 'mcp' | 'stack';
export type Weakens = 'true' | 'false' | 'increase' | 'decrease' | 'cleared' | 'any' | null;

export interface EnvSpec {
  key: string;
  section: SectionId;
  feature: string; // 'email outreach', 'dashboard', ...
  type: EnvType;
  default: string | null; // what the code uses when blank/absent; null = no default
  exampleActive: boolean; // listed as KEY= (true) or # KEY= (false) in .env.example
  required: 'required' | 'optional' | 'conditional';
  requiredWhen?: string;
  min?: number;
  max?: number;
  allowed?: readonly string[];
  maxLen?: number;
  itemCount?: number;
  secret: boolean;
  tier: EditTier;
  tierReason: string;
  weakens: Weakens;
  restart: RestartScope;
  restartEvidence?: string;
  blankMeansDefault: boolean;
  about: string; // one to three sentences for the UI and the generated comment
  note?: string;
  docs?: string;
  auditValue: boolean;
}

export type ChangeOp =
  | { key: string; op: 'set'; value: string }
  | { key: string; op: 'clear' }
  | { key: string; op: 'reset' };

// secret: before is 'set' | 'not set', after is 'set' | 'replaced' | 'cleared' (words only, never a value)
export interface FieldDiff {
  key: string;
  before: string;
  after: string;
  secret: boolean;
}

// What the friction policy needs to know about the caller (the real policy is plan 8H Task 6).
export interface PolicyCtx {
  editEnabled: boolean;
  remoteExposure: boolean;
  remoteSafetyAllowed: boolean;
  sessionFresh: boolean;
}

export interface Friction {
  refuse?: string;
  reauth: boolean;
  phrase: string | null;
}
