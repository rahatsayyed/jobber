// Counts-only summary of a wake's stream-json log: tool calls per subagent_type and tool.
// Never returns or prints any content from the log.

export interface RunToolCounts {
  total: number;
  byAgent: Record<string, Record<string, number>>;
}

type Block = { type?: string; id?: string; name?: string; input?: { subagent_type?: unknown } };

export function summarizeRunLog(text: string): RunToolCounts {
  const agentOf = new Map<string, string>(); // Agent tool_use id -> subagent_type
  const byAgent: Record<string, Record<string, number>> = {};
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let o: { type?: unknown; parent_tool_use_id?: unknown; message?: { content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'assistant' || !o.message || !Array.isArray(o.message.content)) continue;
    const parent = typeof o.parent_tool_use_id === 'string' ? o.parent_tool_use_id : null;
    const who = parent ? (agentOf.get(parent) ?? 'subagent') : '(main)';
    for (const b of o.message.content as Block[]) {
      if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      if (b.name === 'Agent' || b.name === 'Task') {
        const st = b.input?.subagent_type;
        if (typeof b.id === 'string') agentOf.set(b.id, typeof st === 'string' ? st.slice(0, 60) : 'general-purpose');
      }
      const m = (byAgent[who] ??= {});
      m[b.name] = (m[b.name] ?? 0) + 1;
      total++;
    }
  }
  return { total, byAgent };
}

export function renderRunToolCounts(runId: string, r: RunToolCounts): string {
  const out = [`run ${runId}: ${r.total} tool calls`];
  const agents = Object.entries(r.byAgent).map(([a, m]) => [a, m, Object.values(m).reduce((x, y) => x + y, 0)] as const);
  agents.sort((a, b) => b[2] - a[2]);
  for (const [a, m, n] of agents) {
    out.push(`  ${a}: ${n}`);
    for (const [t, c] of Object.entries(m).sort((x, y) => y[1] - x[1])) out.push(`    ${t}: ${c}`);
  }
  return out.join('\n');
}
