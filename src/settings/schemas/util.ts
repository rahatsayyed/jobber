// src/settings/schemas/util.ts
// Shared result shape and zod issue formatting for the settings file validators.
// Messages carry a JSON path and a reason, never the rejected value.
import type { z } from 'zod';

export interface SchemaResult {
  errors: string[];
  warnings: string[];
}

export function pathOf(p: ReadonlyArray<PropertyKey>): string {
  if (p.length === 0) return '(root)';
  let s = '';
  for (const seg of p) s += typeof seg === 'number' ? `[${seg}]` : s ? `.${String(seg)}` : String(seg);
  return s;
}

export function zodErrors(err: z.ZodError): string[] {
  return err.issues.slice(0, 20).map((i) => `${pathOf(i.path)}: ${i.message.replace(/, received .*$/s, '').slice(0, 200)}`);
}
