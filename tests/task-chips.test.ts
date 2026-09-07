/**
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { TASK_CHIPS } from "../src/lib/task-chips";

describe("TASK_CHIPS", () => {
  it("carries no origin — a chip is a task, not a destination", () => {
    // The whole point of spec §1: pinning an origin is what made
    // "across 4 stores" and "dinner & movie tickets" false.
    for (const chip of TASK_CHIPS) {
      expect(chip).not.toHaveProperty("origin");
    }
  });

  it("offers four example tasks with an icon and text", () => {
    expect(TASK_CHIPS).toHaveLength(4);
    for (const chip of TASK_CHIPS) {
      expect(typeof chip.icon).toBe("string");
      expect(chip.icon.length).toBeGreaterThan(0);
      expect(typeof chip.text).toBe("string");
      expect(chip.text.length).toBeGreaterThan(0);
    }
  });
});
