#!/usr/bin/env node
// Probe hook for plan 6B Task 1. Logs each PreToolUse call (tool name and agent fields only, never
// tool input) to debug/hook-probe.jsonl and denies reads of debug/probe-deny-marker.txt.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LOG = path.join(ROOT, 'debug', 'hook-probe.jsonl');
const MARKER = 'probe-deny-marker.txt';

let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  let ev = null;
  try {
    ev = JSON.parse(input);
  } catch {
    process.exit(0);
  }
  if (!ev || typeof ev !== 'object') process.exit(0);
  const target = String((ev.tool_input && (ev.tool_input.file_path || ev.tool_input.path)) || '');
  const deny = ev.tool_name === 'Read' && path.basename(target) === MARKER;
  if (!process.env.HOOK_PROBE_NO_LOG) {
    try {
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      fs.appendFileSync(
        LOG,
        JSON.stringify({
          ts: new Date().toISOString(),
          event: ev.hook_event_name,
          tool_name: ev.tool_name,
          agent_id: ev.agent_id,
          agent_type: ev.agent_type,
          session_id: ev.session_id,
          decision: deny ? 'deny' : 'allow',
        }) + '\n',
      );
    } catch {
      /* logging must never break the hook */
    }
  }
  if (deny) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: 'probe: marker file is blocked on purpose',
        },
      }),
    );
  }
  process.exit(0);
});
