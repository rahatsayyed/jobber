// src/safety/inputGate.ts
export interface InputGateResult {
  text: string;
  flags: string[];
  blocked: boolean;
}

const DEFAULT_MAX_CHARS = 6000;

// Soft hyphen, CGJ, Arabic letter mark, Hangul fillers, Khmer vowels, Mongolian
// vowel separator, zero-width and bidi controls, word joiner and invisible
// operators, Hangul filler, variation selectors, BOM.
const FORMAT_CHARS =
  /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁤⁦-⁩ㅤ︀-️﻿]/g;
const FORMAT_CHARS_TEST = new RegExp(FORMAT_CHARS.source);
const INSTRUCTION_TAG = /<\/?\s*(system|assistant|developer|instructions?|tool_?call|function_?call)\b[^>]{0,200}>/i;
const ROLE_PREFIX = /^[ \t]*(system|assistant|developer)[ \t]*:/im;

// Linear-time comment stripping (no backtracking). An unterminated comment is left in place.
function stripHtmlComments(input: string): { text: string; found: boolean } {
  let out = '';
  let pos = 0;
  let found = false;
  for (;;) {
    const start = input.indexOf('<!--', pos);
    if (start === -1) break;
    const end = input.indexOf('-->', start + 4);
    if (end === -1) break;
    found = true;
    out += input.slice(pos, start);
    pos = end + 3;
  }
  return { text: found ? out + input.slice(pos) : input, found };
}

const OVERRIDE_PHRASES: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions?|prompts?|messages?)/i,
  /disregard (the |all |any )?(system|previous|prior) (prompt|instructions?)/i,
  /\byou are now\b/i,
  /\bnew instructions?\s*:/i,
  /do not (tell|inform|alert) the (user|owner|operator)/i,
  /\b(reveal|print|repeat|show) (your|the) (system )?prompt\b/i,
];

const SECRET_NOUNS =
  '(\\.env|env(?:ironment)? (?:file|variables?|vars?)|api[-_ ]?keys?|secrets?|passwords?|credentials?|(?:access|auth|api|session) tokens?|private keys?|ssh keys?|cookies?|storage[-_ ]?state)';

const EXFIL_PHRASES: RegExp[] = [
  new RegExp(
    `\\b(send|email|mail|post|upload|share|forward|exfiltrate|leak|reveal|print|output|show)\\b[^.\\n]{0,60}\\b${SECRET_NOUNS}`,
    'i',
  ),
  /\b(cat|read|open|print|type)\b[^.\n]{0,30}(\.env\b|~\/|\/etc\/|\bsecrets\/)/i,
  /\bsecrets\/[\w.-]*\.json\b/i,
];

export function gateInput(raw: string, opts: { maxChars?: number } = {}): InputGateResult {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const flags: string[] = [];
  // Hard-cap the raw input before any regex runs (ReDoS / cost bound).
  const ceiling = Math.max(maxChars * 4, 100000);
  let text = raw;
  let rawTruncated = false;
  if (text.length > ceiling) {
    text = text.slice(0, ceiling);
    rawTruncated = true;
  }

  const stripped = stripHtmlComments(text);
  if (stripped.found) {
    flags.push('html_comment');
    text = stripped.text;
  }

  if (FORMAT_CHARS_TEST.test(text)) {
    flags.push('hidden_chars');
    text = text.replace(FORMAT_CHARS, '');
  }

  let blocked = false;
  if (INSTRUCTION_TAG.test(text)) {
    flags.push('instruction_tag');
    blocked = true;
  }
  if (ROLE_PREFIX.test(text)) {
    flags.push('role_prefix');
    blocked = true;
  }
  if (OVERRIDE_PHRASES.some((re) => re.test(text))) {
    flags.push('override_phrase');
    blocked = true;
  }
  if (EXFIL_PHRASES.some((re) => re.test(text))) {
    flags.push('exfiltration');
    blocked = true;
  }

  if (rawTruncated || text.length > maxChars) {
    flags.push('truncated');
    text = text.slice(0, maxChars);
  }
  return { text, flags, blocked };
}

// ---- plan 6B: optional local classifier (additive; gateInput above is unchanged) ----

export interface ClassifierPort {
  classify(text: string): Promise<{ malicious: boolean; score: number; truncated: boolean }>;
}

export interface InputGateAsyncOptions {
  maxChars?: number;
  classifier?: ClassifierPort | (() => Promise<ClassifierPort>);
  requireClassifier?: boolean;
}

export interface InputGateAsyncResult extends InputGateResult {
  classifier?: { score: number; malicious: boolean; truncated: boolean };
}

export async function gateInputAsync(raw: string, opts: InputGateAsyncOptions = {}): Promise<InputGateAsyncResult> {
  const base = gateInput(raw, { maxChars: opts.maxChars });
  const result: InputGateAsyncResult = { ...base, flags: [...base.flags] };
  if (base.blocked) return result;

  if (opts.classifier === undefined) {
    if (opts.requireClassifier) {
      result.flags.push('classifier_unavailable');
      result.blocked = true;
    } else {
      result.flags.push('classifier_skipped');
    }
    return result;
  }

  try {
    const port = typeof opts.classifier === 'function' ? await opts.classifier() : opts.classifier;
    const v = await port.classify(result.text);
    result.classifier = { score: v.score, malicious: v.malicious, truncated: v.truncated };
    if (v.truncated) {
      result.flags.push('classifier_truncated');
      result.blocked = true;
    }
    if (v.malicious) {
      result.flags.push('classifier_injection');
      result.blocked = true;
    }
  } catch (e) {
    // Reason only (error message, one line, capped); never the text under classification.
    const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 200);
    console.error(`classifier unavailable: ${msg}`);
    result.flags.push('classifier_unavailable');
    if (opts.requireClassifier) result.blocked = true;
  }
  return result;
}
