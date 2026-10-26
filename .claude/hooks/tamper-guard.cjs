#!/usr/bin/env node
/**
 * Tamper-protection denylist for the scheduled wake session (profile outreach_wake, which runs with the full
 * built-in tool set). Everything not named here is allowed; this is NOT a sandbox. It exists so that an unattended
 * session that reads untrusted page text cannot (a) read or write secrets, (b) switch off its own safety
 * (kill switch, hooks, settings, permission sets, run profiles, MCP config, agent tool lists, caps, dry-run flag),
 * (c) run the owner control commands, (d) push or rewrite git history, (e) reach non-local hosts with a raw client.
 * Pure, dependency free, fails closed on every error. Called from tool-allowlist.cjs after the kill switch.
 * Known bypasses (inline interpreters, a script written with Write and then run, obfuscated paths) are listed in
 * docs/reference/safety-layers.md; do not read this file as a guarantee.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const GUARDED = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit', 'WebFetch', 'WebSearch']);
// Top-level directories that are never read or written (lower case, compared case-insensitively: APFS is).
const SECRET_DIRS = ['secrets', 'user-data', '.ccgram', 'models'];
// Never written, deleted or moved (a descendant of one of these is protected too). Lower case, relative to the project.
const PROTECTED = [
  '.jobber/stop',
  '.claude/hooks',
  '.claude/agents', // the `tools:` line of an agent file is what narrows an operator subagent
  '.mcp.json',
  'config/permission-sets.json',
  'config/run-profiles.json',
  'config/runner',
  'config/worker-tools.json',
  '.git',
  'src/platform/runner.ts',
  'scripts/run-claude.ts',
  'scripts/run-claude.sh',
  'src/safety',
  'src/outreach/limits.ts',
  'src/setup/limitscatalog.ts',
];
const PROTECTED_LITERALS = [
  '.jobber/stop', '.claude/hooks', '.claude/settings', '.claude/agents', 'permission-sets.json', 'run-profiles.json',
  '.mcp.json', 'config/runner', 'worker-tools.json', 'data.sqlite',
];
const HOME = os.homedir();
const TMP_ROOTS = ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', os.tmpdir()].map((p) => p.toLowerCase());
const CAP_RE = /\b(JOBBER_DRY_RUN|SEND_LIMIT_PER_RUN|[A-Z0-9_]*MAX_[A-Z0-9_]+)\b/;
const CAP_ASSIGN_RE = /\b(JOBBER_DRY_RUN|SEND_LIMIT_PER_RUN|[A-Z0-9_]*MAX_[A-Z0-9_]+)["']?\s*[:=]/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

const READONLY_VERBS = new Set([
  'cat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ls', 'wc', 'stat', 'file', 'diff', 'cmp', 'find',
  'git', 'echo', 'printf', 'pwd', 'date', 'true', 'false', 'test', '[', 'cut', 'tr', 'nl', 'basename', 'dirname', 'realpath',
  'readlink', 'which', 'type', 'whoami', 'id', 'uname', 'hostname', 'ps', 'df', 'du', 'jq', 'sqlite3',
]);
const READONLY_GIT = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'ls-files', 'rev-parse', 'describe', 'shortlog', 'cat-file', 'grep', 'reflog',
  'rev-list', 'name-rev', 'ls-tree', 'show-ref', 'branch', 'remote', 'worktree', 'stash', 'tag',
]);
const DESTRUCTIVE = new Set([
  'rm', 'rmdir', 'unlink', 'mv', 'chmod', 'chown', 'chgrp', 'truncate', 'shred', 'ln', 'install', 'rsync', 'cp', 'dd', 'tee', 'touch', 'sed', 'perl',
]);
const WRAPPERS = new Set(['env', 'sudo', 'nohup', 'time', 'command', 'exec', 'nice', 'timeout', 'xargs', 'watch', 'stdbuf', 'builtin', 'ionice']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const NET_CLIENTS = new Set(['curl', 'wget', 'nc', 'ncat', 'netcat', 'ssh', 'scp', 'sftp', 'telnet', 'ftp', 'socat']);
const TMUX_OK = new Set(['list-sessions', 'ls', 'list-windows', 'lsw', 'capture-pane', 'display-message', 'has-session', 'show-options', 'list-panes']);

const lc = (s) => String(s).toLowerCase();
const deny = (reason) => ({ allow: false, reason });
const ok = { allow: true, reason: '' };

function realRootOf(root) {
  try { return fs.realpathSync(root); } catch { return root; }
}

/** realpath of the longest existing ancestor plus the not-yet-existing tail (a file that is about to be created). */
function realish(p) {
  let cur = p;
  const tail = [];
  for (let i = 0; i < 64; i++) {
    try {
      const r = fs.realpathSync(cur);
      return tail.length ? path.join(r, ...tail.reverse()) : r;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return p;
}

/** Project-relative, lower case, forward-slash path of p, or null when it is outside the project. */
function relToRoot(p, root) {
  if (typeof p !== 'string' || p === '' || p.includes('\0')) return undefined;
  const expanded = p === '~' ? HOME : p.startsWith('~/') ? path.join(HOME, p.slice(2)) : p;
  const abs = path.resolve(root, expanded);
  const rr = realRootOf(root);
  for (const cand of [realish(abs), abs]) {
    for (const base of [rr, root]) {
      const rel = path.relative(base, cand);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return lc(rel.split(path.sep).join('/'));
    }
  }
  return null;
}

/** A reason string when a project-relative path is secret (denied for every operation), else ''. */
function secretReason(rel, loose) {
  const segs = rel.split('/').filter(Boolean);
  if (segs.length === 0) return '';
  if (SECRET_DIRS.includes(segs[0])) return `${segs[0]}/ is never read or written`;
  for (const s of segs) {
    if ((loose ? s.startsWith('.env') : /^\.env(\..+)?$/.test(s)) && s !== '.env.example') return '.env files are never read or written';
    if (s === '.ssh' || s === '.aws' || s === '.gnupg') return `${s} is never read or written`;
  }
  return '';
}

function protectedHit(rel, mode) {
  // mode 'down': rel is a protected path or inside one. mode 'up': rel is also an ancestor of one (rm -rf .claude).
  if (rel === undefined || rel === null) return '';
  const base = rel.split('/').pop() || '';
  if (/^\.claude\/settings[^/]*$/.test(rel) || /^\.claude\/settings/.test(rel)) return 'settings';
  if (base.startsWith('data.sqlite')) return 'data.sqlite';
  for (const p of PROTECTED) {
    if (rel === p || rel.startsWith(p + '/')) return p;
    if (mode === 'up' && (rel === '' || p.startsWith(rel + '/'))) return p;
  }
  if (mode === 'up' && rel === '.claude') return '.claude/settings';
  return '';
}

function collectStrings(v, out = [], depth = 0) {
  if (depth > 8 || out.length > 2000) throw new Error('too deep or large');
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out, depth + 1);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) collectStrings(x, out, depth + 1);
  return out;
}

