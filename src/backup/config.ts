import path from 'node:path';

export interface BackupConfig {
  dir: string | null;
  recipient: string | null;
  includeSecrets: boolean;
  rcloneRemote: string | null;
  retain: { daily: number; weekly: number; monthly: number };
  enabled: boolean;
  problems: string[];
  configured: boolean;
}

const RECIPIENT_RE = /^age1[a-z0-9]{50,}$/;
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*:[A-Za-z0-9_./ -]*$/;

function retention(env: NodeJS.ProcessEnv, key: string, def: number, problems: string[]): number {
  const raw = env[key]?.trim();
  if (!raw) return def;
  if (!/^\d{1,3}$/.test(raw) || Number(raw) > 365) {
    problems.push(`${key} must be an integer from 0 to 365`);
    return def;
  }
  return Number(raw);
}

export function loadBackupConfig(env: NodeJS.ProcessEnv, root: string): BackupConfig {
  const problems: string[] = [];

  let dir: string | null = null;
  const rawDir = env.BACKUP_DIR?.trim();
  if (rawDir) {
    if (/[\0\r\n]/.test(rawDir)) problems.push('BACKUP_DIR contains control characters');
    else {
      const d = path.isAbsolute(rawDir) ? path.normalize(rawDir) : path.resolve(root, rawDir);
      const rel = path.relative(path.resolve(root), d);
      const top = rel.split(path.sep)[0];
      if (rel === '' || ['user-data', 'config', 'secrets'].includes(top)) {
        problems.push('BACKUP_DIR must not be the project root or inside user-data, config or secrets');
      } else {
        dir = d;
      }
    }
  }

  let recipient: string | null = null;
  const rawRecipient = env.BACKUP_AGE_RECIPIENT?.trim();
  if (rawRecipient) {
    if (rawRecipient.startsWith('AGE-SECRET-KEY-')) {
      problems.push('BACKUP_AGE_RECIPIENT holds a private key; use the public key (age1...)');
    } else if (!RECIPIENT_RE.test(rawRecipient)) {
      problems.push('BACKUP_AGE_RECIPIENT is not a valid age public key');
    } else {
      recipient = rawRecipient;
    }
  }

  let rcloneRemote: string | null = null;
  const rawRemote = env.BACKUP_RCLONE_REMOTE?.trim();
  if (rawRemote) {
    if (REMOTE_RE.test(rawRemote) && !rawRemote.includes('..')) rcloneRemote = rawRemote;
    else problems.push('BACKUP_RCLONE_REMOTE must look like name:path');
  }

  const retain = {
    daily: retention(env, 'BACKUP_RETAIN_DAILY', 7, problems),
    weekly: retention(env, 'BACKUP_RETAIN_WEEKLY', 4, problems),
    monthly: retention(env, 'BACKUP_RETAIN_MONTHLY', 6, problems),
  };

  return {
    dir,
    recipient,
    includeSecrets: env.BACKUP_INCLUDE_SECRETS === 'true',
    rcloneRemote,
    retain,
    enabled: env.BACKUP_ENABLED === 'true',
    problems,
    configured: dir !== null && recipient !== null,
  };
}
