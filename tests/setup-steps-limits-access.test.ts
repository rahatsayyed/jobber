// tests/setup-steps-limits-access.test.ts
// Steps 8 and 9. IO is scripted; files live in a throwaway temp dir because the permission and
// hook writers use node fs directly. Nothing here touches the real .env or settings files.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checksById } from '../src/setup/steps/prereqs.js';
import { runChecks, type DoctorContext } from '../src/platform/doctor.js';
import { redactingIO, scriptedIO, type ScriptItem } from '../src/setup/io.js';
import { LIMITS } from '../src/setup/limitsCatalog.js';
import type { SetupContext, SetupFs } from '../src/setup/runner.js';
import { emptyState } from '../src/setup/state.js';
import { accessStep } from '../src/setup/steps/access.js';
import { limitsStep } from '../src/setup/steps/limits.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const nodeFs: SetupFs = {
  exists: (p) => existsSync(p),
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, d, m) => {
    writeFileSync(p, d, { mode: m });
    chmodSync(p, m);
  },
  rename: (a, b) => renameSync(a, b),
  chmod: (p, m) => chmodSync(p, m),
  remove: (p) => rmSync(p, { force: true }),
  mkdirp: (p, m) => void mkdirSync(p, { recursive: true, mode: m }),
  copy: () => undefined,
  list: (p) => readdirSync(p),
};

function setup(script: ScriptItem[], files: Record<string, string> = {}, ccgram: string | null = null) {
  const root = mkdtempSync(path.join(tmpdir(), 'jobber-step-'));
  dirs.push(root);
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  let exe = '';
  if (ccgram !== null) {
    exe = path.join(root, 'bin-ccgram');
    writeFileSync(exe, ccgram);
  }
  const sio = scriptedIO(script);
  const run = (async (cmd: string) => {
    if (cmd === 'which') return exe ? { stdout: exe + '\n', stderr: '', code: 0 } : { stdout: '', stderr: '', code: 1 };
    return { stdout: '', stderr: '', code: 0 };
  }) as unknown as SetupContext['run'];
  const doctor: DoctorContext = {
    root,
    env: {},
    run,
    fs: { exists: (p) => existsSync(p), read: (p) => readFileSync(p, 'utf8'), mode: () => null },
  };
  const ctx: SetupContext = {
    io: redactingIO(sio),
    root,
    env: {},
    fs: nodeFs,
    run,
    spawnInteractive: async () => 0,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    now: () => new Date('2026-10-14T00:00:00Z'),
    doctor,
    state: emptyState(),
    statePath: path.join(root, 'user-data', '.setup-state.json'),
    envPath: path.join(root, '.env'),
  };
  return { ctx, sio, root, doctor };
}

const group = (g: string) => LIMITS.filter((l) => l.group === g);
const askAll = (g: string, over: Record<string, string> = {}): ScriptItem[] =>
  group(g).map((l) => ({ ask: over[l.key] ?? '' }));

const envOf = (root: string): Map<string, string> => {
  const m = new Map<string, string>();
  for (const line of readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const x = /^([A-Z_]+)=(.*)$/.exec(line);
    if (x) m.set(x[1], x[2]);
  }
  return m;
};

