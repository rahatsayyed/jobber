// src/setup/steps/userdata.ts
// Step 2: create user-data/ from the templates in user-data.example/. Never overwrites an existing file.
// Creates fact-gate.json (empty allow-lists), account.json, languages.json and the other templates.
import path from 'node:path';
import { planInit, userDataDir } from '../../lib/userData.js';
import type { SetupStep } from '../runner.js';

export const userdataStep: SetupStep = {
  id: 'userdata',
  title: 'Create user-data from templates',
  checkIds: ['fact-gate-present'],
  async run(ctx) {
    const { io } = ctx;
    const dir = userDataDir(ctx.env, ctx.root);
    ctx.fs.mkdirp(dir, 0o700);
    const ops = planInit(ctx.root, (p) => ctx.fs.exists(p), ctx.env);
    const made: string[] = [];
    const noTemplate: string[] = [];
    for (const op of ops) {
      if (!ctx.fs.exists(op.from)) {
        noTemplate.push(path.basename(op.to));
        continue;
      }
      ctx.fs.copy(op.from, op.to, 0o600);
      made.push(path.basename(op.to));
    }
    io.say(made.length > 0 ? `Created from templates: ${made.join(', ')}` : 'user-data already has every template file.');
    if (noTemplate.length > 0) {
      io.say(`Template missing in user-data.example/: ${noTemplate.join(', ')}. Run: git checkout user-data.example`);
      return 'pending';
    }
    return 'done';
  },
};
