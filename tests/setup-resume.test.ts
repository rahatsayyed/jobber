// tests/setup-resume.test.ts
import { describe, expect, it } from 'vitest';
import type { DoctorContext } from '../src/platform/doctor.js';
import { redactingIO, scriptedIO, type ScriptItem } from '../src/setup/io.js';
import {
  checkNumbersInSource,
  convertResume,
  summarizeResume,
  type ConvertDeps,
} from '../src/setup/resumeConvert.js';
import type { SetupContext, SetupFs } from '../src/setup/runner.js';
import { emptyState } from '../src/setup/state.js';
import { makeResumeStep } from '../src/setup/steps/resume.js';

const ROOT = '/home/u/proj';
const TARGET = `${ROOT}/user-data/resume.json`;
const KEYS = [
  'name', 'jobTitle', 'email', 'phone', 'website', 'social', 'summary',
  'experience', 'projects', 'education', 'skills', 'certificates',
];
const SOURCE =
  'Alex Roe, Frontend Developer. alex@roe.dev +91 98765 43210. Built dashboards at Acme 2019 to 2022, cut load time by 30%. React, TypeScript.';

function resumeJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Alex Roe',
    jobTitle: 'Frontend Developer',
    email: 'alex@roe.dev',
    phone: '+91 98765 43210',
    website: null,
    social: {},
    summary: 'Frontend developer.',
    experience: [
      { title: 'Developer', company: 'Acme', start: '2019', end: '2022', description: ['Built dashboards', 'Cut load time by 30%'] },
    ],
    projects: [],
    education: [],
    skills: [{ category: 'Web', items: ['React', 'TypeScript'] }],
    certificates: [],
    ...over,
  };
}

