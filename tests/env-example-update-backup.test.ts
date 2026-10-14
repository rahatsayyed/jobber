import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const text = readFileSync(join(__dirname, '..', '.env.example'), 'utf8');
const lines = text.split(/\r?\n/);

function assigned(key: string): string[] {
  return lines.filter((l) => l.startsWith(`${key}=`));
}

function value(key: string): string {
  const raw = assigned(key)[0]!.slice(key.length + 1);
  return raw.replace(/\s+#.*$/, '').trim();
}

const KEYS = [
  'AUTO_UPDATE',
  'AUTO_UPDATE_REMOTE',
  'AUTO_UPDATE_BRANCH',
  'AUTO_UPDATE_TAG_PATTERN',
  'AUTO_UPDATE_REQUIRE_SIGNED',
  'AUTO_UPDATE_SIGNERS_FILE',
  'AUTO_UPDATE_REVIEW_PATHS',
  'BACKUP_ENABLED',
  'BACKUP_DIR',
  'BACKUP_AGE_RECIPIENT',
  'BACKUP_INCLUDE_SECRETS',
  'BACKUP_RCLONE_REMOTE',
  'BACKUP_RETAIN_DAILY',
  'BACKUP_RETAIN_WEEKLY',
  'BACKUP_RETAIN_MONTHLY',
];

describe('.env.example update and backup keys', () => {
  it.each(KEYS)('declares %s exactly once', (key) => {
    expect(assigned(key)).toHaveLength(1);
  });

  it('ships the risky switches off', () => {
    expect(value('AUTO_UPDATE')).toBe('false');
    expect(value('BACKUP_ENABLED')).toBe('false');
    expect(value('BACKUP_INCLUDE_SECRETS')).toBe('false');
  });

  it('ships no value that looks like a key', () => {
    expect(text).not.toMatch(/AGE-SECRET-KEY/);
    expect(text).not.toMatch(/age1[a-z0-9]{50}/);
    expect(value('BACKUP_AGE_RECIPIENT')).toBe('');
  });
});
