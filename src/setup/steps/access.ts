// src/setup/steps/access.ts
// Step 9: permission set, ccgram hooks, .gitignore rules. The permission set is the ceiling for
// every session; nothing here uses skip-permissions or bypassPermissions.
import path from 'node:path';
import { installHooksToFile, resolveCcgramPython } from '../../platform/ccgramHooks.js';
import {
  applySetToFile,
  validateSets,
  type RawSets,
  type SetName,
} from '../../platform/permissions.js';
import type { SetupContext, SetupStep } from '../runner.js';

const REQUIRED_IGNORES = [
  '.ccgram/',
  '.claude/settings.local.json',
  '.claude/settings.local.managed.json',
  '.env',
];
const OPTIONAL_IGNORES = ['user-data/', 'secrets/'];

function ignored(lines: string[], rule: string): boolean {
  const bare = rule.replace(/\/$/, '');
  return lines.some((l) => l === rule || l === bare || l === '/' + rule || l === '/' + bare);
}

async function chooseSet(ctx: SetupContext): Promise<SetName> {
  const { io } = ctx;
  io.say('read_only: look at stats, drafts and status; nothing is sent, applied or changed.');
  io.say('outreach_send: read_only plus the tools that fetch jobs, queue outreach, and send email, connect and apply (still bound by the daily caps).');
  io.say('full: whole servers, every tool they expose. Only for someone who has read the tool list.');
  const pick = await io.choose<SetName>(
    'Which permission set should sessions run with?',
    [
      { value: 'read_only', label: 'read_only (default)' },
      { value: 'outreach_send', label: 'outreach_send' },
      { value: 'full', label: 'full' },
    ],
    'read_only',
  );
  if (pick !== 'full') return pick;
  const typed = await io.ask('Type the word full to confirm the full set (anything else keeps read_only)', {
    default: '',
  });
  if (typed.trim() === 'full') return 'full';
  io.say('Not confirmed: using read_only.');
  return 'read_only';
}

export const accessStep: SetupStep = {
  id: 'access',
  title: 'Permission set and hooks',
  checkIds: ['permission-set', 'project-hooks', 'gitignore'],
  async run(ctx) {
    const { io, root } = ctx;
    const setsPath = path.join(root, 'config', 'permission-sets.json');
    if (!ctx.fs.exists(setsPath)) throw new Error('config/permission-sets.json is missing');
    let sets: RawSets;
    try {
      sets = JSON.parse(ctx.fs.read(setsPath)) as RawSets;
    } catch {
      throw new Error('config/permission-sets.json is not valid JSON');
    }
    validateSets(sets);
    const name = await chooseSet(ctx);

    const claudeDir = path.join(root, '.claude');
    const settingsPath = path.join(claudeDir, 'settings.local.json');
    ctx.fs.mkdirp(claudeDir, 0o755);
    // Throws on invalid JSON with nothing written; the runner shows the message.
    applySetToFile(settingsPath, sets, name);
    io.say(`Permission set applied: ${name}.`);

    let hooksSkipped = false;
    const which = await ctx.run('which', ['ccgram']);
    const exe = which.code === 0 ? which.stdout.trim() : '';
    const python = resolveCcgramPython({
      which: () => (exe === '' ? null : exe),
      readFirstLine: (p) => {
        try {
          return ctx.fs.read(p).split('\n', 1)[0] ?? '';
        } catch {
          return '';
        }
      },
    });
    if (python === null) {
      io.say('Could not find the ccgram interpreter. Fix: install the pinned ccgram first, then rerun: npm run setup -- --step access');
      hooksSkipped = true;
    } else {
      installHooksToFile(settingsPath, python);
      io.say('ccgram hooks installed in .claude/settings.local.json.');
    }

    const giPath = path.join(root, '.gitignore');
    const giText = ctx.fs.exists(giPath) ? ctx.fs.read(giPath) : '';
    const lines = giText.split('\n').map((l) => l.trim());
    const append = async (rules: string[], question: string): Promise<void> => {
      if (rules.length === 0) return;
      io.say('Missing from .gitignore:');
      for (const r of rules) io.say(`  ${r}`);
      if (!(await io.confirm(question, true))) return;
      const cur = ctx.fs.exists(giPath) ? ctx.fs.read(giPath) : '';
      const sep = cur === '' || cur.endsWith('\n') ? '' : '\n';
      ctx.fs.write(giPath, cur + sep + rules.join('\n') + '\n', 0o644);
    };
    await append(REQUIRED_IGNORES.filter((r) => !ignored(lines, r)), 'Append these to .gitignore?');
    await append(OPTIONAL_IGNORES.filter((r) => !ignored(lines, r)), 'Also keep these private by appending them to .gitignore?');

    io.say('Sessions never use skip-permissions. The permission set is the ceiling for what they may do.');
    return hooksSkipped ? 'skipped' : 'done';
  },
};
