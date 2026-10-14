// src/setup/steps/resume.ts
// Step 6: convert the user's own resume file to user-data/resume.json. One bounded model call
// (via ConvertDeps), a deterministic numbers check, and an explicit confirm before any write.
// The resume text is only ever written to <userDataDir>/resume.json (and its backup).
import { spawn } from 'node:child_process';
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

// What a user typed or dragged into the terminal: surrounding quotes stripped, backslash-space
// unescaped, a leading ~ expanded to home. Pure string work; nothing is read.
export function normalizeUserPath(raw: string, home: string): string {
  let p = raw.trim();
  if (p.length >= 2 && (p[0] === '"' || p[0] === "'") && p.endsWith(p[0])) p = p.slice(1, -1).trim();
  p = p.split('\\ ').join(' ');
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

// Secrets and local data of this project are never a resume source (the text goes to Claude).
function isProjectSecret(resolved: string, root: string, dataDir: string): boolean {
  const r = path.resolve(root);
  const base = path.basename(resolved);
  if (path.dirname(resolved) === r && (base.startsWith('.env') || base.startsWith('data.sqlite'))) return true;
  return (
    inside(path.join(r, 'secrets'), resolved) ||
    inside(path.join(r, 'user-data'), resolved) ||
    inside(path.resolve(dataDir), resolved)
  );
}

// The normalized path must be inside the user's home or the project root, and not a secret.
export function checkPath(raw: string, home: string, root: string, dataDir?: string): string | null {
  const p = normalizeUserPath(raw, home);
  if (!p) return 'Enter a file path';
  if (isDocx(p)) return DOCX_MESSAGE;
  const resolved = path.resolve(p);
  if (!inside(path.resolve(home), resolved) && !inside(path.resolve(root), resolved)) {
    return 'The file must be inside your home folder or the project folder';
  }
  if (isProjectSecret(resolved, root, dataDir ?? path.join(root, 'user-data'))) {
    return "That file holds this project's secrets or data and cannot be used as a resume source";
  }
  return null;
}

export interface ClaudeSpawnOpts {
  cwd: string;
  env: Record<string, string>;
  input: string;
  timeoutMs: number;
  maxBytes: number;
}
export type ClaudeSpawn = (
  cmd: string,
  args: string[],
  opts: ClaudeSpawnOpts,
) => Promise<{ stdout: string; code: number }>;

export const CLAUDE_TIMEOUT_MS = 120_000;
export const CLAUDE_MAX_BYTES = 1_000_000;
const ENV_ALLOW = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'USER', 'TMPDIR'];

/** No tools, no MCP servers, user settings only (no project settings), no skills, no prompts,
 *  and no transcript written to disk. User-level hooks still load (--bare needs an API key). */
export function claudeArgs(prompt: string): string[] {
  return [
    '-p', prompt,
    '--output-format', 'text',
    '--max-turns', '1',
    '--permission-mode', 'dontAsk',
    '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', 'user',
    '--no-session-persistence',
    '--disable-slash-commands',
  ];
}

/** Argument array, stdin input, hard timeout, bounded output. */
export const defaultClaudeSpawn: ClaudeSpawn = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    let size = 0;
    let over = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > opts.maxBytes) {
        over = true;
        child.kill('SIGKILL');
      } else out += d.toString('utf8');
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (over) reject(new Error('output too large'));
      else resolve({ stdout: out, code: code ?? 1 });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(opts.input);
  });

function defaultDeps(ctx: SetupContext, spawnClaude: ClaudeSpawn): ConvertDeps {
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
      // The neutral cwd means project commands are not visible, so inline the command body.
      let full = prompt;
      const cmdPath = path.join(ctx.root, '.claude', 'commands', 'setup-resume.md');
      if (ctx.fs.exists(cmdPath)) {
        const body = ctx.fs.read(cmdPath).replace(/^---[\s\S]*?---\s*/, '');
        full = prompt.replace(/^\/setup-resume\n/, () => `${body}\n`);
      }
      const cwd = path.join(os.tmpdir(), 'jobber-setup-resume');
      ctx.fs.mkdirp(cwd, 0o700);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(ctx.env)) {
        if (v === undefined) continue;
        // Claude's own auth and config only; every other key (Gmail, Telegram, ...) is dropped.
        if (ENV_ALLOW.includes(k) || k.startsWith('ANTHROPIC_') || k.startsWith('CLAUDE_')) env[k] = v;
      }
      const r = await spawnClaude('claude', claudeArgs(full), {
        cwd,
        env,
        input,
        timeoutMs: CLAUDE_TIMEOUT_MS,
        maxBytes: CLAUDE_MAX_BYTES,
      });
      if (r.code !== 0) throw new Error('claude exited non-zero');
      return r.stdout;
    },
  };
}

export function makeResumeStep(
  override?: Partial<ConvertDeps>,
  spawnClaude: ClaudeSpawn = defaultClaudeSpawn,
): SetupStep {
  return {
    id: 'resume',
    title: 'Convert your resume',
    checkIds: ['resume-valid'],
    async run(ctx) {
      const { io } = ctx;
      const deps: ConvertDeps = { ...defaultDeps(ctx, spawnClaude), ...override };
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
        const raw = await io.ask('Resume file path', { validate: (v) => checkPath(v, home, ctx.root, dir) });
        const result = await convertResume(path.resolve(normalizeUserPath(raw, home)), deps, keys, shape);
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
            const tmp = `${target}.tmp-${process.pid}`;
            ctx.fs.write(tmp, `${JSON.stringify(result.json, null, 2)}\n`, 0o600);
            ctx.fs.rename(tmp, target);
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
