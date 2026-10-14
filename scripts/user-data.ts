// scripts/user-data.ts
import { chmodSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { planInit, planMigration, userDataDir } from '../src/lib/userData.js';

const root = resolve(import.meta.dirname, '..');
const command = process.argv[2];
const ops =
  command === 'migrate' ? planMigration(root, existsSync) : command === 'init' ? planInit(root, existsSync) : null;

if (!ops) {
  console.error('usage: npm run user-data -- <init|migrate>');
  process.exit(2);
}

const dir = userDataDir(process.env, root);
mkdirSync(dir, { recursive: true, mode: 0o700 });
chmodSync(dir, 0o700);
for (const op of ops) {
  mkdirSync(dirname(op.to), { recursive: true });
  copyFileSync(op.from, op.to);
  chmodSync(op.to, 0o600);
  console.log(`copied ${op.from.replace(root + '/', '')} -> ${op.to.replace(root + '/', '')}`);
}
console.log(ops.length ? `${ops.length} file(s) copied` : 'nothing to copy');
