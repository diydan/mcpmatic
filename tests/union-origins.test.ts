import { describe, expect, it } from "vitest";
import { displayHosts, unionOrigins } from "../shared/origin";

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

describe("displayHosts", () => {
  it("strips www so a host reads the way people say it", () => {
    expect(displayHosts(["https://www.allbirds.com"])).toEqual(["allbirds.com"]);
  });

  it("dedupes after stripping, not before", () => {
    // https://kayak.com and https://www.kayak.com are different origins and
    // consent keys on that difference — but they are one name on screen, and
    // showing it twice reads as a bug.
    expect(displayHosts(["https://www.kayak.com", "https://kayak.com"])).toEqual([
      "kayak.com",
    ]);
  });

  it("keeps first-seen order", () => {
    expect(
      displayHosts(["https://b.test", "https://a.test", "https://www.b.test"]),
    ).toEqual(["b.test", "a.test"]);
  });

  it("passes through anything it cannot parse, still deduped", () => {
    expect(displayHosts(["not a url", "not a url"])).toEqual(["not a url"]);
  });

  it("drops empties", () => {
    expect(displayHosts(["", "https://a.test"])).toEqual(["a.test"]);
  });
});
