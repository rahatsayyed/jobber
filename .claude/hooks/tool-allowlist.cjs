#!/usr/bin/env node
/**
 * PreToolUse hook for restricted runs (plan 6B). Allowlist, not blocklist: any tool that is not
 * named for the active run profile is denied. Fails closed on every error.
 * Usage (from the run's --settings file): node tool-allowlist.cjs <profile> [policy-path]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const kill = require('./kill-switch.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const SECRET_ARG_RES = [
  /\.env/i,
  /secrets[\\/]/i,
  /user-data[\\/]/i,
  /data\.sqlite/i,
  /id_rsa/i,
  /~[\\/]/,
  /\/(etc|root|home|users|tmp|var)\//i,
];
const BAD_BASENAME = /^\.env|secret|state\.json$|\.sqlite/i;
const BAD_SEGMENT = /^(secrets|user-data|\.git|node_modules|\.dashboard|\.jobber)$/i;
const AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_DEPTH = 8;
const MAX_STRINGS = 5000;

function agentTools(agentType, root) {
  if (typeof agentType !== 'string' || !AGENT_NAME.test(agentType)) return null;
  let text;
  try {
    text = fs.readFileSync(path.join(root, '.claude', 'agents', agentType + '.md'), 'utf8');
  } catch {
    return null;
  }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return null;
  const line = fm[1].split(/\r?\n/).find((l) => /^tools\s*:/.test(l));
  if (!line) return null;
  return line
    .replace(/^tools\s*:/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Collects every string in v. Throws on nesting deeper than MAX_DEPTH or more than MAX_STRINGS strings. */
function collectStrings(v) {
  const out = [];
  const walk = (x, depth) => {
    if (depth > MAX_DEPTH) throw new Error('depth');
    if (typeof x === 'string') {
      out.push(x);
      if (out.length > MAX_STRINGS) throw new Error('count');
    } else if (Array.isArray(x)) {
      for (const y of x) walk(y, depth + 1);
    } else if (x && typeof x === 'object') {
      for (const y of Object.values(x)) walk(y, depth + 1);
    }
  };
  walk(v, 0);
  return out;
}

function validEntries(list) {
  return (
    Array.isArray(list) &&
    list.every((e) => typeof e === 'string' && TOOL_NAME.test(e) && !e.includes('*')) &&
    // an mcp__ entry must be mcp__<server>__<tool>; a bare mcp__server is a whole-server wildcard
    list.every((e) => !e.startsWith('mcp__') || /^mcp__.+?__[A-Za-z0-9_-]+$/.test(e))
  );
}

// Keep in step with BASH_EXACT_RE / BASH_EXACT_BAD_RE / BASH_EXACT_MAX in src/platform/runner.ts
// (tests/hook-tool-allowlist.test.ts runs both validators on one corpus).
const BASH_EXACT_RE =
  /^(npm run [a-z0-9:-]+( -- [a-z0-9 :._=-]+)?|npx tsx scripts\/[A-Za-z0-9_./-]+\.ts( [a-z0-9 :._=-]+)?)$/;
