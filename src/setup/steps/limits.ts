// src/setup/steps/limits.ts
// Step 8: limits and pacing. Writes catalog values into .env through the comment-preserving
// writer. Safe defaults only fill MISSING keys; a raised value needs a confirm; min/max pairs
// are checked before anything is written. Values here are limits, not secrets.
import path from 'node:path';
import {
  LIMITS,
  specFor,
  validateLimit,
  validatePairs,
  type LimitGroup,
  type LimitSpec,
} from '../limitsCatalog.js';
import { updateEnvText, writeEnvFile } from '../envWriter.js';
import type { SetupContext, SetupStep } from '../runner.js';

const GROUPS: { id: LimitGroup; title: string }[] = [
  { id: 'matching', title: 'Matching' },
  { id: 'daily-caps', title: 'Daily caps' },
  { id: 'weekly-caps', title: 'Weekly caps' },
  { id: 'per-company', title: 'Per-company limits' },
  { id: 'quiet-hours', title: 'Quiet hours' },
  { id: 'pacing', title: 'Pacing' },
  { id: 'cooldowns', title: 'Cooldowns and cadence' },
];

const LINE_RE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

interface EnvEntry {
  value: string;
  inlineComment: boolean;
}

// Same reading the loaders and the doctor checks use: outer quote pair stripped, an unquoted
// " #..." tail is a comment. Last line wins.
function parseEnv(text: string): Map<string, EnvEntry> {
  const out = new Map<string, EnvEntry>();
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line.replace(/\r$/, ''));
    if (!m) continue;
    const raw = m[2].trim();
    const q = raw[0];
    if ((q === '"' || q === "'") && raw.length >= 2 && raw.endsWith(q)) {
      out.set(m[1], { value: raw.slice(1, -1), inlineComment: false });
      continue;
    }
    const c = /\s+#/.exec(raw);
    if (c) out.set(m[1], { value: raw.slice(0, c.index).trim(), inlineComment: !/["']/.test(raw) });
    else out.set(m[1], { value: raw, inlineComment: false });
  }
  return out;
}

function readEnvText(ctx: SetupContext): string {
  if (ctx.fs.exists(ctx.envPath)) return ctx.fs.read(ctx.envPath);
  const example = path.join(ctx.root, '.env.example');
  return ctx.fs.exists(example) ? ctx.fs.read(example) : '';
}

const PAIR_MSG = /^(\w+) \(\d+\) is above (\w+) \(/;

export const limitsStep: SetupStep = {
  id: 'limits',
  title: 'Limits and pacing',
  checkIds: ['env-limits', 'env-inline-comments'],
  async run(ctx) {
    const { io } = ctx;
    const envText = readEnvText(ctx);
    const parsed = parseEnv(envText);
    const current = (spec: LimitSpec): string | null => {
      const v = parsed.get(spec.key)?.value;
      return v === undefined || v === '' ? null : v;
    };
    const effective = (spec: LimitSpec): string => current(spec) ?? String(spec.default);

    io.say('Daily caps are hard stops enforced in code. Quiet hours (local time) pause all actions.');
    io.say('Pacing adds human-like gaps and bursts. Per-company limits cap how many people you contact at one company.');
    for (const g of GROUPS) {
      io.say(`${g.title}:`);
      for (const spec of LIMITS.filter((l) => l.group === g.id)) {
        const note = spec.raiseNote ? ` Careful: ${spec.raiseNote}` : '';
        io.say(`  ${spec.key} = ${effective(spec)} (${spec.unit}) ${spec.what}${note}`);
      }
    }

    const mode = await io.choose(
      'How do you want to set limits?',
      [
        { value: 'safe', label: 'safe defaults (fill every missing key, keep existing values)' },
        { value: 'review', label: 'review each group' },
        { value: 'leave', label: 'leave as is' },
      ],
      'safe',
    );
    if (mode === 'leave') {
      if ([...parsed.values()].some((e) => e.inlineComment)) {
        io.say('Some .env lines have inline comments, which the loaders read as part of the value. Rerun this step to clean them.');
      }
      return 'done';
    }

    // Values that will be in .env after this step, by key.
    const chosen: Record<string, string> = {};
    for (const spec of LIMITS) {
      const cur = current(spec);
      const why = cur === null ? null : validateLimit(spec, cur);
      if (
        why !== null &&
        (await io.confirm(`${spec.key} is invalid in .env (${why}). Reset it to the default ${spec.default}?`, true))
      ) {
        chosen[spec.key] = String(spec.default);
        continue;
      }
      chosen[spec.key] = effective(spec);
    }

    async function review(spec: LimitSpec): Promise<void> {
      for (;;) {
        const startValue = chosen[spec.key];
        const v = (
          await io.ask(`${spec.key} (${spec.unit}): ${spec.what}`, {
            default: startValue,
            validate: (x) => validateLimit(spec, x),
          })
        ).trim();
        const raised =
          spec.key !== 'CADENCE_GAPS_DAYS' && v !== startValue && Number(v) > Number(spec.default);
        if (raised) {
          io.say(`Warning: ${v} is above the default ${spec.default}.${spec.raiseNote ? ' ' + spec.raiseNote : ''}`);
          if (!(await io.confirm(`Really use ${v} for ${spec.key}?`, false))) continue;
        }
        chosen[spec.key] = v;
        return;
      }
    }

    if (mode === 'review') {
      for (const g of GROUPS) {
        if (!(await io.confirm(`Review ${g.title}?`, false))) continue;
        for (const spec of LIMITS.filter((l) => l.group === g.id)) await review(spec);
      }
      for (let round = 0; ; round++) {
        const conflicts = validatePairs(chosen);
        if (conflicts.length === 0) break;
        if (round >= 5) throw new Error('limits still conflict: ' + conflicts.join('; '));
        for (const c of conflicts) {
          io.say(c);
          const m = PAIR_MSG.exec(c);
          if (!m) continue;
          for (const key of [m[1], m[2]]) {
            const spec = specFor(key);
            if (spec) await review(spec);
          }
        }
      }
    } else {
      const conflicts = validatePairs(chosen);
      if (conflicts.length > 0) throw new Error('limits conflict: ' + conflicts.join('; '));
    }

    // Missing keys get their value without touching existing ones; then everything that differs
    // from the file (changed values, inline-comment lines) is rewritten with a plain update.
    const all: Record<string, string> = {};
    for (const spec of LIMITS) all[spec.key] = chosen[spec.key];
    const first = updateEnvText(envText, all, { onlyIfMissing: true });
    const plain: Record<string, string> = {};
    for (const spec of LIMITS) if (current(spec) !== null) plain[spec.key] = chosen[spec.key];
    // inline comments on keys outside the catalog: keep their value, drop the comment
    for (const [k, e] of parsed) if (e.inlineComment && !(k in plain)) plain[k] = e.value;
    const second = updateEnvText(first.text, plain);
    if (second.text !== envText || !ctx.fs.exists(ctx.envPath)) {
      writeEnvFile(ctx.envPath, second.text, ctx.fs, ctx.now);
      io.say(`.env updated (${new Set([...first.changed, ...second.changed]).size} keys)`);
    }

    io.say('Effective limits:');
    for (const spec of LIMITS) io.say(`  ${spec.key} = ${chosen[spec.key]}`);
    io.say('Change any later with: npm run setup -- --step limits');
    return 'done';
  },
};
