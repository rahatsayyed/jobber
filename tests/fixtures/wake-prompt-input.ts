// A rich whole-wake input for buildWakePrompt: the golden file tests/fixtures/wake-prompt-full.txt was generated from the prompt builder as it
// was BEFORE Phase 3c, so tests/wake-windows.test.ts proves the all-steps prompt is unchanged byte for byte.
import type { OwnerInstruction } from '../../src/owner/instructions.js';
import type { Step } from '../../src/scheduler/plan.js';

export const FULL_ORDER: Step[] = [
  { operator: 'code', kind: 'manual', quota: 2 },
  { operator: 'code', kind: 'discover_scripts', quota: 1 },
  { operator: 'source-operator', kind: 'discover_agent', quota: 4 },
  { operator: 'linkedin-operator', platform: 'linkedin', kind: 'manual_url', quota: 1 },
  { operator: 'naukri-operator', platform: 'naukri', kind: 'manual_url', quota: 1 },
  { operator: 'wellfound-operator', platform: 'wellfound', kind: 'manual_url', quota: 1 },
  { operator: 'linkedin-operator', platform: 'linkedin', kind: 'discover', quota: 2, searches: { jobs: ['react-india'], posts: ['hiring-react'] } },
  { operator: 'naukri-operator', platform: 'naukri', kind: 'discover', quota: 5, searches: { jobs: ['full-stack-react-india'], posts: [] } },
  { operator: 'wellfound-operator', platform: 'wellfound', kind: 'discover', quota: 5, searches: { jobs: ['full-stack-react-india-remote'], posts: [] } },
  { operator: 'naukri-operator', platform: 'naukri', kind: 'jd_fetch', quota: 6 },
  { operator: 'linkedin-operator', platform: 'linkedin', kind: 'accept_recent', quota: 1 },
  { operator: 'pipeline', kind: 'pipeline', quota: 9 },
  { operator: 'linkedin-operator', platform: 'linkedin', kind: 'inbox', quota: 5 },
  { operator: 'naukri-operator', platform: 'naukri', kind: 'inbox', quota: 5 },
  { operator: 'linkedin-operator', platform: 'linkedin', kind: 'followups', quota: 3, chunks: [3] },
  { operator: 'naukri-operator', platform: 'naukri', kind: 'followups', quota: 2, chunks: [2] },
  { operator: 'linkedin-operator', platform: 'linkedin', kind: 'new_outreach', quota: 12, chunks: [5, 5, 2] },
  { operator: 'apply-operator', kind: 'apply', quota: 7, chunks: [5, 2] },
];

export const PIPELINE_INPUT = {
  matchThreshold: 60,
  sendLimit: 1,
  targetRegions: 'Target regions: home=india; targets=uae, saudi arabia; remote OK=true; remote anywhere=true',
  followupsAutonomous: false,
  codePass: null,
  jdLine: 'JD fetched 3, unavailable 1, waiting 5',
};

export const INSTRUCTIONS: OwnerInstruction[] = [
  {
    id: 7, text: 'Skip Acme this week', scope: 'company', job_id: null, escalation_id: null, company_key: 'acme',
    status: 'in_progress', result_note: null, created_at: '2026-10-15T09:00:00.000Z', updated_at: '2026-10-15T09:00:00.000Z',
  },
];

export function fullWakeInput() {
  return {
    runId: 'abcd1234',
    dryRun: false,
    tasks: [],
    budget: { maxWallSec: 900, maxTokensApprox: 150000 },
    allowed: ['linkedin' as const, 'naukri' as const, 'wellfound' as const],
    now: new Date('2026-10-15T10:00:00Z'),
    order: FULL_ORDER,
    pipeline: PIPELINE_INPUT,
    instructions: INSTRUCTIONS,
  };
}
