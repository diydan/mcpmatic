import { describe, expect, it } from "vitest";
import { describeStep } from "../shared/describe-steps";

describe("describeStep", () => {
  it("describes goto", () => {
    expect(describeStep({ action: "goto", url: "https://example.com" })).toBe(
      "opens https://example.com",
    );
  });
  it("describes fill", () => {
    expect(describeStep({ action: "fill", selector: "input#q", from: "query" })).toBe(
      "fills input#q from query",
    );
  });
  it("describes type", () => {
    expect(describeStep({ action: "type", selector: "input#q", from: "query" })).toBe(
      "types into input#q from query",
    );
  });
  it("describes click", () => {
    expect(describeStep({ action: "click", selector: "button.go" })).toBe("clicks button.go");
  });
  it("describes press", () => {
    expect(describeStep({ action: "press", selector: "input#q", key: "Enter" })).toBe(
      "presses Enter on input#q",
    );
  });
  it("describes wait", () => {
    expect(describeStep({ action: "wait", selector: ".results" })).toBe("waits for .results");
  });
});
