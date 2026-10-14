// src/update/config.ts
export interface UpdateConfig {
  enabled: boolean;
  remote: string;
  branch: string;
  tagPattern: string | null;
  requireSigned: boolean;
  signersFile: string | null;
  reviewPaths: string[];
  problems: string[];
}

export const DEFAULT_REVIEW_PATHS = [
  '.claude/settings.json',
  '.claude/hooks/',
  '.githooks/',
  'config/ccgram.pin.json',
  'scripts/ccgram/',
];

const REMOTE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const BRANCH_RE = /^[A-Za-z0-9_./-]{1,100}$/;
const TAG_RE = /^[A-Za-z0-9_.*-]{1,50}$/;

export function loadUpdateConfig(env: NodeJS.ProcessEnv): UpdateConfig {
  const problems: string[] = [];

  const remote = env.AUTO_UPDATE_REMOTE ?? 'origin';
  if (!REMOTE_RE.test(remote) || remote.startsWith('-') || remote.includes('..')) {
    problems.push('AUTO_UPDATE_REMOTE is not a valid remote name');
  }

  const branch = env.AUTO_UPDATE_BRANCH ?? 'main';
  if (!BRANCH_RE.test(branch) || branch.startsWith('-') || branch.includes('..')) {
    problems.push('AUTO_UPDATE_BRANCH is not a valid branch name');
  }

  let tagPattern: string | null = null;
  const rawTag = env.AUTO_UPDATE_TAG_PATTERN;
  if (rawTag !== undefined && rawTag !== '') {
    if (!TAG_RE.test(rawTag) || rawTag.startsWith('-') || rawTag.includes('..')) {
      problems.push('AUTO_UPDATE_TAG_PATTERN is not a valid tag pattern');
    } else {
      tagPattern = rawTag;
    }
  }

  const enabled = env.AUTO_UPDATE === 'true';
  const requireSigned = env.AUTO_UPDATE_REQUIRE_SIGNED !== 'false';
  const rawSigners = env.AUTO_UPDATE_SIGNERS_FILE?.trim();
  const signersFile = rawSigners ? rawSigners : null;
  if (enabled && requireSigned && !signersFile) {
    problems.push('AUTO_UPDATE_REQUIRE_SIGNED is on but AUTO_UPDATE_SIGNERS_FILE is not set (no signers to verify against)');
  }

  let reviewPaths = DEFAULT_REVIEW_PATHS;
  if (env.AUTO_UPDATE_REVIEW_PATHS !== undefined) {
    const parsed = env.AUTO_UPDATE_REVIEW_PATHS.split(',').map((s) => s.trim()).filter(Boolean);
    if (parsed.length > 0) reviewPaths = parsed;
  }

  return { enabled, remote, branch, tagPattern, requireSigned, signersFile, reviewPaths: [...reviewPaths], problems };
}
