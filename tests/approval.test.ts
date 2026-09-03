import { describe, expect, it, vi } from "vitest";
import {
  ApprovalGate,
  approvalFailureText,
  missingFills,
  prepareFills,
  stripProfilePaths,
  type ApprovalRequestPayload,
} from "../worker/approval";

describe("missingFills", () => {
  const declared = ["shopper.firstName", "address.line1"];

  it("returns every declared path when args carry none of them", () => {
    expect(missingFills(declared, {})).toEqual([
      "shopper.firstName",
      "address.line1",
    ]);
  });

  it("returns nothing when args already carry every declared path", () => {
    const args = { "shopper.firstName": "Dana", "address.line1": "14 Rivington" };
    expect(missingFills(declared, args)).toEqual([]);
  });

  it("returns only the paths that are absent", () => {
    expect(missingFills(declared, { "address.line1": "14 Rivington" })).toEqual([
      "shopper.firstName",
    ]);
  });

  it("treats an empty string as supplied, not missing", () => {
    // A human may legitimately have a blank field. Absence is undefined.
    expect(missingFills(["address.line1"], { "address.line1": "" })).toEqual([]);
  });

  it("returns nothing when the manifest declares no fills", () => {
    expect(missingFills(undefined, {})).toEqual([]);
  });
});

