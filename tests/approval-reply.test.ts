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

describe("answerApproval respects the deadline the server set", () => {
  const soon = { ...REQ, expiresAt: 0 };

  it("does not ask a human about a request that has already expired", async () => {
    // The server has stopped waiting. Raising a dialog here invites a click
    // that can do nothing, which is worse than no dialog.
    const bless = vi.fn(async () => true);
    const dismiss = vi.fn();
    const msg = await answerApproval(
      { ...soon, expiresAt: Date.now() - 1 },
      { ...deps(bless), dismiss },
    );
    expect(bless).not.toHaveBeenCalled();
    expect(msg.ok).toBe(false);
  });

  it("closes the dialog when the deadline passes with no answer", async () => {
    vi.useFakeTimers();
    try {
      const dismiss = vi.fn();
      const pending = answerApproval(
        { ...REQ, expiresAt: Date.now() + 10_000 },
        { ...deps(() => new Promise<boolean>(() => {})), dismiss },
      );
      await vi.advanceTimersByTimeAsync(10_001);
      await expect(pending).resolves.toEqual({
        v: 1,
        type: "approval_result",
        id: "req-1",
        ok: false,
      });
      expect(dismiss).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still approves normally when the human answers in time", async () => {
    const dismiss = vi.fn();
    const msg = await answerApproval(
      { ...REQ, expiresAt: Date.now() + 10_000 },
      { ...deps(async () => true), dismiss },
    );
    expect(msg.ok).toBe(true);
    expect(dismiss).not.toHaveBeenCalled();
  });

  it("works when the server sent no deadline at all", async () => {
    const msg = await answerApproval(REQ, { ...deps(async () => true), dismiss: vi.fn() });
    expect(msg.ok).toBe(true);
  });
});
