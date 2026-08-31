import { describe, expect, it } from "vitest";
import { mapCanvasToViewport } from "../shared/coords";

describe("mapCanvasToViewport", () => {
  it("maps the centre of a matching canvas to the viewport centre", () => {
    const p = mapCanvasToViewport(640, 360, { width: 1280, height: 720 }, { width: 1280, height: 720 });
    expect(p).toEqual({ x: 640, y: 360 });
  });

  it("accounts for letterboxing on a wider panel", () => {
    const canvas = { width: 1600, height: 720 };
    const viewport = { width: 1280, height: 720 };
    const p = mapCanvasToViewport(159, 0, canvas, viewport);
    expect(p).toBeNull();
    const inner = mapCanvasToViewport(160, 0, canvas, viewport);
    expect(inner).toEqual({ x: 0, y: 0 });
  });

  it("returns null for a click in the bar below a taller panel", () => {
    const p = mapCanvasToViewport(100, 900, { width: 1280, height: 900 }, { width: 1280, height: 720 });
    expect(p).toBeNull();
  });

  it("rejects empty boxes", () => {
    expect(mapCanvasToViewport(1, 1, { width: 0, height: 10 }, { width: 100, height: 100 })).toBeNull();
  });
});
