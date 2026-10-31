// file: src/accountPlan.ts
// Owner-editable account facts from user-data/account.json. Today only the LinkedIn plan. Fails soft: a missing,
// unreadable or invalid file means "unknown". Nothing in code branches on the plan; it is exposed so the operator
// and skills can read it (note quota detection still adapts at runtime via linkedin_note_quota_until).
import { readFileSync } from 'node:fs';
import { userDataPath } from './lib/userData.js';

export type LinkedinPlan = 'free' | 'premium' | 'unknown';
const PLANS: readonly string[] = ['free', 'premium', 'unknown'];

export function loadLinkedinPlan(file: string = userDataPath('account.json')): LinkedinPlan {
  try {
    const v = (JSON.parse(readFileSync(file, 'utf8')) as { linkedin_plan?: unknown } | null)?.linkedin_plan;
    const t = typeof v === 'string' ? v.trim().toLowerCase() : '';
    return PLANS.includes(t) ? (t as LinkedinPlan) : 'unknown';
  } catch {
    return 'unknown';
  }
}
