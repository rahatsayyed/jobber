// src/outreach/config.ts
export interface OutreachConfig {
  linkedinMaxInvitesPerDay: number;
  linkedinMaxMessagesPerDay: number;
  naukriMaxAppliesPerDay: number;
  naukriMaxMessagesPerDay: number;
  wellfoundMaxAppliesPerDay: number;
  wellfoundMaxMessagesPerDay: number;
  wellfoundMaxDiscoverPerDay: number;
  applyMaxAttemptsPerDay: number;
  siteMaxAccountsPerDay: number;
  linkedinMaxDiscoverPerDay: number;
  companyContactLimit: number;
  speculativeCompanyLimit: number;
  quietStartHour: number;
  quietEndHour: number;
}

const DEFAULTS: OutreachConfig = {
  linkedinMaxInvitesPerDay: 40,
  linkedinMaxMessagesPerDay: 100,
  naukriMaxAppliesPerDay: 30,
  naukriMaxMessagesPerDay: 40,
  wellfoundMaxAppliesPerDay: 20,
  wellfoundMaxMessagesPerDay: 20,
  wellfoundMaxDiscoverPerDay: 12,
  applyMaxAttemptsPerDay: 30,
  siteMaxAccountsPerDay: 2,
  linkedinMaxDiscoverPerDay: 12,
  companyContactLimit: 5,
  speculativeCompanyLimit: 2,
  quietStartHour: 1,
  quietEndHour: 7,
};

const ENV_KEYS: Record<keyof OutreachConfig, string> = {
  linkedinMaxInvitesPerDay: 'LINKEDIN_MAX_INVITES_PER_DAY',
  linkedinMaxMessagesPerDay: 'LINKEDIN_MAX_MESSAGES_PER_DAY',
  naukriMaxAppliesPerDay: 'NAUKRI_MAX_APPLIES_PER_DAY',
  naukriMaxMessagesPerDay: 'NAUKRI_MAX_MESSAGES_PER_DAY',
  wellfoundMaxAppliesPerDay: 'WELLFOUND_MAX_APPLIES_PER_DAY',
  wellfoundMaxMessagesPerDay: 'WELLFOUND_MAX_MESSAGES_PER_DAY',
  wellfoundMaxDiscoverPerDay: 'WELLFOUND_MAX_DISCOVER_PER_DAY',
  applyMaxAttemptsPerDay: 'APPLY_MAX_ATTEMPTS_PER_DAY',
  siteMaxAccountsPerDay: 'SITE_MAX_ACCOUNTS_PER_DAY',
  linkedinMaxDiscoverPerDay: 'LINKEDIN_MAX_DISCOVER_PER_DAY',
  companyContactLimit: 'COMPANY_CONTACT_LIMIT',
  speculativeCompanyLimit: 'SPECULATIVE_COMPANY_LIMIT',
  quietStartHour: 'QUIET_HOURS_START',
  quietEndHour: 'QUIET_HOURS_END',
};

function parse(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
}

export function loadOutreachConfig(env: NodeJS.ProcessEnv = process.env): OutreachConfig {
  const config = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS) as (keyof OutreachConfig)[]) {
    const max = key.endsWith('Hour') ? 23 : 100000;
    config[key] = parse(env[ENV_KEYS[key]], DEFAULTS[key], max);
  }
  return config;
}