const BASH_EXACT_BAD_RE = /[;&|<>`$()\\'"*?~\n\r]/;
const BASH_EXACT_MAX = 40;
const NO_BASH_PROFILES = new Set(['hunt', 'outreach_wake']);

function validBashEntry(e) {
  return typeof e === 'string' && BASH_EXACT_RE.test(e) && !BASH_EXACT_BAD_RE.test(e) && !e.includes('..');
}

function validBashExact(list) {
  if (!Array.isArray(list) || list.length > BASH_EXACT_MAX) return false;
  const seen = new Set();
  for (const e of list) {
    if (!validBashEntry(e) || seen.has(e)) return false;
    seen.add(e);
  }
  return true;
}

const nonEmptyString =(v) => typeof v === 'string' && v !== '';

/**
 * True only for an absolute, normalized path <project>/renderer/automation/<id>/resume.pdf where <id> is one safe path segment
 * (letters, digits, hyphen). No traversal, no other file name, no other directory, no symlink out of the project.
 */
function isRenderedResumePdf(p, root) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) return false;
  if (path.resolve(p) !== p) return false;
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* fall back to the given root */ }
  for (const base of new Set([root, realRoot])) {
    const m = new RegExp('^' + base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/renderer/automation/([A-Za-z0-9-]{1,64})/resume\\.pdf$').exec(p);
    if (!m) continue;
    try {
      // Must exist as a regular file (no symlink, no dangling link) whose real path is exactly the expected one,
      // so a link at resume.pdf or at the id directory can never point the attachment at a secret.
      const st = fs.lstatSync(p);
      if (!st.isFile() || st.isSymbolicLink()) return false;
      if (fs.realpathSync(p) !== path.join(realRoot, 'renderer', 'automation', m[1], 'resume.pdf')) return false;
    } catch { return false; }
    return true;
  }
  return false;
}

function decide(event, profile, opts) {
  const root = (opts && opts.root) || DEFAULT_ROOT;
  const deny = (reason) => ({ allow: false, reason });
  try {
    if (!event || typeof event !== 'object' || typeof event.tool_name !== 'string') return deny('malformed event');
    const k = kill.decide(event, { root, env: (opts && opts.env) || process.env });
    if (!k.allow) return deny(k.reason);
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return deny('no profile');
    const allowList = profile.allow === undefined ? [] : profile.allow;
    const builtins = profile.builtin_tools === undefined ? [] : profile.builtin_tools;
    if (!validEntries(allowList) || !validEntries(builtins)) {
      return deny('profile contains wildcard or invalid entries');
    }
    const name = event.tool_name;
    if (name === 'Bash' && !('agent_id' in event) && !('agent_type' in event)) {
      if (opts && NO_BASH_PROFILES.has(opts.profileName)) return deny('Bash not allowed for this profile');
      if (profile.interactive !== true || !validBashExact(profile.bash_exact)) return deny('Bash not allowed for this profile');
      const input = event.tool_input;
      if (!input || typeof input !== 'object' || Array.isArray(input)) return deny('Bash command not allowed');
      if (typeof input.command !== 'string') return deny('Bash command not allowed');
      if (input.run_in_background || input.dangerouslyDisableSandbox) return deny('Bash command not allowed');
      if (!profile.bash_exact.includes(input.command.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ''))) return deny('Bash command not allowed');
      return { allow: true, reason: '' };
    }
    let allowed = new Set([...allowList, ...builtins]);
    if (name === 'Bash') allowed.delete('Bash'); // only the exact rule above can allow Bash

    const hasId = 'agent_id' in event;
    const hasType = 'agent_type' in event;
    if (hasId || hasType) {
      if ((hasId && !nonEmptyString(event.agent_id)) || (hasType && !nonEmptyString(event.agent_type))) {
        return deny('malformed agent fields');
      }
      const tools = agentTools(event.agent_type, root);
      if (!tools) return deny('subagent type has no definition file');
      allowed = new Set(tools.filter((t) => allowed.has(t)));
    }
    if (!allowed.has(name)) return deny('tool not in allowlist');

    // Gmail sender rule (plan 8G task 6): a profile with gmail_sender_allowlist may read verification
    // mail only through a search whose query is pinned to allowlisted senders (SITE_MAIL_SENDERS).
    if (name.startsWith('mcp__gmail__') && profile.gmail_sender_allowlist === true) {
      if (name === 'mcp__gmail__read_email') return { allow: true, reason: '' };
      if (name !== 'mcp__gmail__search_emails') return deny('gmail tool not allowed for this profile');
      const env = (opts && opts.env) || process.env;
      const senders = String(env.SITE_MAIL_SENDERS || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
      const q = typeof input.query === 'string' ? input.query : '';
      if (senders.length === 0 || q === '' || q.length > 500) return deny('gmail search needs an allowlisted from: query');
      if (/\bOR\b|[{}]|\bAROUND\b|(^|\s)-\s*from:/i.test(q)) return deny('gmail search query shape not allowed');
      const froms = [...q.matchAll(/(?:^|[\s(])from:\s*"?([^\s")]+)"?/gi)].map((m) => m[1].toLowerCase());
      if (froms.length === 0) return deny('gmail search needs an allowlisted from: query');
      const okFrom = (a) => senders.some((s) => (s.startsWith('@') ? a.endsWith(s) : a === s));
      if (!froms.every(okFrom)) return deny('gmail search from: is not an allowlisted sender');
      return { allow: true, reason: '' };
    }

    const rule = profile.path_rules && profile.path_rules[name];
    if (rule) {
      const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
      const fp = input.file_path || input.path;
      if (typeof fp !== 'string' || fp === '') return deny('path rule: no path');
      if (!Array.isArray(rule.prefixes) || rule.prefixes.length === 0) return deny('path rule: no prefixes');
      let realRoot = root;
      try {
        realRoot = fs.realpathSync(root);
      } catch {
        /* keep the lexical root */
      }
      let resolved = path.resolve(root, fp);
      try {
        resolved = fs.realpathSync(resolved);
      } catch {
        /* a not-yet-existing file keeps its lexical path */
      }
      const under = (b) => resolved === b || resolved.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
      const ok = rule.prefixes.some((p) => {
        if (typeof p !== 'string') return false;
        return under(path.join(root, p)) || under(path.join(realRoot, p));
      });
      if (!ok) return deny('path outside allowed prefixes');
      if (BAD_BASENAME.test(path.basename(resolved))) return deny('path rule: sensitive file name');
      let rel = path.relative(realRoot, resolved);
      if (rel.startsWith('..')) rel = path.relative(root, resolved);
      const segs = rel.split(path.sep).slice(0, -1);
      if (segs.some((s) => BAD_SEGMENT.test(s) || /^\.env/i.test(s))) return deny('path rule: sensitive directory');
    }

    if (Array.isArray(profile.screen_args) && profile.screen_args.includes(name)) {
      let strs;
      try {
        strs = collectStrings(event.tool_input);
      } catch {
        return deny('tool_input too deeply nested or too large to screen');
      }
      // gmail send_email may attach ONLY a rendered resume PDF (<project>/renderer/automation/<id>/resume.pdf). Its absolute path
      // contains /Users/, which the generic screen below rejects, so the attachments are checked here by an exact rule and then
      // left out of the generic screen; every other argument is still screened.
      let skip = null;
      if (name === 'mcp__gmail__send_email' && event.tool_input && event.tool_input.attachments !== undefined) {
        const att = event.tool_input.attachments;
        if (!Array.isArray(att) || !att.every((a) => isRenderedResumePdf(a, root))) return deny('attachment path not allowed');
        skip = new Set(att);
      }
      for (const s of strs) {
        if (skip && skip.has(s)) continue;
        if (SECRET_ARG_RES.some((re) => re.test(s))) return deny('secret-shaped path in tool arguments');
      }
    }
    return { allow: true, reason: '' };
  } catch {
    return deny('policy evaluation error (fail closed)');
  }
}

function denyJson(reason) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Blocked by run policy: ${reason}` },
  });
}

