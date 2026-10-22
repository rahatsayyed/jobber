#!/usr/bin/env node
// Kill switch + Gmail dry run for PreToolUse (plan 8A task 7). One rule, shared by
// tool-allowlist.cjs, scripts/run-claude.ts (via createRequire) and the settings.json matcher hook.
// No dependencies. Fails closed on every error.
'use strict';
const fs = require('fs');
const path = require('path');

// parseDryFlag(value): the master dry-run flag. Dry iff the trimmed, lowercased value is "1" or "true";
// anything else (unset, empty, "false", "0", "yes") is LIVE. This must stay identical to parseDryFlag in
// src/safety/dryRun.ts; tests/dryrun-parity.test.ts runs both over the same inputs.
function parseDryFlag(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true';
}

// stopActive(root, env): stopped when <root>/.jobber/STOP exists, JOBBER_KILL=1,
// or the stat errors for any reason but ENOENT.
function stopActive(root, env) {
  const e = env || {};
  if (e.JOBBER_KILL === '1') return { stopped: true, reason: 'kill switch active: JOBBER_KILL=1' };
  try {
    fs.statSync(path.join(root, '.jobber', 'STOP'));
    return { stopped: true, reason: 'kill switch active: .jobber/STOP exists' };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { stopped: false, reason: '' };
    return { stopped: true, reason: 'kill switch active: STOP file unreadable (fail closed)' };
  }
}

function decide(event, opts) {
  try {
    const root = (opts && opts.root) || path.resolve(__dirname, '..', '..');
    const env = (opts && opts.env) || process.env;
    const s = stopActive(root, env);
    if (s.stopped) return { allow: false, reason: s.reason };
    if (event && event.tool_name === 'mcp__gmail__send_email' && parseDryFlag(env.JOBBER_DRY_RUN)) {
      return { allow: false, reason: 'dry run: gmail send blocked (JOBBER_DRY_RUN is on)' };
    }
    return { allow: true, reason: '' };
  } catch {
    return { allow: false, reason: 'kill switch evaluation error (fail closed)' };
  }
}

function denyJson(reason) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Blocked by run policy: ${reason}` },
  });
}

function emitDenyAndExit(reason) {
  try {
    process.stdout.write(denyJson(reason), () => process.exit(0));
  } catch {
    process.exit(0);
  }
}

module.exports = { stopActive, decide, parseDryFlag };

if (require.main === module) {
  process.on('uncaughtException', () => emitDenyAndExit('hook crashed (fail closed)'));
  process.stdin.on('error', () => emitDenyAndExit('stdin error (fail closed)'));
  let input = '';
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    let r;
    try {
      const event = JSON.parse(input);
      if (!event || typeof event !== 'object') r = { allow: false, reason: 'malformed event' };
      else r = decide(event, { root: path.resolve(__dirname, '..', '..'), env: process.env });
    } catch {
      r = { allow: false, reason: 'hook error (fail closed)' };
    }
    if (r.allow) process.exit(0);
    else emitDenyAndExit(r.reason);
  });
}
