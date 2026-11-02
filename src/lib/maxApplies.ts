// The one parser of MAX_APPLIES_PER_DAY (integer, default 5). A blank, missing or invalid value is the default, never 0.
export const DEFAULT_MAX_APPLIES_PER_DAY = 5;

export function parseMaxAppliesPerDay(env: NodeJS.ProcessEnv): number {
  const raw = env.MAX_APPLIES_PER_DAY;
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return DEFAULT_MAX_APPLIES_PER_DAY;
  return Number(raw.trim());
}
