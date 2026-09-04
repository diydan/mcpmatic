export type CallRow = {
  tool: string;
  /** SQLite has no boolean. 1 = the tool ran. */
  ok: number;
  reason: string | null;
  ms: number;
  ts: number;
};

export type ToolSummary = {
  tool: string;
  calls: number;
  ok: number;
  failed: number;
  /** Failure reason to count. Reasons only — never an argument or a value. */
  reasons: Record<string, number>;
  p50ms: number;
};

/**
 * What a site owner is shown.
 *
 * Per tool, and nothing per caller: no session, no account, no field names, no
 * values. The rows this reads are already free of those — the point of keeping
 * site telemetry in its own store rather than bolting outcomes onto the audit
 * table is that neither record can grow into the other.
 *
 * Median, not mean: one thirty-second timeout should not make a fast tool look
 * slow, and a merchant deciding whether their handler is the problem needs the
 * typical call.
 */
export function summarise(rows: readonly CallRow[]): ToolSummary[] {
  const byTool = new Map<string, CallRow[]>();
  for (const row of rows) {
    const list = byTool.get(row.tool);
    if (list) list.push(row);
    else byTool.set(row.tool, [row]);
  }

  const out: ToolSummary[] = [];
  for (const [tool, list] of byTool) {
    const reasons: Record<string, number> = {};
    let ok = 0;
    for (const row of list) {
      if (row.ok) ok += 1;
      else if (row.reason) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
    }
    out.push({
      tool,
      calls: list.length,
      ok,
      failed: list.length - ok,
      reasons,
      p50ms: median(list.map((r) => r.ms)),
    });
  }
  // Busiest first: the tool agents lean on hardest is the one worth fixing.
  return out.sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
