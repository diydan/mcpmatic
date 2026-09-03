import { describe, expect, it } from "vitest";
import { toAuditRows } from "../worker/audit-rows";

describe("toAuditRows", () => {
  it("maps a stored row to the wire shape", () => {
    expect(
      toAuditRows([
        {
          origin: "https://www.allbirds.com",
          tool: "fill_checkout_on_allbirds_com",
          field_names: '["address.line1"]',
          ts: 42,
        },
      ]),
    ).toEqual([
      {
        origin: "https://www.allbirds.com",
        tool: "fill_checkout_on_allbirds_com",
        fieldNames: ["address.line1"],
        timestamp: 42,
      },
    ]);
  });

  it("keeps a row whose field_names are unreadable, with no fields", () => {
    // One corrupt row must not cost the whole log. The row is evidence that a
    // tool ran; the field list is the part that is missing.
    const rows = toAuditRows([
      { origin: "o", tool: "t", field_names: "not json", ts: 1 },
    ]);
    expect(rows).toEqual([
      { origin: "o", tool: "t", fieldNames: [], timestamp: 1 },
    ]);
  });

  it("drops non-string entries rather than passing them to the client", () => {
    const rows = toAuditRows([
      { origin: "o", tool: "t", field_names: '["a", 3, null]', ts: 1 },
    ]);
    expect(rows[0].fieldNames).toEqual(["a"]);
  });

  it("treats a non-array payload as no fields", () => {
    const rows = toAuditRows([
      { origin: "o", tool: "t", field_names: '{"a":1}', ts: 1 },
    ]);
    expect(rows[0].fieldNames).toEqual([]);
  });
});