describe("stripProfilePaths", () => {
  const declared = ["address.line1", "address.postcode"];

  it("removes caller-supplied profile paths so MCP cannot self-fill", () => {
    const args = { size: "9", "address.line1": "attacker supplied" };
    expect(stripProfilePaths(declared, args)).toEqual({ size: "9" });
  });

  it("leaves arguments the tool's own schema declares", () => {
    const args = { origin: "LHR", destination: "JFK" };
    expect(stripProfilePaths(declared, args)).toEqual(args);
  });

  it("does not mutate the caller's object", () => {
    const args = { "address.line1": "x" };
    stripProfilePaths(declared, args);
    expect(args).toEqual({ "address.line1": "x" });
  });

  it("is a no-op when the manifest declares no fills", () => {
    expect(stripProfilePaths(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});

function gate(opts: {
  hasConsole?: () => boolean;
  timeoutMs?: number;
} = {}) {
  const sent: ApprovalRequestPayload[] = [];
  const g = new ApprovalGate({
    hasConsole: opts.hasConsole ?? (() => true),
    send: (req) => sent.push(req),
    timeoutMs: opts.timeoutMs ?? 45_000,
  });
  return { g, sent };
}

const ASK = {
  origin: "https://www.allbirds.com",
  tool: "fill_checkout_on_allbirds_com",
  fieldNames: ["address.line1", "address.postcode"],
};

describe("ApprovalGate", () => {
  it("returns needs-console without asking when no console is attached", async () => {
    const { g, sent } = gate({ hasConsole: () => false });
    const outcome = await g.request(ASK);
    expect(outcome).toEqual({ ok: false, reason: "needs-console" });
    expect(sent).toEqual([]);
  });

  it("sends one request naming the origin, tool and fields", async () => {
    const { g, sent } = gate();
    void g.request(ASK);
    expect(sent).toHaveLength(1);
    expect(sent[0].origin).toBe(ASK.origin);
    expect(sent[0].tool).toBe(ASK.tool);
    expect(sent[0].fieldNames).toEqual(ASK.fieldNames);
    expect(typeof sent[0].id).toBe("string");
  });

  it("resolves with the fills the console supplied", async () => {
    const { g, sent } = gate();
    const pending = g.request(ASK);
    g.settle(sent[0].id, true, {
      "address.line1": "14 Rivington Street",
      "address.postcode": "EC2A 3DZ",
    });
    await expect(pending).resolves.toEqual({
      ok: true,
      fills: {
        "address.line1": "14 Rivington Street",
        "address.postcode": "EC2A 3DZ",
      },
    });
  });

  it("resolves denied when the human declines", async () => {
    const { g, sent } = gate();
    const pending = g.request(ASK);
    g.settle(sent[0].id, false);
    await expect(pending).resolves.toEqual({ ok: false, reason: "denied" });
  });

  it("never returns a field the tool did not declare", async () => {
    // The console is not trusted to decide which fields travel; the request
    // named them, and only those resolve. Same rule as `resolveFields`.
    const { g, sent } = gate();
    const pending = g.request(ASK);
    g.settle(sent[0].id, true, {
      "address.line1": "14 Rivington Street",
      "address.postcode": "EC2A 3DZ",
      "shopper.lastName": "not asked for",
    });
    const outcome = await pending;
    expect(outcome.ok && Object.keys(outcome.fills).sort()).toEqual([
      "address.line1",
      "address.postcode",
    ]);
  });
});

describe("ApprovalGate settles on every exit path", () => {
  it("times out rather than leaving the caller waiting", async () => {
    vi.useFakeTimers();
    try {
      const { g } = gate({ timeoutMs: 45_000 });
      const pending = g.request(ASK);
      vi.advanceTimersByTime(45_000);
      await expect(pending).resolves.toEqual({ ok: false, reason: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves everything pending when the console goes away", async () => {
    const { g } = gate();
    const a = g.request(ASK);
    const b = g.request(ASK);
    g.abandonAll();
    await expect(a).resolves.toEqual({ ok: false, reason: "disconnected" });
    await expect(b).resolves.toEqual({ ok: false, reason: "disconnected" });
  });

  it("ignores an answer for an id it does not know", () => {
    const { g } = gate();
    expect(() => g.settle("no-such-id", true, {})).not.toThrow();
  });

  it("ignores a second answer for an id already settled", async () => {
    const { g, sent } = gate();
    const pending = g.request(ASK);
    g.settle(sent[0].id, false);
    g.settle(sent[0].id, true, { "address.line1": "too late" });
    await expect(pending).resolves.toEqual({ ok: false, reason: "denied" });
  });

  it("does not fire a timeout after the human answered", async () => {
    vi.useFakeTimers();
    try {
      const { g, sent } = gate({ timeoutMs: 1000 });
      const pending = g.request(ASK);
      g.settle(sent[0].id, true, { "address.line1": "14 Rivington Street" });
      vi.advanceTimersByTime(5000);
      const outcome = await pending;
      expect(outcome.ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("approvalFailureText", () => {
  const fields = ["address.line1", "address.postcode"];

  it("tells the agent which fields are waiting and where to approve them", () => {
    const text = approvalFailureText("needs-console", fields);
    expect(text).toContain("needs-console");
    expect(text).toContain("address.line1");
    expect(text).toContain("address.postcode");
  });

  it("reports a denial in the same words the façade path already uses", () => {
    // register-all.ts throws "user denied: profile fields not sent"; an MCP
    // client should not learn a second vocabulary for the same event.
    expect(approvalFailureText("denied", fields)).toBe(
      "user denied: profile fields not sent",
    );
  });

  it("distinguishes a timeout from a denial", () => {
    expect(approvalFailureText("timeout", fields)).toContain("timed out");
  });

  it("distinguishes a disconnect from a timeout", () => {
    expect(approvalFailureText("disconnected", fields)).toContain("console");
    expect(approvalFailureText("disconnected", fields)).not.toContain("timed out");
  });

  it("never names a value, only a field path", () => {
    for (const reason of ["needs-console", "denied", "timeout", "disconnected"] as const) {
      expect(approvalFailureText(reason, fields)).not.toContain("Rivington");
    }
  });
});

describe("prepareFills", () => {
  const FILLS = ["address.line1", "address.postcode"];
  const supplied = {
    "address.line1": "14 Rivington Street",
    "address.postcode": "EC2A 3DZ",
  };

  it("passes a tool with no fillsFrom straight through", async () => {
    const { g, sent } = gate();
    const out = await prepareFills(undefined, { origin: "LHR" }, g);
    expect(out).toEqual({ ok: true, args: { origin: "LHR" }, resolved: [] });
    expect(sent).toEqual([]);
  });

  it("does not prompt again when the façade already merged the fields", async () => {
    // register-all.ts blessed and merged before the wire. Asking twice for one
    // action is the regression this guards.
    const { g, sent } = gate();
    const out = await prepareFills(FILLS, { ...supplied }, g);
    expect(sent).toEqual([]);
    expect(out).toEqual({ ok: true, args: supplied, resolved: FILLS });
  });

  it("refuses rather than filling blanks when no console is attached", async () => {
    // The bug: over MCP these six fields were undefined, String(undefined)
    // became "", page.fill swallowed it, and runTool reported success.
    const { g } = gate({ hasConsole: () => false });
    const out = await prepareFills(FILLS, {}, g);
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.text).toContain("needs-console");
  });

  it("merges the approved fields into the arguments", async () => {
    const { g, sent } = gate();
    const pending = prepareFills(FILLS, { size: "9" }, g);
    g.settle(sent[0].id, true, supplied);
    await expect(pending).resolves.toEqual({
      ok: true,
      args: { size: "9", ...supplied },
      resolved: FILLS,
    });
  });

  it("reports only the fields actually resolved, for the audit row", async () => {
    // The row must name what moved, not what the manifest declared.
    const { g, sent } = gate();
    const pending = prepareFills(FILLS, {}, g);
    g.settle(sent[0].id, true, { "address.line1": "14 Rivington Street" });
    const out = await pending;
    expect(out.ok && out.resolved).toEqual(["address.line1"]);
  });

  it("fails the call when the human declines", async () => {
    const { g, sent } = gate();
    const pending = prepareFills(FILLS, {}, g);
    g.settle(sent[0].id, false);
    const out = await pending;
    expect(out.ok).toBe(false);
    expect(out.ok === false && out.text).toBe("user denied: profile fields not sent");
  });

  it("asks only for the fields that are missing", async () => {
    const { g, sent } = gate();
    void prepareFills(FILLS, { "address.line1": "already here" }, g);
    expect(sent[0].fieldNames).toEqual(["address.postcode"]);
  });
});