describe('limitsStep', () => {
  it('safe defaults fill missing keys, keep existing values, clear inline comments', async () => {
    const t = setup(
      [{ choose: 'safe' }],
      { '.env.example': 'MATCH_THRESHOLD=70   # keep this\nSEND_LIMIT_PER_RUN=\nOTHER=keepme   # note\nSECRET_X=abc\n' },
    );
    expect(await limitsStep.run(t.ctx)).toBe('done');
    const env = envOf(t.root);
    expect(env.get('MATCH_THRESHOLD')).toBe('70');
    expect(env.get('SEND_LIMIT_PER_RUN')).toBe('1');
    expect(env.get('OTHER')).toBe('keepme');
    expect(env.get('SECRET_X')).toBe('abc');
    for (const l of LIMITS) expect(env.get(l.key)).toBeDefined();
    const text = readFileSync(path.join(t.root, '.env'), 'utf8');
    expect(text).toContain('# keep this');
    const [limits, inline] = await runChecks(checksById(['env-limits', 'env-inline-comments']), t.doctor);
    expect(limits.result.status).toBe('pass');
    expect(inline.result.status).toBe('pass');
    t.sio.assertDone();
  });

  it('leave as is writes nothing', async () => {
    const t = setup([{ choose: 'leave' }], { '.env': 'A=1\n' });
    await limitsStep.run(t.ctx);
    expect(readFileSync(path.join(t.root, '.env'), 'utf8')).toBe('A=1\n');
  });

  it('a min above max re-prompts until the pair is consistent', async () => {
    const no = { confirm: false } as ScriptItem;
    const pacing = group('pacing').map((l) => l.key);
    const t = setup(
      [
        { choose: 'review' },
        no, no, no, no, no, // matching, daily, weekly, per-company, quiet-hours
        { confirm: true }, // pacing
        ...pacing.flatMap((k): ScriptItem[] =>
          k === 'PACING_MIN_BURST' ? [{ ask: '9' }, { confirm: true }] : [{ ask: '' }],
        ),
        no, // cooldowns
        // conflict found after all groups: re-asked MIN then MAX
        { ask: '2' },
        { confirm: true }, // 2 is above default 1
        { ask: '' },
      ],
      { '.env': '' },
    );
    await limitsStep.run(t.ctx);
    const env = envOf(t.root);
    expect(env.get('PACING_MIN_BURST')).toBe('2');
    expect(env.get('PACING_MAX_BURST')).toBe('4');
    expect(t.sio.transcript.some((l) => l.includes('is above PACING_MAX_BURST'))).toBe(true);
    t.sio.assertDone();
  });

  it('a value above the default needs a confirm; declining asks again', async () => {
    const no = { confirm: false } as ScriptItem;
    const daily = group('daily-caps').map((l) => l.key);
    const t = setup(
      [
        { choose: 'review' },
        no, // matching
        { confirm: true }, // daily-caps
        ...daily.flatMap((k): ScriptItem[] =>
          // decline 5, then the same key is asked again and keeps the current value
          k === 'SEND_LIMIT_PER_RUN' ? [{ ask: '5' }, { confirm: false }, { ask: '' }] : [{ ask: '' }],
        ),
        no, no, no, no, no,
      ],
      { '.env': '' },
    );
    await limitsStep.run(t.ctx);
    expect(envOf(t.root).get('SEND_LIMIT_PER_RUN')).toBe('1');
    t.sio.assertDone();
  });
});

const SETS = readFileSync(path.join(process.cwd(), 'config', 'permission-sets.json'), 'utf8');
const BASE_GI = '.ccgram/\n.claude/settings.local.json\n.claude/settings.local.managed.json\n.env\nuser-data/\nsecrets/\n';
const SHEBANG = '#!/opt/ccgram/bin/python3\nimport x\n';
const files = (extra: Record<string, string> = {}) => ({
  'config/permission-sets.json': SETS,
  '.gitignore': BASE_GI,
  ...extra,
});
const readSettings = (root: string) =>
  JSON.parse(readFileSync(path.join(root, '.claude', 'settings.local.json'), 'utf8')) as {
    permissions: { allow: string[] };
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };

