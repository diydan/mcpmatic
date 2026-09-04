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
  it("is on when the session has never been told otherwise", () => {
    // Automation is the default: a fresh session should act without asking for
    // a grant click per origin.
    expect(autonomousFromStored(undefined)).toBe(true);
    expect(autonomousFromStored(null)).toBe(true);
  });

  it("stays off when a human turned it off", () => {
    // An explicit choice outranks the default, and must survive a reload.
    expect(autonomousFromStored("0")).toBe(false);
  });

  it("is on when explicitly turned on", () => {
    expect(autonomousFromStored("1")).toBe(true);
  });

  it("falls back to the default for a value it does not recognise", () => {
    expect(autonomousFromStored("")).toBe(true);
    expect(autonomousFromStored("yes")).toBe(true);
  });
});
