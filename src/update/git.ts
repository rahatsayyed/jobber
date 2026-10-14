import type { Exec } from '../lib/exec.js';
import type { UpdateConfig } from './config.js';
import type { RangeCommit, RepoFacts, Signature } from './plan.js';

const SIGNATURES = new Set<string>(['G', 'U', 'B', 'X', 'Y', 'R', 'E', 'N']);
const SHA_RE = /^[0-9a-f]{40}$/;
const TAG_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,99}$/;
const SEP = '\x1f';

// Read-only: fetch only updates remote-tracking refs and tags, nothing touches the tree or index.
export async function gatherFacts(exec: Exec, cfg: UpdateConfig, root: string): Promise<RepoFacts> {
  const git = (args: string[], env?: NodeJS.ProcessEnv) =>
    exec('git', args, { cwd: root, env: env ?? process.env, timeoutMs: 60_000 });
  const signerArgs = cfg.signersFile ? ['-c', `gpg.ssh.allowedSignersFile=${cfg.signersFile}`] : [];
  const tagMode = cfg.tagPattern !== null;

  const status = await git(['status', '--porcelain']);
  const dirty = status.code !== 0 || status.stdout.trim() !== '';

  const headRes = await git(['rev-parse', '--verify', '--quiet', 'HEAD']);
  const head = headRes.code === 0 ? headRes.stdout.trim() : '';

  const sym = await git(['symbolic-ref', '--short', '-q', 'HEAD']);
  const currentBranch = sym.code === 0 && sym.stdout.trim() !== '' ? sym.stdout.trim() : null;

  const fetchEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  const fetchArgs = tagMode
    ? ['fetch', '--tags', '--', cfg.remote]
    : ['fetch', '--prune', '--', cfg.remote, cfg.branch];
  const fetched = await git(fetchArgs, fetchEnv);

  let upstreamLabel = `${cfg.remote}/${cfg.branch}`;
  let upstreamSha: string | null = null;
  let tagSignature: Signature | null = null;

  if (fetched.code === 0) {
    if (tagMode) {
      const list = await git(['tag', '--list', cfg.tagPattern as string, '--sort=-v:refname']);
      const tag = list.code === 0 ? (list.stdout.split('\n').map((l) => l.trim()).find(Boolean) ?? null) : null;
      if (tag !== null && TAG_NAME_RE.test(tag)) {
        upstreamLabel = tag;
        const rp = await git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`]);
        const sha = rp.stdout.trim();
        if (rp.code === 0 && SHA_RE.test(sha)) {
          upstreamSha = sha;
          const vt = await git([...signerArgs, 'verify-tag', tag]);
          tagSignature = vt.code === 0 ? 'G' : 'N';
        }
      }
    } else {
      const rp = await git(['rev-parse', '--verify', '--quiet', `${cfg.remote}/${cfg.branch}^{commit}`]);
      const sha = rp.stdout.trim();
      if (rp.code === 0 && SHA_RE.test(sha)) upstreamSha = sha;
    }
  }

  let ahead = 0;
  let behind = 0;
  let commits: RangeCommit[] = [];
  let changedPaths: string[] = [];

  if (upstreamSha !== null && head !== '') {
    const counts = await git(['rev-list', '--left-right', '--count', `HEAD...${upstreamSha}`]);
    const m = counts.code === 0 ? counts.stdout.trim().split(/\s+/) : [];
    ahead = Number.parseInt(m[0] ?? '0', 10) || 0;
    behind = Number.parseInt(m[1] ?? '0', 10) || 0;

    const log = await git([...signerArgs, 'log', '--reverse', '--format=%H%x1f%G?%x1f%s', `HEAD..${upstreamSha}`]);
    if (log.code === 0) {
      commits = log.stdout.split('\n').filter((l) => l.trim() !== '').flatMap((line) => {
        const parts = line.split(SEP);
        const sha = parts[0]?.trim() ?? '';
        if (!SHA_RE.test(sha)) return [];
        const sig = (parts[1] ?? '').trim();
        return [{
          sha,
          signature: (SIGNATURES.has(sig) ? sig : 'E') as Signature,
          subject: parts.slice(2).join(SEP),
        }];
      });
    }

    const diff = await git(['diff', '--name-only', '--no-renames', '-z', 'HEAD', upstreamSha, '--']);
    if (diff.code === 0) changedPaths = diff.stdout.split('\0').filter((p) => p !== '');
  }

  return { head, currentBranch, dirty, upstreamSha, upstreamLabel, ahead, behind, commits, changedPaths, tagSignature };
}
