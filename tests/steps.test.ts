import { describe, expect, it } from "vitest";
import { ELEMENT_TIMEOUT_MS, runElementStep, runSteps } from "../worker/steps";
import type { ManifestStep } from "../shared/manifest";

/**
 * A step that cannot find its element used to cost Playwright's default 30
 * seconds and then be swallowed whole. `fill_checkout` declares six of them,
 * so on any page without a checkout form the tool sat for three minutes —
 * past the bridge's own 120s timeout — and then reported that it had run.
 *
 * Measured against the deployed Worker on the Allbirds home page: the console
 * showed "you started fill_checkout_on_allbirds_com" and nothing else.
 */

/**
 * A page with a clock. An absent selector costs the whole timeout it was
 * given, exactly as Playwright's does — without that, a test cannot see the
 * difference between a budget spent per page and one spent per field.
 */
function page(present: Record<string, true>) {
  const calls: Array<{ selector: string; value?: string; timeout?: number }> = [];
  let clock = 1_000_000;
  const act = (selector: string, timeout?: number, value?: string) => {
    calls.push({ selector, value, timeout });
    if (present[selector]) return;
    clock += timeout ?? 0;
    throw new Error(`Timeout ${timeout}ms exceeded waiting for ${selector}`);
  };
  return {
    calls,
    now: () => clock,
    elapsed: () => clock - 1_000_000,
    fill: async (selector: string, value: string, opts?: { timeout?: number }) =>
      act(selector, opts?.timeout, value),
    click: async (selector: string, opts?: { timeout?: number }) =>
      act(selector, opts?.timeout),
  };
}

const fillFirstName: ManifestStep = {
  action: "fill",
  selector: "input[autocomplete='given-name']",
  from: "shopper.firstName",
};

describe("runElementStep", () => {
  it("reports the element it filled", async () => {
    const p = page({ "input[autocomplete='given-name']": true });
    const outcome = await runElementStep(p, fillFirstName, {
      "shopper.firstName": "Ada",
    });
    expect(outcome).toBe("landed");
    expect(p.calls[0]).toMatchObject({ value: "Ada" });
  });

  it("reports an element that is not on this page instead of swallowing it", async () => {
    const outcome = await runElementStep(page({}), fillFirstName, {
      "shopper.firstName": "Ada",
    });
    expect(outcome).toBe("absent");
  });

  it("bounds the wait, so six missing fields cost seconds and not minutes", async () => {
    const p = page({});
    await runElementStep(p, fillFirstName, { "shopper.firstName": "Ada" });
    expect(p.calls[0].timeout).toBe(ELEMENT_TIMEOUT_MS);
    expect(ELEMENT_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it("treats a missing optional control as absent, not as an error", async () => {
    // The GOV.UK manifest clicks a cookie banner that is often not there.
    const outcome = await runElementStep(
      page({}),
      { action: "click", selector: "button[data-accept-cookies='false']" },
      {},
    );
    expect(outcome).toBe("absent");
  });
});

describe("runSteps", () => {
  const checkout: ManifestStep[] = [
    { action: "fill", selector: "#given-name", from: "shopper.firstName" },
    { action: "fill", selector: "#family-name", from: "shopper.lastName" },
    { action: "fill", selector: "#line1", from: "address.line1" },
  ];

  it("spends the budget on the page, not on each missing field", async () => {
    // Waiting 8s per field to learn the same fact three times is how a tool
    // that has nothing to fill took a minute to say so.
    const p = page({});
    const report = await runSteps(p, checkout, {}, async () => {}, p.now);
    expect(report.fillsAttempted).toBe(3);
    expect(report.fillsLanded).toBe(0);
    const waits = p.calls.map((c) => c.timeout ?? 0);
    expect(waits[0]).toBe(ELEMENT_TIMEOUT_MS);
    expect(Math.max(...waits.slice(1))).toBeLessThan(ELEMENT_TIMEOUT_MS);
    expect(p.elapsed()).toBeLessThan(ELEMENT_TIMEOUT_MS * 2);
  });

  it("counts the fields that landed", async () => {
    const p = page({ "#given-name": true, "#line1": true });
    const report = await runSteps(p, checkout, {}, async () => {}, p.now);
    expect(report).toMatchObject({ fillsAttempted: 3, fillsLanded: 2 });
  });

  it("gives the next page its own budget after a goto", async () => {
    const p = page({});
    const visited: string[] = [];
    await runSteps(
      p,
      [
        { action: "fill", selector: "#a", from: "x" },
        { action: "goto", url: "https://www.gov.uk/find-local-council" },
        { action: "fill", selector: "#postcode", from: "address.postcode" },
      ],
      {},
      async (url) => void visited.push(url),
      p.now,
    );
    expect(visited).toEqual(["https://www.gov.uk/find-local-council"]);
    expect(p.calls.map((c) => c.timeout)).toEqual([
      ELEMENT_TIMEOUT_MS,
      ELEMENT_TIMEOUT_MS,
    ]);
  });

  it("interpolates the goto url from the arguments", async () => {
    const visited: string[] = [];
    await runSteps(
      page({}),
      [{ action: "goto", url: "https://www.kayak.com/flights/{{from}}" }],
      { from: "LUX/CDG" },
      async (url) => void visited.push(url),
    );
    expect(visited).toEqual(["https://www.kayak.com/flights/LUX%2FCDG"]);
  });
});
