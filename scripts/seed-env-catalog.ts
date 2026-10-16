// scripts/seed-env-catalog.ts
// ONE-SHOT generator (plan 8H, Task 2): reads the committed .env.example (no secrets), splits sections on the
// `# ====` banners and prints a TypeScript object literal per `KEY=` or `# KEY=` line to stdout. The comment block
// above a key becomes `about`; the unambiguous sentences (`Default X.`, `integer A..B`, `Allowed: ...`, `Secret.`)
// are lifted into structured fields. The builder pastes it into src/settings/envCatalog.ts and edits by hand.
// Deleted at the end of Task 3 (kept until the golden round trip passes). Run: npx tsx scripts/seed-env-catalog.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SECTION_BY_BANNER: Array<[RegExp, string]> = [
  [/^Credentials: job sources/, 'credentials-sources'],
  [/^Credentials: contact finding/, 'contact-finding'],
  [/^Credentials: Gmail/, 'credentials-gmail'],
  [/^Safety and dry-run/, 'safety'],
  [/^Classifier/, 'classifier'],
  [/^Limits/, 'limits'],
  [/^LinkedIn/, 'linkedin'],
  [/^Naukri/, 'naukri'],
  [/^Scheduler/, 'scheduler'],
  [/^Dashboard/, 'dashboard'],
  [/^Telegram/, 'telegram'],
  [/^Layout memory/, 'layout'],
  [/^Update and backup/, 'update-backup'],
  [/^Advanced/, 'advanced'],
];

export interface SeedEntry {
  key: string;
  section: string;
  exampleActive: boolean;
  about: string;
  default: string | null;
  secret: boolean;
  min?: number;
  max?: number;
  allowed?: string[];
}

function sectionOf(banner: string): string {
  for (const [re, id] of SECTION_BY_BANNER) if (re.test(banner)) return id;
  return 'advanced';
}

export function seed(text: string): SeedEntry[] {
  const lines = text.split(/\r?\n/);
  const out: SeedEntry[] = [];
  let section = 'advanced';
  let block: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^# =+$/.test(l)) {
      const banner = lines[i + 1]?.replace(/^#\s?/, '') ?? '';
      if (lines[i + 2] && /^# =+$/.test(lines[i + 2]!)) {
        section = sectionOf(banner);
        i += 2;
      } else if (lines[i + 1] && !/^# =+$/.test(lines[i + 1]!)) {
        // multi-line banner: skip to its closing rule
        let j = i + 1;
        const first = banner;
        while (j < lines.length && !/^# =+$/.test(lines[j]!)) j++;
        section = sectionOf(first);
        i = j;
      }
      block = [];
      continue;
    }
    const m = /^(#\s?)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(l);
    // A commented mention inside a sentence ("# WEB_CHAT_ENABLED=true.") is prose, not a key line.
    const prose = m !== null && m[1] !== undefined && /[A-Za-z]\.$/.test(m[3]!);
    if (m && !prose) {
      const about = block.join(' ').replace(/\s+/g, ' ').trim();
      const def = /Default ([^.,;]+?)[.,;]/.exec(about)?.[1]?.trim() ?? null;
      const range = /(?:integer\s+)?(\d+)\.\.(\d+)/.exec(about);
      const allowed = /Allowed: ([^.]+)\./.exec(about)?.[1]?.split(/,| or /).map((s) => s.trim()).filter(Boolean);
      out.push({
        key: m[2]!,
        section,
        exampleActive: m[1] === undefined,
        about,
        default: def,
        secret: /\bSecret\b/.test(about),
        ...(range ? { min: Number(range[1]), max: Number(range[2]) } : {}),
        ...(allowed && allowed.length > 0 ? { allowed } : {}),
      });
      block = [];
      continue;
    }
    if (l.startsWith('#')) block.push(l.replace(/^#\s?/, ''));
    else if (l.trim() === '') block = [];
  }
  return out;
}

function main(): void {
  const text = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
  const entries = seed(text);
  process.stdout.write(`// ${entries.length} entries seeded from .env.example\n`);
  process.stdout.write(`export const SEED: unknown[] = ${JSON.stringify(entries, null, 2)};\n`);
}

if (process.argv[1] && /seed-env-catalog\.[tj]s$/.test(process.argv[1])) main();