function globToRe(seg) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const j = seg.indexOf(']', i + 1);
      if (j < 0) re += '\\[';
      else { re += '[' + seg.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j; }
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}
/** Would the shell glob (one path, relative to the project) match name (a full relative path)? Leading dots must be literal. */
function globMatches(glob, name) {
  const gs = glob.split('/').filter((s) => s !== '' && s !== '.');
  const ns = name.split('/');
  if (gs.length === 0) return false;
  // prefix match: a glob that stops early can expand to a directory that holds the name, or to the name itself
  const n = Math.min(gs.length, ns.length);
  for (let i = 0; i < n; i++) {
    if (ns[i].startsWith('.') && !gs[i].startsWith('.')) return false;
    if (!globToRe(gs[i]).test(ns[i])) return false;
  }
  return true;
}

// ---------- file tools ----------

function checkFileTool(name, input, root) {
  const writing = name === 'Edit' || name === 'Write' || name === 'NotebookEdit' || name === 'MultiEdit';
  const raw = input.file_path || input.notebook_path || input.path || (name === 'Grep' || name === 'Glob' ? '.' : '');
  if (typeof raw !== 'string' || raw === '') return deny(`${name}: no path`);
  const rel = relToRoot(raw, root);
  if (rel === undefined) return deny(`${name}: bad path`);
  if (rel === null) return deny(`${name}: path is outside the project directory`);
  const sr = secretReason(rel);
  if (sr) return deny(`${name}: ${sr}`);
  // pattern/glob arguments may name a secret location; they cannot widen the search past the base path.
  for (const extra of [input.glob, name === 'Glob' ? input.pattern : undefined]) {
    if (typeof extra === 'string') {
      if (/(^|\/)\.\.(\/|$)/.test(extra) || /^[/~]/.test(extra)) return deny(`${name}: pattern escapes the base path`);
      const r2 = secretReason(lc(path.posix.normalize(rel === '' ? extra : rel + '/' + extra)).replace(/^\.\//, ''), true);
      if (r2) return deny(`${name}: ${r2}`);
    }
  }
  if (!writing) return ok;
  const hit = protectedHit(rel, 'down');
  if (hit) return deny(`${name}: ${hit} is protected (tamper protection)`);
  let strs;
  try { strs = collectStrings([input.content, input.new_string, input.old_string, input.new_source, input.edits]); } catch { return deny(`${name}: input too large to screen`); }
  if (!/^(tests|docs)\//.test(rel) && strs.some((s) => CAP_ASSIGN_RE.test(s))) {
    return deny(`${name}: setting or editing JOBBER_DRY_RUN or a *_MAX_* cap is not allowed`);
  }
  return ok;
}

// ---------- web tools ----------

function privateHost(h) {
  const host = lc(h).replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.lan') || host.endsWith('.home.arpa')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (host.includes(':')) return true; // any IPv6 literal (loopback, ULA, link-local, mapped): refused outright
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host.split('.').pop() || '')) return true; // numeric tail the URL parser did not normalise
  return false;
}

