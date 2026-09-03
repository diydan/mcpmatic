import { describe, expect, it, vi } from "vitest";
import { answerApproval } from "../src/lib/approval-reply";

const REQ = {
  id: "req-1",
  origin: "https://www.allbirds.com",
  tool: "fill_checkout_on_allbirds_com",
  fieldNames: ["address.line1", "address.postcode"],
  expiresAt: 0,
};

const PROFILE: Record<string, string> = {
  "address.line1": "14 Rivington Street",
  "address.postcode": "EC2A 3DZ",
  "shopper.lastName": "Chi",
};

function deps(bless: () => Promise<boolean>) {
  return {
    bless,
    resolveFields: (paths: readonly string[]) =>
      Object.fromEntries(paths.map((p) => [p, PROFILE[p]]).filter(([, v]) => v)),
  };
}

describe("answerApproval", () => {
  it("sends the approved fields when the human says yes", async () => {
    const msg = await answerApproval(REQ, deps(async () => true));
    expect(msg).toEqual({
      v: 1,
      type: "approval_result",
      id: "req-1",
      ok: true,
      fills: {
        "address.line1": "14 Rivington Street",
        "address.postcode": "EC2A 3DZ",
      },
    });
  });

  it("sends no fields when the human says no", async () => {
    const msg = await answerApproval(REQ, deps(async () => false));
    expect(msg).toEqual({ v: 1, type: "approval_result", id: "req-1", ok: false });
  });

  it("shows the human the origin and the exact field names", async () => {
    const bless = vi.fn(async () => true);
    await answerApproval(REQ, deps(bless));
    expect(bless).toHaveBeenCalledWith({
      origin: REQ.origin,
      tool: REQ.tool,
      fieldNames: REQ.fieldNames,
      destination: REQ.origin,
    });
  });

  it("resolves only the requested paths, never the whole profile", async () => {
    const msg = await answerApproval(REQ, deps(async () => true));
    expect(msg.ok && Object.keys(msg.fills ?? {})).not.toContain("shopper.lastName");
  });

  it("denies rather than stranding the call when the dialog throws", async () => {
    const msg = await answerApproval(
      REQ,
      deps(async () => {
        throw new Error("unmounted mid-approval");
      }),
    );
    expect(msg).toEqual({ v: 1, type: "approval_result", id: "req-1", ok: false });
  });
});
