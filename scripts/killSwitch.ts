// ESM wrapper over the CommonJS kill-switch rule, so the hook and the launcher share one source.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const kill = require('../.claude/hooks/kill-switch.cjs') as {
  stopActive: (root: string, env: NodeJS.ProcessEnv) => { stopped: boolean; reason: string };
};

export const stopActive = kill.stopActive;
