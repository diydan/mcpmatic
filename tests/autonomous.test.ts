import { describe, expect, it } from "vitest";
import {
  autonomousFromStored,
  mergeAutonomousConsent,
} from "../shared/autonomous";

describe("mergeAutonomousConsent", () => {
  it("adds every catalog origin without dropping ones already granted", () => {
    expect(
      mergeAutonomousConsent(
        ["https://www.gov.uk"],
        ["https://www.allbirds.com", "https://www.gov.uk"],
      ),
    ).toEqual(["https://www.gov.uk", "https://www.allbirds.com"]);
  });

  it("is a no-op on an empty catalog besides keeping current grants", () => {
    expect(mergeAutonomousConsent(["https://example.com"], [])).toEqual([
      "https://example.com",
    ]);
  });
});

describe("autonomousFromStored", () => {
  it("is off when the session has never been told otherwise", () => {
    // Fails closed by default: a fresh session does not act without a grant
    // click per origin. The 2026-09-04 security review split autoGrantNew
    // out of autonomous, and both flags must default off so a navigation
    // an agent decides on for itself does not silently widen the grant set.
    expect(autonomousFromStored(undefined)).toBe(false);
    expect(autonomousFromStored(null)).toBe(false);
  });

  it("stays off when a human turned it off", () => {
    // An explicit choice outranks the default, and must survive a reload.
    expect(autonomousFromStored("0")).toBe(false);
  });

  it("is on when explicitly turned on", () => {
    expect(autonomousFromStored("1")).toBe(true);
  });

  it("falls back to off for a value it does not recognise", () => {
    // An unrecognised value is treated as no choice at all and defaults
    // to off — the safe choice.
    expect(autonomousFromStored("")).toBe(false);
    expect(autonomousFromStored("yes")).toBe(false);
  });
});