/** Writes the deny JSON and exits 0 only once the write has flushed (a pipe may be async). */
function emitDenyAndExit(reason) {
  try {
    process.stdout.write(denyJson(reason), () => process.exit(0));
  } catch {
    process.exit(0);
  }
}

function logDenial(profileName, event, reason) {
  if (process.env.HOOK_NO_LOG) return;
  try {
    const dir = path.join(DEFAULT_ROOT, 'debug');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, 'hook-denials.jsonl'),
      JSON.stringify({
        ts: new Date().toISOString(),
        profile: typeof profileName === 'string' ? profileName.slice(0, 64) : null,
        tool_name: event && typeof event.tool_name === 'string' ? event.tool_name.slice(0, 120) : null,
        agent_type: event && typeof event.agent_type === 'string' ? event.agent_type.slice(0, 64) : null,
        reason,
      }) + '\n',
    );
  } catch {
    /* never let logging change the decision */
  }
}

function main() {
  const profileName = process.argv[2];
  const policyPath = process.argv[3] || path.join(DEFAULT_ROOT, 'config', 'run-profiles.json');
  let input = '';
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    let event = null;
    let result;
    try {
      event = JSON.parse(input);
      const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
      const profiles = policy && typeof policy === 'object' ? policy.profiles : null;
      const profile =
        typeof profileName === 'string' && profiles && Object.prototype.hasOwnProperty.call(profiles, profileName)
          ? profiles[profileName]
          : null;
      result = profile ? decide(event, profile, { profileName }) : { allow: false, reason: 'unknown run profile' };
    } catch {
      result = { allow: false, reason: 'hook error (fail closed)' };
    }
    if (!result.allow) {
      logDenial(profileName, event, result.reason);
      emitDenyAndExit(result.reason);
    } else {
      process.exit(0);
    }
  });
}

module.exports = { decide, agentTools, validBashExact };
if (require.main === module) {
  process.on('uncaughtException', () => emitDenyAndExit('hook crashed (fail closed)'));
  process.stdin.on('error', () => emitDenyAndExit('stdin error (fail closed)'));
  try {
    main();
  } catch {
    emitDenyAndExit('hook crashed (fail closed)');
  }
}
