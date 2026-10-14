import { createHash } from 'node:crypto';
import { isAbsolute, relative } from 'node:path';

export type KnownFailures = Record<string, number>;

interface TestReport {
  testResults: { name: string; status: string; assertionResults: { status: string }[] }[];
}

export function evaluateTestReport(
  report: TestReport,
  allowed: KnownFailures,
  root: string,
): { ok: boolean; unexpected: string[]; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  for (const f of report.testResults) {
    let failed = f.assertionResults.filter((a) => a.status === 'failed').length;
    if (failed === 0 && f.status === 'failed') failed = 1;
    if (failed === 0) continue;
    const rel = (isAbsolute(f.name) ? relative(root, f.name) : f.name).split('\\').join('/');
    counts[rel] = (counts[rel] ?? 0) + failed;
  }
  const unexpected = Object.entries(counts)
    .filter(([file, n]) => n > (Object.prototype.hasOwnProperty.call(allowed, file) ? allowed[file]! : 0))
    .map(([file]) => file);
  return { ok: unexpected.length === 0, unexpected, counts };
}

export function doctorRegression(
  before: { id: string; status: string }[],
  after: { id: string; status: string }[],
): string[] {
  const failedBefore = new Set(before.filter((b) => b.status === 'fail').map((b) => b.id));
  return after.filter((a) => a.status === 'fail' && !failedBefore.has(a.id)).map((a) => a.id);
}

export function fingerprint(text: string | null): string {
  if (text === null) return 'absent';
  return createHash('sha256').update(text).digest('hex');
}