function setup(
  script: ScriptItem[],
  claudeOut: string,
  files: Record<string, string> = {},
  src: Record<string, string> = { '/home/u/cv.txt': SOURCE },
) {
  const store = new Map<string, string>(Object.entries(files));
  const writes: { p: string; data: string; mode: number }[] = [];
  const prompts: { prompt: string; input: string }[] = [];
  const fs: SetupFs = {
    exists: (p) => store.has(p),
    read: (p) => {
      const v = store.get(p);
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    write: (p, d, m) => {
      writes.push({ p, data: d, mode: m });
      store.set(p, d);
    },
    rename: () => undefined,
    chmod: () => undefined,
    remove: () => undefined,
    mkdirp: () => undefined,
    copy: () => undefined,
    list: () => [],
  };
  const sio = scriptedIO(script);
  const doctor: DoctorContext = {
    root: ROOT,
    env: { HOME: '/home/u' },
    run: (async () => ({ stdout: '', stderr: '', code: 0 })) as unknown as DoctorContext['run'],
    fs: { exists: (p) => store.has(p), read: (p) => store.get(p) ?? '', mode: () => 0o600 },
    now: () => new Date('2026-10-14T00:00:00Z'),
  };
  const ctx: SetupContext = {
    io: redactingIO(sio),
    root: ROOT,
    env: { HOME: '/home/u' },
    fs,
    run: doctor.run,
    spawnInteractive: async () => 0,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    now: () => new Date('2026-10-14T00:00:00Z'),
    doctor,
    state: emptyState(),
    statePath: `${ROOT}/user-data/.setup-state.json`,
    envPath: `${ROOT}/.env`,
  };
  const deps: ConvertDeps = {
    readText: async (p) => {
      const v = src[p];
      if (v === undefined) throw new Error('nope');
      return v;
    },
    runClaude: async (prompt, input) => {
      prompts.push({ prompt, input });
      return claudeOut;
    },
  };
  return { ctx, sio, store, writes, prompts, step: makeResumeStep(deps) };
}

describe('convertResume', () => {
  const deps = (out: string, text = SOURCE): ConvertDeps => ({
    readText: async () => text,
    runClaude: async () => out,
  });

  it('parses a fenced JSON result', async () => {
    const r = await convertResume('/x/cv.txt', deps('```json\n' + JSON.stringify(resumeJson()) + '\n```'), KEYS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toEqual([]);
  });

  it('warns for an invented metric', async () => {
    const out = JSON.stringify(resumeJson({ summary: 'Cut costs 40% across teams.' }));
    const r = await convertResume('/x/cv.txt', deps(out), KEYS);
    expect(r.ok && r.warnings.some((w) => w.includes('40%'))).toBe(true);
  });

  it('non-JSON output fails without echoing the output', async () => {
    const r = await convertResume('/x/cv.txt', deps('SECRET-ish model chatter'), KEYS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).not.toContain('SECRET');
  });

  it('prompt carries the untrusted-input line and resume goes via input only', async () => {
    let seen = '';
    let input = '';
    await convertResume(
      '/x/cv.txt',
      { readText: async () => SOURCE, runClaude: async (p, i) => ((seen = p), (input = i), '{}') },
      KEYS,
    );
    expect(seen).toContain('untrusted data');
    expect(seen).not.toContain('alex@roe.dev');
    expect(input).toBe(SOURCE);
  });

  it('rejects .docx with the clear message', async () => {
    const r = await convertResume('/x/cv.docx', deps('{}'), KEYS);
    expect(r).toEqual({ ok: false, problem: expect.stringContaining('export to PDF') });
  });
});

describe('checkNumbersInSource / summarizeResume', () => {
  it('flags only numbers missing from the source', () => {
    expect(checkNumbersInSource({ a: 'Grew 2019 to 2022 by 45%, 7 teams' }, 'in 2019 and 2022')).toEqual(['45%']);
  });
  it('masks the phone to the last 4 digits', () => {
    const lines = summarizeResume(resumeJson());
    expect(lines.join('\n')).toContain('***3210');
    expect(lines.join('\n')).not.toContain('98765');
  });
});

describe('resume step', () => {
  it('writes resume.json mode 600 after confirm, shows warning and masked phone', async () => {
    const out = JSON.stringify(resumeJson({ summary: 'Cut costs 40%.' }));
    const t = setup([{ ask: '/home/u/cv.txt' }, { confirm: true }], out);
    expect(await t.step.run(t.ctx)).toBe('done');
    expect(t.writes.map((w) => w.p)).toEqual([TARGET]);
    expect(t.writes[0].mode).toBe(0o600);
    const say = t.sio.transcript.join('\n');
    expect(say).toContain('40%');
    expect(say).toContain('***3210');
    expect(say).not.toContain('98765');
    expect(say).toContain('The agent never edits this file');
    t.sio.assertDone();
  });

  it('never writes the resume text anywhere but user-data/resume.json', async () => {
    const t = setup([{ ask: '/home/u/cv.txt' }, { confirm: true }], JSON.stringify(resumeJson()));
    await t.step.run(t.ctx);
    for (const w of t.writes) expect(w.p).toBe(TARGET);
  });

  it('non-JSON output: no write, offers stop', async () => {
    const t = setup([{ ask: '/home/u/cv.txt' }, { choose: 'stop' }], 'not json');
    expect(await t.step.run(t.ctx)).toBe('skipped');
    expect(t.writes).toEqual([]);
    expect(t.sio.transcript.join('\n')).not.toContain('not json');
  });

  it('declining the confirm keeps an existing resume untouched', async () => {
    const existing = JSON.stringify(resumeJson({ email: 'old@x.dev' }));
    const t = setup(
      [{ confirm: true }, { ask: '/home/u/cv.txt' }, { confirm: false }, { choose: 'stop' }],
      JSON.stringify(resumeJson()),
      { [TARGET]: existing },
    );
    expect(await t.step.run(t.ctx)).toBe('skipped');
    expect(t.writes).toEqual([]);
    expect(t.store.get(TARGET)).toBe(existing);
  });

  it('answering no to replace a valid resume leaves it alone', async () => {
    const t = setup([{ confirm: false }], '{}', { [TARGET]: JSON.stringify(resumeJson({ email: 'old@x.dev' })) });
    expect(await t.step.run(t.ctx)).toBe('done');
    expect(t.writes).toEqual([]);
  });

  it('backs up an existing resume mode 600 before replacing', async () => {
    const existing = JSON.stringify(resumeJson({ email: 'old@x.dev' }));
    const t = setup(
      [{ confirm: true }, { ask: '/home/u/cv.txt' }, { confirm: true }],
      JSON.stringify(resumeJson()),
      { [TARGET]: existing },
    );
    expect(await t.step.run(t.ctx)).toBe('done');
    expect(t.writes[0].p).toBe(`${TARGET}.bak-2026-10-14T00-00-00-000Z`);
    expect(t.writes[0].mode).toBe(0o600);
    expect(t.writes[0].data).toBe(existing);
    expect(t.writes[1].p).toBe(TARGET);
  });

  it('rejects .docx and paths outside home and project at the prompt', async () => {
    const t = setup(
      [{ ask: '/home/u/cv.docx' }, { ask: '/etc/passwd' }, { ask: '/home/u/../other/cv.txt' }, { ask: '/home/u/cv.txt' }, { confirm: true }],
      JSON.stringify(resumeJson()),
    );
    expect(await t.step.run(t.ctx)).toBe('done');
    const tr = t.sio.transcript.join('\n');
    expect(tr).toContain('export to PDF');
    expect(tr).toContain('inside your home folder');
    expect(t.prompts).toHaveLength(1);
  });
});
