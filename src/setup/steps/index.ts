// src/setup/steps/index.ts
// The wizard's step order.
import type { SetupStep } from '../runner.js';
import { accessStep } from './access.js';
import { claudeStep } from './claude.js';
import { classifierStep } from './classifier.js';
import { dashboardStep } from './dashboard.js';
import { finalStep } from './final.js';
import { gmailStep } from './gmail.js';
import { limitsStep } from './limits.js';
import { prereqsStep } from './prereqs.js';
import { profileStep } from './profile.js';
import { resumeStep } from './resume.js';
import { sessionsStep } from './sessions.js';
import { telegramStep } from './telegram.js';

export const ALL_STEPS: SetupStep[] = [
  prereqsStep,
  claudeStep,
  telegramStep,
  gmailStep,
  sessionsStep,
  resumeStep,
  profileStep,
  limitsStep,
  accessStep,
  classifierStep,
  dashboardStep,
  finalStep,
];
