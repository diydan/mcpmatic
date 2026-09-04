/**
 * Tests for the Consent toggle state machine (shared/consent-ux.ts). The
 * machine is what `Consent.tsx` dispatches through, so these tests cover
 * the first-toggle gate that drives the confirm modal — and because the
 * machine is pure, we can assert the exact shape of the result without
 * rendering React. The component just routes the actions through.
 *
 * Each scenario maps to one of the four behaviour requirements: first
 * toggle opens the modal, cancel does not change the flag, confirm does,
 * and subsequent toggles do not show the modal again.
 */
import { describe, expect, it } from "vitest";
import {
  initialConsentUxState,
  reduceConsentUx,
  type ConsentUxState,
} from "../shared/consent-ux";

function apply(
  state: ConsentUxState,
  action: Parameters<typeof reduceConsentUx>[1],
): ConsentUxState {
  const result = reduceConsentUx(state, action);
  return result;
}

describe("consent-ux state machine", () => {
  it("first toggle of `autonomous` ON opens the confirm modal", () => {
    const initial = initialConsentUxState();
    const after = apply(initial, {
      kind: "toggle",
      field: "autonomous",
      next: true,
    });
    expect(after.showConfirm).toBe("autonomous");
    // Flag stays off until the user confirms — a no-show confirm must not
    // silently enable the switch.
    expect(after.flags.autonomous).toBe(false);
  });

  it("first toggle of `autoGrantNew` ON opens the confirm modal", () => {
    const initial = initialConsentUxState();
    const after = apply(initial, {
      kind: "toggle",
      field: "autoGrantNew",
      next: true,
    });
    expect(after.showConfirm).toBe("autoGrantNew");
    expect(after.flags.autoGrantNew).toBe(false);
  });

  it("confirming the modal flips the flag ON and marks it as seen", () => {
    const initial = initialConsentUxState();
    const opened = apply(initial, {
      kind: "toggle",
      field: "autonomous",
      next: true,
    });
    const confirmed = apply(opened, { kind: "confirm", field: "autonomous" });
    expect(confirmed.flags.autonomous).toBe(true);
    expect(confirmed.confirmed.autonomous).toBe(true);
    expect(confirmed.showConfirm).toBeNull();
  });

  it("cancelling the modal leaves the flag untouched", () => {
    const initial = initialConsentUxState();
    const opened = apply(initial, {
      kind: "toggle",
      field: "autonomous",
      next: true,
    });
    const cancelled = apply(opened, { kind: "cancel" });
    expect(cancelled.flags.autonomous).toBe(false);
    expect(cancelled.confirmed.autonomous).toBe(false);
    // A subsequent first-toggle of the same flag must re-open the modal —
    // cancellation is not "I have seen this", it is "I have declined".
    const reOpened = apply(cancelled, {
      kind: "toggle",
      field: "autonomous",
      next: true,
    });
    expect(reOpened.showConfirm).toBe("autonomous");
  });

  it("subsequent toggles after confirming do not show the modal again", () => {
    let state = initialConsentUxState();
    state = apply(state, { kind: "toggle", field: "autonomous", next: true });
    state = apply(state, { kind: "confirm", field: "autonomous" });
    expect(state.showConfirm).toBeNull();

    // Toggle off, on, off — none of these should re-open the modal.
    const off = apply(state, { kind: "toggle", field: "autonomous", next: false });
    expect(off.showConfirm).toBeNull();
    expect(off.flags.autonomous).toBe(false);

    const onAgain = apply(off, { kind: "toggle", field: "autonomous", next: true });
    expect(onAgain.showConfirm).toBeNull();
    expect(onAgain.flags.autonomous).toBe(true);

    const offAgain = apply(onAgain, {
      kind: "toggle",
      field: "autonomous",
      next: false,
    });
    expect(offAgain.showConfirm).toBeNull();
    expect(offAgain.flags.autonomous).toBe(false);
  });

  it("toggling OFF never opens the modal, even on a never-seen flag", () => {
    // A user who has never turned ON `autonomous` cannot be prompted about
    // turning it OFF — the modal exists to remind, and there is nothing to
    // be reminded of.
    const initial = initialConsentUxState();
    const after = apply(initial, {
      kind: "toggle",
      field: "autonomous",
      next: false,
    });
    expect(after.showConfirm).toBeNull();
    expect(after.flags.autonomous).toBe(false);
  });

  it("confirming one flag does not pre-confirm the other", () => {
    // The gate is per-flag. Confirming `autonomous` must not let the
    // `autoGrantNew` switch skip its own first-time modal.
    let state = initialConsentUxState();
    state = apply(state, { kind: "toggle", field: "autonomous", next: true });
    state = apply(state, { kind: "confirm", field: "autonomous" });
    const next = apply(state, {
      kind: "toggle",
      field: "autoGrantNew",
      next: true,
    });
    expect(next.showConfirm).toBe("autoGrantNew");
  });

  it("toggling to the current value is a no-op (no modal, no change)", () => {
    let state = initialConsentUxState();
    state = apply(state, { kind: "toggle", field: "autonomous", next: false });
    expect(state.showConfirm).toBeNull();
    expect(state.flags.autonomous).toBe(false);
  });

  it("reducer does not mutate its input state", () => {
    // Belt-and-braces: the React component calls this inside setUx, where
    // a mutation would silently corrupt subsequent renders.
    const initial = initialConsentUxState();
    const snapshot = JSON.stringify(initial);
    apply(initial, { kind: "toggle", field: "autonomous", next: true });
    apply(initial, { kind: "toggle", field: "autoGrantNew", next: true });
    expect(JSON.stringify(initial)).toBe(snapshot);
  });
});