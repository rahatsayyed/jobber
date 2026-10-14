import { describe, it, expect } from 'vitest';
import { gatherFacts } from '../src/update/git.js';
import { loadUpdateConfig } from '../src/update/config.js';
import type { Exec } from '../src/lib/exec.js';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const SEP = '\x1f';
const ROOT = '/repo';

type Reply = { stdout?: string; code?: number };
function fake(replies: Record<string, Reply>) {
  const calls: { cmd: string; args: string[]; env?: NodeJS.ProcessEnv; cwd?: string }[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env, cwd: opts?.cwd });
    const key = args.join(' ');
    const hit = Object.entries(replies).find(([k]) => key.includes(k));
    const r = hit ? hit[1] : { stdout: '', code: 0 };
    return { stdout: r.stdout ?? '', stderr: '', code: r.code ?? 0 };
  };
  return { exec, calls };
}

const cfg = loadUpdateConfig({ AUTO_UPDATE: 'true', AUTO_UPDATE_SIGNERS_FILE: '/x/allowed_signers' });
const base: Record<string, Reply> = {
  'status --porcelain': { stdout: '' },
  'symbolic-ref': { stdout: 'main\n' },
  'rev-parse --verify --quiet HEAD': { stdout: A + '\n' },
  'origin/main^{commit}': { stdout: B + '\n' },
  'rev-list': { stdout: '0\t1\n' },
  'log': { stdout: `${B}${SEP}G${SEP}feat: y\n` },
  'diff': { stdout: 'src/a.ts\0src/b.ts\0' },
};

describe('gatherFacts (branch mode)', () => {
  it('runs the expected read-only command sequence', async () => {
    const { exec, calls } = fake(base);
    const f = await gatherFacts(exec, cfg, ROOT);
    expect(f).toMatchObject({ head: A, currentBranch: 'main', dirty: false, upstreamSha: B,
      upstreamLabel: 'origin/main', ahead: 0, behind: 1, changedPaths: ['src/a.ts', 'src/b.ts'], tagSignature: null });
    expect(f.commits).toEqual([{ sha: B, subject: 'feat: y', signature: 'G' }]);
    const verbs = calls.map((c) => c.args.filter((a) => !a.startsWith('-') && !a.includes('=')).slice(0, 1)[0]);
    expect(verbs).toEqual(['status', 'rev-parse', 'symbolic-ref', 'fetch', 'rev-parse', 'rev-list', 'log', 'diff']);
    const fetch = calls.find((c) => c.args[0] === 'fetch')!;
    expect(fetch.args).toEqual(['fetch', '--prune', '--', 'origin', 'main']);
    expect(fetch.env?.GIT_TERMINAL_PROMPT).toBe('0');
    expect(calls.every((c) => c.cmd === 'git' && c.cwd === ROOT)).toBe(true);
    const rl = calls.find((c) => c.args[0] === 'rev-list')!;
    expect(rl.args).toEqual(['rev-list', '--left-right', '--count', `HEAD...${B}`]);
    const log = calls.find((c) => c.args.includes('log'))!;
    expect(log.args.slice(0, 2)).toEqual(['-c', 'gpg.ssh.allowedSignersFile=/x/allowed_signers']);
    expect(log.args).toContain('--format=%H%x1f%G?%x1f%s');
  });

  it('parses ahead and behind from the left-right count', async () => {
    const { exec } = fake({ ...base, 'rev-list': { stdout: '3\t1\n' } });
    const f = await gatherFacts(exec, cfg, ROOT);
    expect(f).toMatchObject({ ahead: 3, behind: 1 });
  });

  it('a failed fetch yields upstreamSha null, not a throw', async () => {
    const { exec } = fake({ ...base, fetch: { code: 1 } });
    const f = await gatherFacts(exec, cfg, ROOT);
    expect(f.upstreamSha).toBeNull();
    expect(f.commits).toEqual([]);
  });

  it('detached head and dirty tree are reported', async () => {
    const { exec } = fake({ ...base, 'symbolic-ref': { code: 1 }, 'status --porcelain': { stdout: ' M src/a.ts\n' } });
    const f = await gatherFacts(exec, cfg, ROOT);
    expect(f.currentBranch).toBeNull();
    expect(f.dirty).toBe(true);
  });

  it('hostile subjects are carried verbatim as data and never become arguments', async () => {
    const hostile = '$(rm -rf /); `id`';
    const { exec, calls } = fake({ ...base, log: { stdout: `${B}${SEP}N${SEP}${hostile}\n` } });
    const f = await gatherFacts(exec, cfg, ROOT);
    expect(f.commits[0]).toEqual({ sha: B, subject: hostile, signature: 'N' });
    expect(calls.some((c) => c.args.some((a) => a.includes('rm -rf')))).toBe(false);
  });

  it('an unknown signature letter becomes E', async () => {
    const { exec } = fake({ ...base, log: { stdout: `${B}${SEP}Z${SEP}s\n` } });
    const f = await gatherFacts(exec, cfg, ROOT);
    expect(f.commits[0].signature).toBe('E');
  });

  it('omits -c when no signers file is configured', async () => {
    const loose = loadUpdateConfig({ AUTO_UPDATE: 'true', AUTO_UPDATE_REQUIRE_SIGNED: 'false' });
    const { exec, calls } = fake(base);
    await gatherFacts(exec, loose, ROOT);
    expect(calls.some((c) => c.args.includes('-c'))).toBe(false);
  });

  it('never runs a mutating git verb', async () => {
    const { exec, calls } = fake(base);
    await gatherFacts(exec, cfg, ROOT);
    const bad = ['merge', 'pull', 'reset', 'checkout', 'rebase', 'push'];
    for (const c of calls) for (const a of c.args) expect(bad).not.toContain(a);
  });
});

