// src/settings/schemas/factGate.ts
// user-data/fact-gate.json. Consumer: src/resumeFacts.ts loadFactGateConfig (read fresh per call; invalid file throws, fail
// closed). The shape rules live in validateFactGateObject; this adapter turns its thrown message into an error.
import { validateFactGateObject } from '../../resumeFacts.js';
import type { SchemaResult } from './util.js';

export function validateFactGate(raw: unknown): SchemaResult {
  try {
    validateFactGateObject(raw);
    return { errors: [], warnings: [] };
  } catch (e) {
    return { errors: [String((e as Error).message).replace(/^user-data\/fact-gate\.json: /, '')], warnings: [] };
  }
}
