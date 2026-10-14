// src/setup/steps/resume.ts
// Step 6: convert the user's own resume file to user-data/resume.json. One bounded model call
// (via ConvertDeps), a deterministic numbers check, and an explicit confirm before any write.
// The resume text is only ever written to <userDataDir>/resume.json (and its backup).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChecks } from '../../platform/doctor.js';
import { userDataDir } from '../../lib/userData.js';
import { convertResume, DOCX_MESSAGE, isDocx, summarizeResume, type ConvertDeps } from '../resumeConvert.js';
import type { SetupContext, SetupStep } from '../runner.js';
import { checksById } from './prereqs.js';

const FALLBACK_KEYS = [
  'name', 'jobTitle', 'email', 'phone', 'website', 'social', 'summary',
  'experience', 'projects', 'education', 'skills', 'certificates',
];

function inside(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The resolved path must be inside the user's home or the project root. */
export function checkPath(raw: string, home: string, root: string): string | null {
  const p = raw.trim();
  if (!p) return 'Enter a file path';
  if (isDocx(p)) return DOCX_MESSAGE;
  const resolved = path.resolve(p);
  if (!inside(path.resolve(home), resolved) && !inside(path.resolve(root), resolved)) {
    return 'The file must be inside your home folder or the project folder';
  }
  return null;
}

function defaultDeps(ctx: SetupContext): ConvertDeps {
  return {
    async readText(p) {
      if (isDocx(p)) throw new Error(DOCX_MESSAGE);
      if (path.extname(p).toLowerCase() === '.pdf') {
        // Import the lib file directly: the package index reads a test PDF when imported.
        // @ts-ignore: no types for the lib entry
        const mod = (await import('pdf-parse/lib/pdf-parse.js')) as {
          default: (b: Buffer) => Promise<{ text: string }>;
        };
        return (await mod.default(fs.readFileSync(p))).text;
      }
      return fs.readFileSync(p, 'utf8');
    },
    async runClaude(prompt, input) {
      // Argument array; stdin carries the resume text. One turn, no tools requested.
      const r = await ctx.run('claude', ['-p', prompt, '--max-turns', '1', '--output-format', 'text'], {
        input,
      });
      if (r.code !== 0) throw new Error('claude exited non-zero');
      return r.stdout;
    },
  };
}

export function makeResumeStep(override?: Partial<ConvertDeps>): SetupStep {
  return {
    id: 'resume',
    title: 'Convert your resume',
    checkIds: ['resume-valid'],
    async run(ctx) {
      const { io } = ctx;
      const deps: ConvertDeps = { ...defaultDeps(ctx), ...override };
      const dir = userDataDir(ctx.env, ctx.root);
      const target = path.join(dir, 'resume.json');
      const home = ctx.env.HOME ?? os.homedir();

      if (ctx.fs.exists(target)) {
        const res = await runChecks(checksById(['resume-valid']), ctx.doctor);
        if (res.every((r) => r.result.status === 'pass')) {
          if (!(await io.confirm('A valid resume is already in place. Replace it?', false))) return 'done';
        }
      }

      let keys = FALLBACK_KEYS;
      let shape: unknown;
      const tplPath = path.join(ctx.root, 'user-data.example', 'resume.json');
      if (ctx.fs.exists(tplPath)) {
        try {
          shape = JSON.parse(ctx.fs.read(tplPath));
          if (shape && typeof shape === 'object' && !Array.isArray(shape)) keys = Object.keys(shape);
        } catch {
          /* use the fallback keys */
        }
      }

      io.say(
        'Give the path to your resume (.pdf, .txt or .md). It stays on this machine except for one call to your own Claude.',
      );
      for (;;) {
        const raw = await io.ask('Resume file path', { validate: (v) => checkPath(v, home, ctx.root) });
        const result = await convertResume(path.resolve(raw.trim()), deps, keys, shape);
        if (!result.ok) {
          io.say(`Could not convert: ${result.problem}`);
        } else {
          io.say('Review what was read:');
          for (const l of summarizeResume(result.json)) io.say(`  ${l}`);
          for (const w of result.warnings) io.say(`  warning: ${w}`);
          if (await io.confirm('Write this as your base resume?', false)) {
            ctx.fs.mkdirp(dir, 0o700);
            ctx.fs.chmod(dir, 0o700);
            if (ctx.fs.exists(target)) {
              const ts = ctx.now().toISOString().replace(/[:.]/g, '-');
              ctx.fs.write(`${target}.bak-${ts}`, ctx.fs.read(target), 0o600);
            }
            ctx.fs.write(target, `${JSON.stringify(result.json, null, 2)}\n`, 0o600);
            ctx.fs.chmod(target, 0o600);
            io.say('The agent never edits this file; fix facts by editing user-data/resume.json by hand.');
            io.say('The tailoring gate allow-lists in user-data/fact-gate.json start empty; only you add to them.');
            return 'done';
          }
        }
        const next = await io.choose(
          'What next?',
          [
            { value: 'again', label: 'Try another file path' },
            { value: 'stop', label: 'Stop (resume step skipped)' },
          ],
          'again',
        );
        if (next === 'stop') return 'skipped';
      }
    },
  };
}

export const resumeStep: SetupStep = makeResumeStep();
