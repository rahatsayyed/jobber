#!/usr/bin/env node
/**
 * PreToolUse hook for restricted runs (plan 6B). Allowlist, not blocklist: any tool that is not
 * named for the active run profile is denied. Fails closed on every error.
 * Usage (from the run's --settings file): node tool-allowlist.cjs <profile> [policy-path]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');
const SECRET_ARG_RES = [
  /\.env\b/i,
  /\bsecrets\//i,
  /\buser-data\//i,
  /data\.sqlite/i,
  /id_rsa/i,
  /(^|[\s"'=])~\//,
  /(^|[\s"'=])\/(etc|root|home|users|tmp|var)\//i,
];
const BAD_BASENAME = /^\.env|secret|state\.json$|\.sqlite$/i;
const AGENT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const TOOL_NAME = /^[A-Za-z0-9_-]+$/;

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

function* strings(v, depth) {
  if (depth > 8) return;
  if (typeof v === 'string') yield v;
  else if (Array.isArray(v)) for (const x of v) yield* strings(x, depth + 1);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) yield* strings(x, depth + 1);
}

function validEntries(list) {
  return (
    Array.isArray(list) &&
    list.every((e) => typeof e === 'string' && TOOL_NAME.test(e) && !e.includes('*')) &&
    // a bare mcp__server entry (no tool part) is a whole-server wildcard
    list.every((e) => !/^mcp__[A-Za-z0-9-]+$/.test(e))
  );
}

function decide(event, profile, opts) {
  const root = (opts && opts.root) || DEFAULT_ROOT;
  const deny = (reason) => ({ allow: false, reason });
  try {
    if (!event || typeof event !== 'object' || typeof event.tool_name !== 'string') return deny('malformed event');
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return deny('no profile');
    const allowList = profile.allow === undefined ? [] : profile.allow;
    const builtins = profile.builtin_tools === undefined ? [] : profile.builtin_tools;
    if (!validEntries(allowList) || !validEntries(builtins)) {
      return deny('profile contains wildcard or invalid entries');
    }
    const name = event.tool_name;
    let allowed = new Set([...allowList, ...builtins]);

    if (event.agent_id || event.agent_type) {
      const tools = agentTools(event.agent_type, root);
      if (!tools) return deny('subagent type has no definition file');
      allowed = new Set(tools.filter((t) => allowed.has(t)));
    }
    if (!allowed.has(name)) return deny('tool not in allowlist');

    const rule = profile.path_rules && profile.path_rules[name];
    if (rule) {
      const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
      const fp = input.file_path || input.path;
      if (typeof fp !== 'string' || fp === '') return deny('path rule: no path');
      if (!Array.isArray(rule.prefixes) || rule.prefixes.length === 0) return deny('path rule: no prefixes');
      let resolved = path.resolve(root, fp);
      try {
        resolved = fs.realpathSync(resolved);
      } catch {
        /* a not-yet-existing file keeps its lexical path */
      }
      const ok = rule.prefixes.some((p) => {
        if (typeof p !== 'string') return false;
        const base = path.join(root, p);
        return resolved === base || resolved.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
      });
      if (!ok) return deny('path outside allowed prefixes');
      if (BAD_BASENAME.test(path.basename(resolved))) return deny('path rule: sensitive file name');
    }

    if (Array.isArray(profile.screen_args) && profile.screen_args.includes(name)) {
      for (const s of strings(event.tool_input, 0)) {
        if (SECRET_ARG_RES.some((re) => re.test(s))) return deny('secret-shaped path in tool arguments');
      }
    }
    return { allow: true, reason: '' };
  } catch {
    return deny('policy evaluation error (fail closed)');
  }
}

function emitDeny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Blocked by run policy: ${reason}` },
    }),
  );
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
      result = profile ? decide(event, profile) : { allow: false, reason: 'unknown run profile' };
    } catch {
      result = { allow: false, reason: 'hook error (fail closed)' };
    }
    if (!result.allow) {
      logDenial(profileName, event, result.reason);
      emitDeny(result.reason);
    }
    process.exit(0);
  });
}

module.exports = { decide, agentTools };
if (require.main === module) {
  try {
    main();
  } catch {
    try {
      emitDeny('hook crashed (fail closed)');
    } catch {
      process.exit(2);
    }
    process.exit(0);
  }
}