describe('gatherFacts fail-closed', () => {
  it('throws when rev-list, log or diff fail', async () => {
    await expect(gatherFacts(fake({ ...base, 'rev-list': { code: 1 } }).exec, cfg, ROOT)).rejects.toThrow(/rev-list/);
    await expect(gatherFacts(fake({ ...base, log: { code: 1 } }).exec, cfg, ROOT)).rejects.toThrow(/log/);
    await expect(gatherFacts(fake({ ...base, diff: { code: 1 } }).exec, cfg, ROOT)).rejects.toThrow(/diff/);
  });
  it('throws on a malformed log line and on a count mismatch', async () => {
    await expect(gatherFacts(fake({ ...base, log: { stdout: `zzz${SEP}G${SEP}s\n` } }).exec, cfg, ROOT)).rejects.toThrow(/malformed/);
    await expect(gatherFacts(fake({ ...base, 'rev-list': { stdout: '0\t3\n' } }).exec, cfg, ROOT)).rejects.toThrow(/not fully verified/);
  });
  it('strips control and bidi characters and caps subjects at 200', async () => {
    const subj = 'a‮b\u0007c' + 'x'.repeat(300);
    const f = await gatherFacts(fake({ ...base, log: { stdout: `${B}${SEP}G${SEP}${subj}\n` } }).exec, cfg, ROOT);
    expect(f.commits[0].subject).toHaveLength(200);
    expect(f.commits[0].subject.startsWith('abcx')).toBe(true);
  });
  it('scrubs inherited git location variables but keeps others', async () => {
    const keys = ['GIT_DIR', 'GIT_CONFIG_COUNT', 'GIT_SSH_COMMAND'];
    const saved = keys.map((k) => process.env[k]);
    process.env.GIT_DIR = '/evil'; process.env.GIT_CONFIG_COUNT = '1'; process.env.GIT_SSH_COMMAND = 'ssh -i k';
    try {
      const { exec, calls } = fake(base);
      await gatherFacts(exec, cfg, ROOT);
      for (const c of calls) {
        expect(c.env?.GIT_DIR).toBeUndefined();
        expect(c.env?.GIT_CONFIG_COUNT).toBeUndefined();
        expect(c.env?.GIT_SSH_COMMAND).toBe('ssh -i k');
      }
      expect(calls.find((c) => c.args[0] === 'fetch')!.env?.GIT_TERMINAL_PROMPT).toBe('0');
    } finally {
      keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    }
  });
});

describe('gatherFacts (tag mode)', () => {
  const tcfg = loadUpdateConfig({ AUTO_UPDATE: 'true', AUTO_UPDATE_SIGNERS_FILE: '/x/allowed_signers', AUTO_UPDATE_TAG_PATTERN: 'v*' });
  const tagReplies: Record<string, Reply> = {
    ...base,
    'tag --list': { stdout: 'v1.2.0\nv1.1.0\n' },
    'v1.2.0^{commit}': { stdout: C + '\n' },
    'verify-tag': { code: 0 },
  };

  it('picks the newest tag and verifies it with the same signers setting', async () => {
    const { exec, calls } = fake(tagReplies);
    const f = await gatherFacts(exec, tcfg, ROOT);
    expect(f).toMatchObject({ upstreamSha: C, upstreamLabel: 'v1.2.0', tagSignature: 'G' });
    const list = calls.find((c) => c.args[0] === 'tag')!;
    expect(list.args).toEqual(['tag', '--list', 'v*', '--sort=-v:refname']);
    const vt = calls.find((c) => c.args.includes('verify-tag'))!;
    expect(vt.args).toEqual(['-c', 'gpg.ssh.allowedSignersFile=/x/allowed_signers', 'verify-tag', 'v1.2.0']);
    const rp = calls.find((c) => c.args.some((a) => a === 'v1.2.0^{commit}'))!;
    expect(rp).toBeTruthy();
  });

  it('a failed verify-tag or tag rev-parse throws', async () => {
    await expect(gatherFacts(fake({ ...tagReplies, 'verify-tag': { code: 1 } }).exec, tcfg, ROOT)).rejects.toThrow(/verify-tag/);
    await expect(gatherFacts(fake({ ...tagReplies, 'v1.2.0^{commit}': { code: 1 } }).exec, tcfg, ROOT)).rejects.toThrow(/rev-parse/);
  });

  it('no matching tag means no upstream', async () => {
    const { exec } = fake({ ...tagReplies, 'tag --list': { stdout: '' } });
    const f = await gatherFacts(exec, tcfg, ROOT);
    expect(f.upstreamSha).toBeNull();
  });

  it('a tag name that looks like an option is refused', async () => {
    const { exec, calls } = fake({ ...tagReplies, 'tag --list': { stdout: '--upload-pack=evil\n' } });
    const f = await gatherFacts(exec, tcfg, ROOT);
    expect(f.upstreamSha).toBeNull();
    expect(calls.some((c) => c.args.some((a) => a.includes('upload-pack')))).toBe(false);
  });

  it('no mutating verbs in tag mode', async () => {
    const { exec, calls } = fake(tagReplies);
    await gatherFacts(exec, tcfg, ROOT);
    const bad = ['merge', 'pull', 'reset', 'checkout', 'rebase', 'push'];
    for (const c of calls) for (const a of c.args) expect(bad).not.toContain(a);
  });
});
