// src/platform/launchCheck.ts
// Launcher check: the classifier profile chosen by CLASSIFIER_MODEL must be present, verified and
// pinned; outside dry runs it must also be fitted for the pinned model file. Never prints env values.
import {
  isFullyPinned,
  loadRegistry,
  resolveProfile,
  type ClassifierProfile,
  type ClassifierRegistry,
} from '../safety/classifierRegistry.js';
import { verifyProfile, type VerifyReport } from '../safety/modelFetch.js';

export interface LaunchCheckDeps {
  loadRegistry(): ClassifierRegistry;
  verifyProfile(p: ClassifierProfile, root: string): Promise<VerifyReport>;
}
export interface LaunchCheckResult {
  ok: boolean;
  problems: string[];
  profileId?: string;
}

export async function checkClassifierForLaunch(
  env: NodeJS.ProcessEnv,
  root: string,
  dryRun: boolean,
  deps: Partial<LaunchCheckDeps> = {},
): Promise<LaunchCheckResult> {
  const load = deps.loadRegistry ?? (() => loadRegistry());
  const verify = deps.verifyProfile ?? verifyProfile;
  let profile: ClassifierProfile;
  try {
    profile = resolveProfile(load(), env);
  } catch (e) {
    return { ok: false, problems: [(e as Error).message] };
  }
  const problems: string[] = [];
  let report: VerifyReport;
  try {
    report = await verify(profile, root);
  } catch (e) {
    return { ok: false, problems: [`profile ${profile.id}: ${(e as Error).message}`], profileId: profile.id };
  }
  if (!report.ok) problems.push(...report.problems.map((p) => `${profile.id}: ${p}`));
  if (!isFullyPinned(profile)) problems.push(`${profile.id}: not fully pinned (run npm run models -- pin ${profile.id})`);
  if (!dryRun) {
    const model = profile.files.find((f) => f.role === 'model');
    const fit = profile.fit;
    if (typeof fit.threshold !== 'number') problems.push(`${profile.id}: no fitted threshold`);
    else if (!model || !model.sha256 || fit.model_sha256 !== model.sha256) {
      problems.push(`${profile.id}: fit does not match the pinned model file`);
    }
  }
  return { ok: problems.length === 0, problems, profileId: profile.id };
}