describe('accessStep', () => {
  it('applies read_only by default and installs hooks', async () => {
    const t = setup([{ choose: 'read_only' }], files(), SHEBANG);
    expect(await accessStep.run(t.ctx)).toBe('done');
    const s = readSettings(t.root);
    expect(s.permissions.allow).toContain('mcp__db__get_funnel');
    expect(s.permissions.allow).not.toContain('mcp__db__enqueue_outreach');
    expect(Object.keys(s.hooks)).toHaveLength(9);
    t.sio.assertDone();
  });

  it('full without typing the word full falls back to read_only', async () => {
    const t = setup([{ choose: 'full' }, { ask: 'yes' }], files(), SHEBANG);
    await accessStep.run(t.ctx);
    const allow = readSettings(t.root).permissions.allow;
    expect(allow).not.toContain('mcp__db__enqueue_outreach');
    expect(JSON.parse(readFileSync(path.join(t.root, '.claude', 'settings.local.managed.json'), 'utf8')).set).toBe('read_only');
  });

  it('full typed exactly is applied', async () => {
    const t = setup([{ choose: 'full' }, { ask: 'full' }], files(), SHEBANG);
    await accessStep.run(t.ctx);
    expect(JSON.parse(readFileSync(path.join(t.root, '.claude', 'settings.local.managed.json'), 'utf8')).set).toBe('full');
  });

  it('keeps unrelated hooks and permission entries', async () => {
    const existing = {
      permissions: { allow: ['Bash(echo hi)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'block-outside-project.sh' }] }] },
    };
    const t = setup([{ choose: 'read_only' }], files({ '.claude/settings.local.json': JSON.stringify(existing) }), SHEBANG);
    await accessStep.run(t.ctx);
    const s = readSettings(t.root);
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('block-outside-project.sh');
    expect(s.permissions.allow).toContain('Bash(echo hi)');
    expect(s.hooks.Stop).toBeDefined();
  });

  it('invalid settings JSON aborts with the writer message and no write', async () => {
    const bad = '{ not json';
    const t = setup([{ choose: 'read_only' }], files({ '.claude/settings.local.json': bad }), SHEBANG);
    await expect(accessStep.run(t.ctx)).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(path.join(t.root, '.claude', 'settings.local.json'), 'utf8')).toBe(bad);
    expect(existsSync(path.join(t.root, '.claude', 'settings.local.managed.json'))).toBe(false);
  });

  it('unresolvable ccgram skips hooks, still applies the set', async () => {
    const t = setup([{ choose: 'read_only' }], files(), null);
    expect(await accessStep.run(t.ctx)).toBe('skipped');
    const s = readSettings(t.root);
    expect(s.hooks).toBeUndefined();
    expect(t.sio.transcript.some((l) => l.includes('install the pinned ccgram first'))).toBe(true);
  });

  it('appends missing .gitignore rules after confirm, never rewriting existing lines', async () => {
    const t = setup(
      [{ choose: 'read_only' }, { confirm: true }, { confirm: true }],
      files({ '.gitignore': 'node_modules\n.env' }),
      SHEBANG,
    );
    await accessStep.run(t.ctx);
    const gi = readFileSync(path.join(t.root, '.gitignore'), 'utf8');
    expect(gi.startsWith('node_modules\n.env\n')).toBe(true);
    expect(gi).toContain('.ccgram/\n.claude/settings.local.json\n.claude/settings.local.managed.json\n');
    expect(gi).toContain('user-data/\nsecrets/\n');
    expect(gi.match(/^\.env$/gm)).toHaveLength(1);
  });

  it('declining the append leaves .gitignore untouched', async () => {
    const t = setup([{ choose: 'read_only' }, { confirm: false }, { confirm: false }], files({ '.gitignore': 'x\n' }), SHEBANG);
    await accessStep.run(t.ctx);
    expect(readFileSync(path.join(t.root, '.gitignore'), 'utf8')).toBe('x\n');
  });
});

describe('gitignore matches the doctor rule exactly', () => {
  for (const variant of ['.ccgram', '/.ccgram/', '/.env', '.claude/settings.local.json/']) {
    it(`variant ${variant} gets the exact line appended and the real check passes`, async () => {
      const t = setup(
        [{ choose: 'read_only' }, { confirm: true }, { confirm: true }],
        files({ '.gitignore': variant + '\n' }),
        SHEBANG,
      );
      await accessStep.run(t.ctx);
      const [gi] = await runChecks(checksById(['gitignore']), t.doctor);
      expect(gi.result.status).toBe('pass');
      const lines = readFileSync(path.join(t.root, '.gitignore'), 'utf8').split('\n');
      for (const rule of ['.ccgram/', '.claude/settings.local.json', '.claude/settings.local.managed.json', '.env']) {
        expect(lines).toContain(rule);
      }
      expect(lines[0]).toBe(variant); // existing line untouched
    });
  }

  it('a rejected which is treated as not found with the exact fix', async () => {
    const t = setup([{ choose: 'read_only' }], files(), SHEBANG);
    t.ctx.run = (async () => {
      throw new Error('ENOENT');
    }) as unknown as SetupContext['run'];
    expect(await accessStep.run(t.ctx)).toBe('skipped');
    expect(t.sio.transcript.some((l) => l.includes('install the pinned ccgram first'))).toBe(true);
  });
});

describe('limitsStep pre-existing pair conflict', () => {
  it('safe mode re-prompts the pair instead of throwing; Enter on the low default is refused', async () => {
    const t = setup(
      [
        { choose: 'safe' },
        { ask: '' }, // MIN keeps 9 (unchanged, no raise confirm)
        { ask: '' }, // MAX default 4 is below 9: refused, re-asked
        { ask: '12' }, // MAX 12 is above the default 4: raise confirm next
        { confirm: true },
      ],
      { '.env': 'PACING_MIN_BURST=9\n' },
    );
    await limitsStep.run(t.ctx);
    const env = envOf(t.root);
    expect(env.get('PACING_MIN_BURST')).toBe('9');
    expect(env.get('PACING_MAX_BURST')).toBe('12');
    t.sio.assertDone();
  });
});
