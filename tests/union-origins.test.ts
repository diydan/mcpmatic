import { describe, expect, it } from "vitest";
import { unionOrigins } from "../shared/origin";

describe("unionOrigins", () => {
  it("keeps the first list's order and appends what the second adds", () => {
    expect(unionOrigins(["a", "b"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("drops duplicates within a single list", () => {
    expect(unionOrigins(["a", "a"], [])).toEqual(["a"]);
  });

  it("drops empty strings", () => {
    expect(unionOrigins(["", "a"], [""])).toEqual(["a"]);
  });

  it("returns a new array, leaving the inputs alone", () => {
    const first = ["a"];
    const out = unionOrigins(first, ["b"]);
    expect(out).not.toBe(first);
    expect(first).toEqual(["a"]);
  });
});
