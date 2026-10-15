// src/platform/checkLists.ts
// The one list of doctor check lists. scripts/doctor.ts and the dry-run verify engine both use it;
// append a new list here, never in two places.
import type { Check } from './doctor.js';
import { ccgramChecks, restrictedChecks } from './checks.js';
import { setupChecks } from './checksSetup.js';
import { schedulerChecks } from './checksScheduler.js';
import { updateBackupChecks } from './updateBackupChecks.js';
import { layoutChecks } from './checksLayout.js';
import { bootstrapChecks } from './checksBootstrap.js';
import { setupGuideChecks } from './checksGuide.js';
import { apiKeysChecks } from './checksApiKeys.js';
import { linkedinBrowserChecks } from '../linkedin/chromeCheck.js';

export function allDoctorChecks(): Check[] {
  return [
    ...ccgramChecks, ...restrictedChecks(), ...setupChecks, ...linkedinBrowserChecks(), ...schedulerChecks(),
    ...layoutChecks(), ...updateBackupChecks(), ...bootstrapChecks(), ...setupGuideChecks(),
    ...apiKeysChecks,
  ];
}