function checkWeb(name, input) {
  if (name === 'WebSearch') return ok;
  const u = input.url;
  if (typeof u !== 'string' || u === '' || u.length > 4000) return deny('WebFetch: bad url');
  let url;
  try { url = new URL(u); } catch { return deny('WebFetch: unparseable url'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return deny(`WebFetch: ${url.protocol} urls are not allowed`);
  if (url.username || url.password) return deny('WebFetch: credentials in url');
  if (privateHost(url.hostname)) return deny('WebFetch: local or private host');
  let decoded = u;
  try { decoded = decodeURIComponent(u); } catch { /* keep raw */ }
  if (/(^|[/=?&])\.env(\.|$|[/&])|\bsecrets\/|\buser-data\/|data\.sqlite/i.test(decoded)) return deny('WebFetch: url carries a secret-shaped path');
  return ok;
}

// ---------- Bash ----------

function parseShell(cmd) {
  // Returns { cmds: string[][] (words), redirects: string[], bad: string } ; bad is a reason when unparseable or unsafe.
  const cmds = [];
  const redirects = [];
  let words = [];
  let cur = '';
  let inWord = false;
  let quotedAny = false;
  let globby = false;
  let q = '';
  const push = () => {
    if (inWord) words.push(cur);
    cur = ''; inWord = false; quotedAny = false; globby = false;
  };
  const endCmd = () => { push(); if (words.length) cmds.push(words); words = []; };
  let pendingRedirect = false;
  const n = cmd.length;
  for (let i = 0; i < n; i++) {
    const c = cmd[i];
    if (q === "'") { if (c === "'") q = ''; else { cur += c; } continue; }
    if (q === '"') {
      if (c === '"') q = '';
      else if (c === '\\' && i + 1 < n && '"\\$`'.includes(cmd[i + 1])) { cur += cmd[++i]; }
      else if (c === '$' || c === '`') return { bad: 'variable or command substitution is not allowed' };
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { q = c; inWord = true; quotedAny = true; continue; }
    if (c === '\\') { if (i + 1 >= n) return { bad: 'trailing backslash' }; cur += cmd[++i]; inWord = true; continue; }
    if (c === '$' || c === '`') return { bad: 'variable or command substitution is not allowed' };
    if (c === '\n' || c === '\r' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')') {
      if (c === '&' && cmd[i + 1] === '>') { i += (cmd[i + 2] === '>' ? 2 : 1); push(); pendingRedirect = true; continue; }
      if (c === '&' && i > 0 && (cmd[i - 1] === '>' || cmd[i - 1] === '<')) { inWord = true; cur += '&'; continue; }
      endCmd();
      continue;
    }
    if (c === '<') {
      if (cmd[i + 1] === '<') return { bad: 'heredoc and here-string are not allowed' };
      push(); pendingRedirect = true; continue;
    }
    if (c === '>') {
      // a digit word glued to > ("2>") is a file descriptor, not an argument
      if (/^[0-9]$/.test(cur) && !quotedAny) { cur = ''; inWord = false; }
      if (cmd[i + 1] === '&') { i++; push(); // fd dup like 2>&1: the digit that follows is not a path
        while (/[0-9-]/.test(cmd[i + 1] || '')) i++; continue; }
      if (cmd[i + 1] === '>' || cmd[i + 1] === '|') i++;
      push(); pendingRedirect = true; continue;
    }
    if (c === ' ' || c === '\t') {
      const before = words.length;
      push();
      if (pendingRedirect && words.length > before) { redirects.push(words.pop()); pendingRedirect = false; }
      continue;
    }
    if (c === '*' || c === '?' || c === '[') globby = true;
    if (c === '{' ) globby = true;
    cur += c; inWord = true;
  }
  if (q) return { bad: 'unterminated quote' };
  const before = words.length;
  push();
  if (pendingRedirect && words.length > before) { redirects.push(words.pop()); pendingRedirect = false; }
  if (pendingRedirect) return { bad: 'redirect without target' };
  if (words.length) cmds.push(words);
  return { cmds, redirects };
}

function isFlag(w) { return w.startsWith('-') && w.length > 1; }
function hostOf(w) {
  let s = lc(w).replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  s = s.replace(/^[^@/]*@/, '');
  if (s.startsWith('[')) return s.slice(0, s.indexOf(']') + 1);
  return s.split(/[/:?#]/)[0];
}

function gitDeny(words) {
  const rest = words.slice(1);
  let i = 0;
  while (i < rest.length && isFlag(rest[i])) {
    if (rest[i] === '-c' || rest[i].startsWith('-c') || rest[i] === '--exec-path' || rest[i].startsWith('--config')) return 'git -c / config override';
    if (rest[i] === '-C' || rest[i] === '--git-dir' || rest[i] === '--work-tree') i++;
    i++;
  }
  const sub = rest[i];
  const args = rest.slice(i + 1);
  if (sub === undefined) return '';
  if (sub === 'push') return 'git push';
  if (sub === 'config') return 'git config';
  if (sub === 'reset' && args.some((a) => a === '--hard' || a === '--keep' || a === '--merge')) return 'git reset --hard';
  if (sub === 'checkout' && args.includes('--')) return 'git checkout --';
  if (sub === 'checkout' && args.some((a) => a === '.' || a === '-f' || a === '--force')) return 'git checkout .';
  if (sub === 'restore' || sub === 'clean' || sub === 'filter-branch' || sub === 'update-ref') return `git ${sub}`;
  if (sub === 'remote' && args.some((a) => ['add', 'set-url', 'remove', 'rm', 'rename'].includes(a))) return 'git remote edit';
  if (sub === 'rebase' || sub === 'merge') return ''; // local history changes are not blocked; push and config are
  return '';
}

function isReadonlyCmd(words) {
  const verb = path.basename(words[0] || '');
  if (!READONLY_VERBS.has(verb)) return false;
  if (verb === 'find' && words.some((w) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(w))) return false;
  if (verb === 'sqlite3') return words.includes('-readonly');
  if (verb === 'git') {
    const rest = words.slice(1).filter((w) => !isFlag(w));
    const sub = rest[0];
    if (!READONLY_GIT.has(sub)) return false;
    if (sub === 'branch' && words.some((w) => /^(-d|-D|-m|-M|-c|-C|--delete|--move|--copy|--force|-f|-u|--set-upstream-to)$/.test(w))) return false;
    if (sub === 'branch' && rest.length > 1 && !words.some((w) => /^(--list|-l|--contains|--merged|--no-merged)$/.test(w))) return false;
    if (sub === 'remote' && rest.slice(1).some((a) => !['-v', 'show', 'get-url'].includes(a) && !isFlag(a))) return false;
    if (sub === 'worktree' && rest[1] !== 'list') return false;
    if (sub === 'stash' && rest[1] !== 'list' && rest[1] !== 'show') return false;
    if (sub === 'tag' && rest.length > 1 && !words.some((w) => /^(-l|--list)$/.test(w))) return false;
    if (words.some((w) => /^--output/.test(w) || w === '-o')) return false;
  }
  return true;
}

function relFor(w, root) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(w)) return undefined; // a url, not a path
  const r = relToRoot(w, root);
  return r;
}

function analyzeWords(words0, ctx) {
  let words = words0.slice();
  // leading VAR=value assignments
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    if (CAP_RE.test(words[0])) return deny('setting JOBBER_DRY_RUN or a *_MAX_* cap is not allowed');
    ctx.sawAssign = true;
    words = words.slice(1);
  }
  if (words.length === 0) return ok;
  const verb = path.basename(words[0]);
  if (verb === 'eval') return deny('eval is not allowed');
  if (verb === 'export' || verb === 'declare' || verb === 'typeset' || verb === 'set' || verb === 'setenv') {
    if (words.some((w) => CAP_RE.test(w))) return deny('setting JOBBER_DRY_RUN or a *_MAX_* cap is not allowed');
  }
  if (WRAPPERS.has(verb)) {
    let i = 1;
    while (i < words.length && (isFlag(words[i]) || (verb === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) || (verb === 'timeout' && /^[0-9.]+[smhd]?$/.test(words[i])) || (verb === 'nice' && /^-?[0-9]+$/.test(words[i])))) {
      if (verb === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) && CAP_RE.test(words[i])) return deny('setting JOBBER_DRY_RUN or a *_MAX_* cap is not allowed');
      i++;
    }
    if (i >= words.length) return ok;
    ctx.depth++;
    const rw = analyzeWords(words.slice(i), ctx);
    ctx.depth--;
    return rw;
  }
  if (SHELLS.has(verb)) {
    const ci = words.findIndex((w, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w));
    if (ci > 0) {
      if (ctx.depth >= 3) return deny('shell nesting too deep');
      if (typeof words[ci + 1] !== 'string') return deny('shell -c without a command');
      ctx.depth++;
      const rs = analyzeString(words[ci + 1], ctx);
      ctx.depth--;
      return rs.allow ? rs : deny(rs.reason.replace(/^Bash: /, ''));
    }
  }
  if (verb === 'find') {
    for (let i = 0; i < words.length; i++) {
      if (/^-(exec|execdir|ok|okdir)$/.test(words[i])) {
        let j = i + 1; const payload = [];
        while (j < words.length && words[j] !== ';' && words[j] !== '+') payload.push(words[j++]);
        ctx.depth++;
        const r = analyzeWords(payload.filter((w) => w !== '{}'), ctx);
        ctx.depth--;
        if (!r.allow) return r;
        if (DESTRUCTIVE.has(path.basename(payload[0] || ''))) {
          for (const sp of words.slice(1)) {
            if (isFlag(sp) || sp === '(' || sp === '!') break;
            const rel = relFor(sp, ctx.root);
            const hit = typeof rel === 'string' ? protectedHit(rel, 'up') : '';
            if (hit) return deny(`${hit} is protected (tamper protection)`);
          }
        }
      }
    }
  }
  const readonly = isReadonlyCmd(words);
  ctx.allReadonly = ctx.allReadonly && readonly;

  if (verb === 'git') { const g = gitDeny(words); if (g) return deny(`${g} is not allowed`); }

  const joined = words.join(' ');
  // owner control commands
  if (/\b(npm|pnpm|yarn|bun|npx)\b/.test(verb) || verb === 'tsx' || verb === 'node') {
    if (/(^|[\s/])(jobber:control|linkedin:clear-halt)(\s|$)/.test(joined)) return deny('owner control command is not allowed');
    if (/\b(npm|pnpm|yarn|bun)\s+(?:-{1,2}\S+\s+)*(?:run(?:-script)?|rum|urn)\s+(?:-{1,2}\S+\s+)*(permissions|restore|backup|auto-update|layout\b.*clear-halt)/.test(joined)) return deny('owner control command is not allowed');
    if (/\blayout(\.ts)?\b.*\bclear-halt\b/.test(joined)) return deny('layout clear-halt is not allowed');
  }
  if (!readonly && words.some((w) => /(^|\/)scripts\/(jobber-control|permissions|linkedin-clear-halt|restore|backup|auto-update)(\.ts|\.js|\.cjs|\.mjs)?$/.test(w))) return deny('owner control script is not allowed');
  if (!readonly && /scripts\/layout(\.ts)?/.test(joined) && /clear-halt/.test(joined)) return deny('layout clear-halt is not allowed');

  if (verb === 'sqlite3') {
    if (!words.includes('-readonly')) return deny('sqlite3 needs -readonly');
    if (/(^|[\s'";])\.(shell|system|import|output|once|backup|save|read|clone|excel|log|open|cd|www|load)\b|\battach\b|writefile|load_extension/i.test(joined)) return deny('sqlite3 dot-command or ATTACH not allowed');
  }
  if (verb === 'rm') {
    const recursive = words.some((w) => /^-[a-zA-Z]*[rR]/.test(w) || w === '--recursive');
    if (recursive) {
      for (const w of words.slice(1).filter((x) => !isFlag(x))) {
        const abs = lc(path.resolve(ctx.root, w.startsWith('~') ? w.replace(/^~/, HOME) : w));
        let real = abs;
        try { real = lc(realish(path.resolve(ctx.root, w.startsWith('~') ? w.replace(/^~/, HOME) : w))); } catch { /* keep */ }
        const inProject = (typeof relToRoot(w, ctx.root) === 'string');
        if (inProject || !TMP_ROOTS.some((t) => (abs === t || abs.startsWith(t + '/')) && (real === t || real.startsWith(t + '/') || real.startsWith('/private' + t + '/')))) return deny('rm -r is only allowed inside a temp directory');
      }
    }
  }
  if (NET_CLIENTS.has(verb)) {
    const targets = words.slice(1).filter((w) => !isFlag(w) && !/^\d+$/.test(w));
    for (const t of targets) {
      if (!LOCAL_HOSTS.has(hostOf(t))) return deny(`${verb} is only allowed to localhost`);
    }
  }
  if (verb === 'tmux') {
    const sub = words.slice(1).find((w) => !isFlag(w));
    if (!TMUX_OK.has(sub)) return deny('tmux is only allowed for list and capture commands');
  }
  if ((verb === 'launchctl' || verb === 'crontab' || verb === 'systemctl') ) return deny(`${verb} is not allowed`);

  if (!readonly) {
    if (CAP_RE.test(joined)) return deny('setting or editing JOBBER_DRY_RUN or a *_MAX_* cap is not allowed');
    const low = lc(joined);
    for (const lit of PROTECTED_LITERALS) if (low.includes(lit)) return deny(`${lit} is protected (tamper protection)`);
    const destructive = DESTRUCTIVE.has(verb) || (verb === 'find' && words.some((w) => w === '-delete'));
    for (const w of words.slice(1)) {
      if (isFlag(w)) continue;
      const rel = relFor(w, ctx.root);
      if (typeof rel === 'string') {
        const hit = protectedHit(rel, destructive ? 'up' : 'down');
        if (hit && !(verb === 'git' || /^(npm|npx|pnpm|yarn|node|tsx|tsc|vitest)$/.test(verb))) return deny(`${hit} is protected (tamper protection)`);
        if (hit && destructive) return deny(`${hit} is protected (tamper protection)`);
      }
    }
  }
  return ok;
}

function sensitiveAtoms(cmd, root) {
  const atoms = cmd.split(/[\s=:,;|&<>()'"`[\]{}]+/).filter(Boolean);
  for (let a of atoms) {
    a = a.replace(/^(\.\/)+/, '');
    if (a === '' || a === '.' || a === '..') continue;
    if (/^\.env(\..+)?$/.test(lc(a)) && lc(a) !== '.env.example') return '.env files are never read or written';
    if (a.startsWith('~') || a.includes('/') || a.includes('..')) {
      const rel = relToRoot(a, root);
      if (typeof rel === 'string') { const r = secretReason(rel); if (r) return r; }
      if (/(^|\/)\.(ssh|aws|gnupg)(\/|$)/.test(lc(a))) return `${a} is never read or written`;
    } else if (SECRET_DIRS.includes(lc(a)) && fs.existsSync(path.join(root, a))) {
      return `${lc(a)}/ is never read or written`;
    }
  }
  return '';
}

function globReason(words, root, writing) {
  for (const w of words) {
    if (!/[*?[]/.test(w)) continue;
    const rel = w.replace(/^(\.\/)+/, '');
    if (rel.startsWith('/') || rel.startsWith('~')) continue;
    for (const name of SECRET_DIRS) {
      if (globMatches(rel, name)) return `glob ${w} can expand to ${name}`;
    }
    for (const seg of rel.split('/')) {
      if (/[*?[]/.test(seg)) for (const name of ['.env', '.env.local', '.env.production', '.env.development']) if (globMatches(seg, name)) return `glob ${w} can expand to ${name}`;
    }
    if (writing) for (const p of PROTECTED) if (globMatches(rel, p)) return `glob ${w} can expand to protected ${p}`;
  }
  return '';
}

function analyzeString(cmd, ctx) {
  const parsed = parseShell(cmd);
  if (parsed.bad) return deny(`Bash: ${parsed.bad}`);
  if (!parsed.cmds || (parsed.cmds.length === 0 && parsed.redirects.length === 0)) return deny('Bash: empty or unparseable command');
  const sens = sensitiveAtoms(cmd, ctx.root);
  if (sens) return deny(`Bash: ${sens}`);
  ctx.allReadonly = true;
  for (const words of parsed.cmds) {
    const r = analyzeWords(words, ctx);
    if (!r.allow) return deny(`Bash: ${r.reason}`);
  }
  const writing = !ctx.allReadonly || parsed.redirects.length > 0;
  for (const rd of parsed.redirects) {
    if (rd === '/dev/null' || rd === '/dev/stderr' || rd === '/dev/stdout') continue;
    const rel = relFor(rd, ctx.root);
    if (typeof rel === 'string') {
      const hit = protectedHit(rel, 'down');
      if (hit) return deny(`Bash: redirect into ${hit} is protected (tamper protection)`);
      const sr = secretReason(rel);
      if (sr) return deny(`Bash: ${sr}`);
    }
    if (CAP_RE.test(cmd)) return deny('Bash: setting or editing JOBBER_DRY_RUN or a *_MAX_* cap is not allowed');
  }
  if (parsed.redirects.length > 0) {
    const low = lc(cmd);
    for (const lit of PROTECTED_LITERALS) if (low.includes(lit)) return deny(`Bash: ${lit} is protected (tamper protection)`);
  }
  const allWords = parsed.cmds.flat().concat(parsed.redirects);
  const g = globReason(allWords, ctx.root, writing);
  if (g) return deny(`Bash: ${g}`);
  return ok;
}

function checkBash(input, root) {
  if (!input || typeof input.command !== 'string' || input.command.trim() === '') return deny('Bash: no command');
  if (input.dangerouslyDisableSandbox) return deny('Bash: sandbox override is not allowed');
  if (input.command.length > 20000) return deny('Bash: command too long');
  return analyzeString(input.command, { root, depth: 0, allReadonly: true });
}

/** event: a PreToolUse event. Returns { allow, reason }. Anything it cannot parse is denied. */
function decide(event, opts) {
  try {
    const root = (opts && opts.root) || path.resolve(__dirname, '..', '..');
    if (!event || typeof event.tool_name !== 'string') return deny('malformed event');
    const name = event.tool_name;
    if (!GUARDED.has(name)) return ok;
    const input = event.tool_input && typeof event.tool_input === 'object' && !Array.isArray(event.tool_input) ? event.tool_input : null;
    if (!input) return deny(`${name}: no tool input`);
    if (name === 'Bash') return checkBash(input, root);
    if (name === 'WebFetch' || name === 'WebSearch') return checkWeb(name, input);
    return checkFileTool(name, input, root);
  } catch {
    return deny('tamper guard error (fail closed)');
  }
}

module.exports = { decide, GUARDED, PROTECTED, SECRET_DIRS };
