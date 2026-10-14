import fs from 'node:fs';
import path from 'node:path';

const USAGE_FILE = path.resolve(process.cwd(), '.hunter_usage.json');

interface HunterUsage {
  month: string;
  count: number;
}

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function readUsage(): HunterUsage {
  try {
    const raw = fs.readFileSync(USAGE_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as HunterUsage;
    if (parsed.month === currentMonth()) return parsed;
  } catch {
    // fall through to fresh usage
  }
  return { month: currentMonth(), count: 0 };
}

function writeUsage(usage: HunterUsage): void {
  try {
    fs.writeFileSync(USAGE_FILE, JSON.stringify(usage), 'utf-8');
  } catch {
    // best-effort persistence
  }
}

export interface HunterResult {
  emails: string[];
  pattern: string | null;
}

export async function hunterDomainSearch(domain: string): Promise<HunterResult | null> {
  if (process.env.HUNTER_ENABLED !== 'true') return null;

  try {
    const cap = Number(process.env.HUNTER_MONTHLY_CAP || 50);
    const usage = readUsage();
    if (usage.count >= cap) return null;

    usage.count += 1;
    writeUsage(usage);

    const apiKey = process.env.HUNTER_API_KEY;
    const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(
      domain
    )}&api_key=${encodeURIComponent(apiKey ?? '')}`;

    const res = await fetch(url);
    if (!res.ok) return null;
    const json: any = await res.json();

    const emails: string[] = (json?.data?.emails ?? [])
      .map((e: any) => e?.value)
      .filter((v: any) => typeof v === 'string');
    const pattern: string | null = json?.data?.pattern ?? null;

    return { emails, pattern };
  } catch {
    return null;
  }
}
