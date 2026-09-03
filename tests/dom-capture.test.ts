import { describe, expect, it, vi } from "vitest";
import {
  captureInteractiveElements,
  type CaptureFn,
  type PageElement,
} from "../worker/dom-capture";

describe("captureInteractiveElements", () => {
  it("returns whatever the evaluate call produces", async () => {
    const elements: PageElement[] = [
      { role: "button", name: "Search", selector: "button.search" },
    ];
    const evaluate: CaptureFn = vi.fn(async () => elements);
    expect(await captureInteractiveElements(evaluate)).toEqual(elements);
  });

  it("caps the result at 150 elements", async () => {
    const many: PageElement[] = Array.from({ length: 200 }, (_, i) => ({
      role: "button",
      name: `b${i}`,
      selector: `#b${i}`,
    }));
    const evaluate: CaptureFn = vi.fn(async () => many);
    const out = await captureInteractiveElements(evaluate);
    expect(out).toHaveLength(150);
  });

  it("returns an empty list rather than throwing when evaluate rejects", async () => {
    const evaluate: CaptureFn = vi.fn(async () => {
      throw new Error("page navigated away");
    });
    expect(await captureInteractiveElements(evaluate)).toEqual([]);
  });

  it("returns an empty list when evaluate resolves to a non-array", async () => {
    const evaluate = vi.fn(async () => null) as unknown as CaptureFn;
    expect(await captureInteractiveElements(evaluate)).toEqual([]);
  });
});
