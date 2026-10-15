#!/usr/bin/env node
/**
 * UserPromptSubmit hook for interactive profiles (plan 8E task 7). Blocks a prompt that looks
 * like it contains a secret. The message is fixed and never echoes the match. Fails closed.
 * Output: {"decision":"block","reason":...} on stdout, exit 0 (Claude Code hook contract).
 */
'use strict';

const MESSAGE =
  'That looks like a secret. Do not paste secrets here. Rotate it if it was real, and enter it in the setup wizard instead.';

const PATTERNS = [
  /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/, // Telegram bot token
  /GOCSPX-[A-Za-z0-9_-]{20,}/, // Google OAuth client secret
  /AIza[0-9A-Za-z_-]{35}/, // Google API key
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI / Anthropic style
  /xox[abprs]-/, // Slack
  /AKIA[0-9A-Z]{16}/, // AWS access key id
  /-----BEGIN/, // PEM
  /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/, // dashboard token shape (accepted noise: any 43-char identifier)
  /(?<![A-Fa-f0-9])[A-Fa-f0-9]{64}(?![A-Fa-f0-9])/, // 64-hex run
  /#token=/i,
  /Authorization\s*:\s*Bearer\s+\S/i,
  /\b[A-Za-z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|PASS|COOKIE)[A-Za-z0-9_]*\s*[=:]\s*\S/i, // .env-style assignment
];

const MAX_PROMPT = 20000; // longer prompts are blocked (fail closed; bounds regex work)

function normalize(prompt) {
  return prompt
    .normalize('NFKC')
    .replace(/[\p{Cf}​-‍⁠﻿  -   　]/gu, '');
}

function looksSecret(prompt) {
  if (prompt.length > MAX_PROMPT) return true;
  if (PATTERNS.some((re) => re.test(prompt))) return true;
  const n = normalize(prompt);
  return n !== prompt && PATTERNS.some((re) => re.test(n));
}

function decide(input) {
  try {
    const ev = JSON.parse(input);
    if (!ev || typeof ev !== 'object' || typeof ev.prompt !== 'string') return { block: true };
    return { block: looksSecret(ev.prompt) };
  } catch {
    return { block: true };
  }
}

function out(r) {
  if (!r.block) process.exit(0);
  try {
    process.stdout.write(JSON.stringify({ decision: 'block', reason: MESSAGE }), () => process.exit(0));
  } catch {
    process.exit(0);
  }
}

function main() {
  let input = '';
  process.stdin.on('data', (c) => (input += c));
  process.stdin.on('error', () => out({ block: true }));
  process.stdin.on('end', () => out(decide(input)));
}

module.exports = { decide, looksSecret, MESSAGE };
if (require.main === module) {
  process.on('uncaughtException', () => out({ block: true }));
  try {
    main();
  } catch {
    out({ block: true });
  }
}
