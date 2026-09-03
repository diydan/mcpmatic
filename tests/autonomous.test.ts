import { describe, expect, it } from "vitest";
import { mergeAutonomousConsent } from "../shared/autonomous";

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
