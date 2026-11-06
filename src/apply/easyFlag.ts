/* One reading of APPLY_LINKEDIN_EASY. Since 2026-11-06 Easy Apply is ON by default: unset, blank or any value other than
 * exactly `false` (trimmed) means on; exactly `false` turns it off. Every other gate (drip lane only, ceiling, active hours,
 * apply caps, vetoes, fact and output gates, dry run, kill switch) is unchanged. */
export function linkedinEasyEnabled(env: Record<string, string | undefined>): boolean {
  return (env.APPLY_LINKEDIN_EASY ?? '').trim() !== 'false';
}
