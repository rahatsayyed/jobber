// src/platform/hookProbe.ts
export interface ProbeEntry {
  event?: string;
  tool_name?: string;
  agent_type?: string;
  agent_id?: string;
  decision?: string;
}

export function evaluateProbeLog(lines: string[]): { ok: boolean; findings: string[] } {
  const entries: ProbeEntry[] = [];
  for (const l of lines) {
    try {
      entries.push(JSON.parse(l) as ProbeEntry);
    } catch {
      /* skip */
    }
  }
  const findings: string[] = [];
  const inSub = entries.filter((e) => e.agent_type === 'hook-probe' && e.agent_id);
  if (!inSub.some((e) => e.decision === 'allow')) {
    findings.push('no PreToolUse event with agent_type=hook-probe: hooks did not fire for the subagent');
  }
  if (!inSub.some((e) => e.decision === 'deny')) {
    findings.push('no deny was issued inside the subagent: the marker read was not seen by the hook');
  }
  return { ok: findings.length === 0, findings };
}
