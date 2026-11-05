#!/usr/bin/env node
/**
 * PreToolUse hook of the long-lived worker windows (scripts/claude-window.sh, Phase 1 of the window plan).
 * NOT an allowlist: the allow list of a window is the top-level permission set (.claude/settings.local.json).
 * This hook only keeps the guards that are not permissions: the kill switch and Gmail dry run (kill-switch.cjs, on EVERY
 * tool) and the tamper-protection denylist (tamper-guard.cjs, on the built-in tools it guards). Standalone, no
 * dependencies beyond the two sibling hooks, fails closed on every error.
 * Usage (from the window's --settings file): node window-guard.cjs <window> [ignored]
 */
'use strict';
const path = require('path');
const kill = require('./kill-switch.cjs');
const tamper = require('./tamper-guard.cjs');
const allowlist = require('./tool-allowlist.cjs');

const DEFAULT_ROOT = path.resolve(__dirname, '..', '..');

/** screen_args of the `linkedin_drip` profile (Phase 3b): active in every worker window, which has no run profile. */
const SCREENED_TOOLS = new Set([
  'mcp__outreach__escalate',
  'mcp__outreach__record_inbound',
  'mcp__outreach__save_reply_draft',
  'mcp__linkedin__linkedin_arm_send',
  'mcp__linkedin__linkedin_type',
  'mcp__linkedin__linkedin_open',
]);

function decide(event, opts) {
  const root = (opts && opts.root) || DEFAULT_ROOT;
  const env = (opts && opts.env) || process.env;
  try {
    if (!event || typeof event !== 'object' || typeof event.tool_name !== 'string') return { allow: false, reason: 'malformed event' };
    const k = kill.decide(event, { root, env });
    if (!k.allow) return k;
    if (tamper.GUARDED.has(event.tool_name)) {
      const g = tamper.decide(event, { root });
      if (!g.allow) return { allow: false, reason: g.reason };
    }
    // The Gmail MCP is an external package with no argument checks of its own, so the send_email argument screen of the
    // headless mail profile (attachments only a rendered resume PDF, no secret-shaped path) lives here for every window.
    if (event.tool_name === 'mcp__gmail__send_email') {
      const why = allowlist.screenSendEmail(event.tool_input, root);
      if (why) return { allow: false, reason: why };
    }
    // The same generic secret-path screen the headless `linkedin_drip` profile applies (config/run-profiles.json screen_args) to the
    // LinkedIn and outreach tools whose text arguments the model fills. tests/window-guard-linkedin.test.ts keeps this list equal to the profile.
    if (SCREENED_TOOLS.has(event.tool_name)) {
      const why = allowlist.screenSecretArgs(event.tool_input);
      if (why) return { allow: false, reason: why };
    }
    return { allow: true, reason: '' };
  } catch {
    return { allow: false, reason: 'window guard error (fail closed)' };
  }
}

function emitDenyAndExit(reason) {
  const out = JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Blocked by window policy: ${reason}` },
  });
  try {
    process.stdout.write(out, () => process.exit(0));
  } catch {
    process.exit(0);
  }
}

module.exports = { decide, SCREENED_TOOLS };

if (require.main === module) {
  process.on('uncaughtException', () => emitDenyAndExit('hook crashed (fail closed)'));
  process.stdin.on('error', () => emitDenyAndExit('stdin error (fail closed)'));
  let input = '';
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    let r;
    try {
      r = decide(JSON.parse(input), { root: DEFAULT_ROOT, env: process.env });
    } catch {
      r = { allow: false, reason: 'hook error (fail closed)' };
    }
    if (r.allow) process.exit(0);
    else emitDenyAndExit(r.reason);
  });
}
