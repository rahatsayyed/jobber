// src/settings/schemas/replies.ts
// config/replies.json. Consumer: src/replies.ts loadRepliesConfig, which reads only `auto_record_enabled` and treats
// anything but the boolean true as false. The editor insists on a boolean so a typo cannot hide as "off".
import { z } from 'zod';
import { type SchemaResult, zodErrors } from './util.js';

const schema = z.object({ auto_record_enabled: z.boolean() });

export function validateReplies(raw: unknown): SchemaResult {
  const r = schema.safeParse(raw);
  return r.success ? { errors: [], warnings: [] } : { errors: zodErrors(r.error), warnings: [] };
}
