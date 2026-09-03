import type { AuditRow } from "../shared/protocol";

export type StoredAuditRow = {
  origin: string;
  tool: string;
  field_names: string;
  ts: number;
};

/**
 * Stored audit rows to the wire shape.
 *
 * Shared by the session (the live view) and the account (the durable one), so
 * the two cannot drift into reporting the same table differently.
 *
 * A row whose `field_names` will not parse is kept with an empty list rather
 * than thrown away or thrown on: the row is evidence that a tool ran, and only
 * the field list is missing. One bad row must not cost the whole log — which
 * is what a bare `JSON.parse` in the listing query did.
 */
export function toAuditRows(rows: readonly StoredAuditRow[]): AuditRow[] {
  return rows.map((r) => ({
    origin: r.origin,
    tool: r.tool,
    fieldNames: parseFieldNames(r.field_names),
    timestamp: r.ts,
  }));
}

function parseFieldNames(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((x): x is string => typeof x === "string");
}
