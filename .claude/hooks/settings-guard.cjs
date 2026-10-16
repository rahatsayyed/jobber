#!/usr/bin/env node
// Settings isolation guard for PreToolUse (plan 8H task 9). Standalone, the kill-switch.cjs pattern: no dependencies,
// fails closed on every error. Two rules:
//  1. Deny any tool call whose serialized input mentions the dashboard settings API or its private stores.
//  2. Deny Edit/Write/NotebookEdit and Bash writes (redirection, tee, sed -i, cp/mv/install/truncate/dd) that target a
//     file whose basename is exactly `.env` or `.env.<anything but "example">`. `.env.example` stays editable.
'use strict';

const FORBIDDEN_MENTIONS = ['/api/settings', '.jobber/settings-backups', '.jobber/settings/', 'settings_pending'];

// `.env`, `.env.local`, `.env.production`, ...; not `.env.example`, not `.envrc`.
function isProtectedEnvName(name) {
  if (typeof name !== 'string') return false;
  const base = name.replace(/[\\/]+$/, '').split(/[\\/]/).pop().replace(/^["']+|["']+$/g, '');
  const lower = base.toLowerCase(); // case-insensitive filesystems (macOS) resolve .ENV to .env
  return lower === '.env' || /^\.env\.(?!example$)/.test(lower);
}

function serialize(input) {
  try {
    return JSON.stringify(input === undefined ? null : input);
  } catch {
    return null;
  }
}

function mention(text) {
  const norm = (x) => x.toLowerCase().replace(/\\\\/g, '/').replace(/\\\//g, '/');
  const forms = [norm(text)];
  try {
    forms.push(norm(decodeURIComponent(text)));
  } catch {
    // malformed escape: lenient %XX decode instead
    forms.push(norm(text.replace(/%([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))));
  }
  return FORBIDDEN_MENTIONS.find((m) => forms.some((t) => t.includes(m))) || null;
}

const WRITERS = new Set(['tee', 'cp', 'mv', 'install', 'truncate', 'dd', 'ln']);

function stripQuotes(tok) {
  return tok.replace(/^["']+|["']+$/g, '');
}

function bashTargetsEnv(command) {
  if (typeof command !== 'string') return false;
  // redirections: > file, >> file, >| file, 2> file, &> file
  const redir = /(?:^|[^<>])(?:\d*|&)>>?\|?\s*(["']?[^\s"'|&;<>()]+["']?)/g;
  let m;
  while ((m = redir.exec(command)) !== null) if (isProtectedEnvName(stripQuotes(m[1]))) return true;
  // command segments
  for (const seg of command.split(/[;&|\n]+/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean).map(stripQuotes);
    let i = 0;
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
    while (i < toks.length && (toks[i] === 'sudo' || toks[i] === 'command' || toks[i] === 'env')) i++;
    if (i >= toks.length) continue;
    const cmd = toks[i].split('/').pop();
    const args = toks.slice(i + 1);
    if (cmd === 'sed' || cmd === 'perl') {
      const inPlace = args.some((a) => /^-[A-Za-z]*i/.test(a) || a === '--in-place' || a.startsWith('--in-place='));
      if (inPlace && args.some((a) => isProtectedEnvName(a))) return true;
    } else if (WRITERS.has(cmd)) {
      if (cmd === 'dd') {
        if (args.some((a) => a.startsWith('of=') && isProtectedEnvName(a.slice(3)))) return true;
      } else if (cmd === 'tee' || cmd === 'truncate') {
        if (args.some((a) => !a.startsWith('-') && isProtectedEnvName(a))) return true;
      } else {
        // cp, mv, install, ln: the destination is the last non-option argument
        const operands = args.filter((a) => !a.startsWith('-'));
        if (operands.length && isProtectedEnvName(operands[operands.length - 1])) return true;
      }
    }
  }
  return false;
}

function decide(event) {
  try {
    if (!event || typeof event !== 'object' || typeof event.tool_name !== 'string') {
      return { allow: false, reason: 'malformed event' };
    }
    const text = serialize(event.tool_input);
    if (text === null) return { allow: false, reason: 'tool input not serializable (fail closed)' };
    const hit = mention(text + ' ' + event.tool_name);
    if (hit) return { allow: false, reason: 'the settings API and its stores are not reachable from agent tools' };
    const input = event.tool_input && typeof event.tool_input === 'object' ? event.tool_input : {};
    const name = event.tool_name;
    if (name === 'Edit' || name === 'Write' || name === 'NotebookEdit' || name === 'MultiEdit') {
      const target = input.file_path || input.notebook_path || input.path;
      if (isProtectedEnvName(target)) return { allow: false, reason: 'writing the .env file is not allowed from agent tools' };
    }
    if (name === 'Bash' && bashTargetsEnv(input.command)) {
      return { allow: false, reason: 'writing the .env file is not allowed from agent tools' };
    }
    return { allow: true, reason: '' };
  } catch {
    return { allow: false, reason: 'settings guard evaluation error (fail closed)' };
  }
}

function denyJson(reason) {
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Blocked by settings guard: ${reason}` },
  });
}

function emitDenyAndExit(reason) {
  try {
    process.stdout.write(denyJson(reason), () => process.exit(0));
  } catch {
    process.exit(0);
  }
}

module.exports = { decide, isProtectedEnvName, bashTargetsEnv };

if (require.main === module) {
  process.on('uncaughtException', () => emitDenyAndExit('hook crashed (fail closed)'));
  process.stdin.on('error', () => emitDenyAndExit('stdin error (fail closed)'));
  let input = '';
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('end', () => {
    let r;
    try {
      r = decide(JSON.parse(input));
    } catch {
      r = { allow: false, reason: 'hook error (fail closed)' };
    }
    if (r.allow) process.exit(0);
    else emitDenyAndExit(r.reason);
  });
}
