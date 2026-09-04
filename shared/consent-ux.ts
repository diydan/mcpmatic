/**
 * Pure state machine for the consent-toggles UI.
 *
 * `Consent` renders two switches (`autonomous` and `autoGrantNew`) and a
 * confirm modal. Turning either switch ON for the first time in a session
 * shows the modal so the user has a chance to read the catalog and the
 * implications before granting. Turning a switch OFF never shows the modal.
 * After the user confirms once for a given flag, subsequent toggles of that
 * flag commit immediately — the prompt is a "have you seen this?" gate, not a
 * permission gate.
 *
 * Extracted into a pure module so the behaviour is testable without rendering
 * React: the component holds a `state` in `useState` and dispatches each user
 * action through one of these functions.
 */

export type ConsentFlag = "autonomous" | "autoGrantNew";

export type ConsentUxState = {
  flags: Record<ConsentFlag, boolean>;
  /**
   * Per-flag memory of whether the user has already seen the confirm modal.
   * Persists across toggles within the same session but is intentionally NOT
   * persisted across page reloads — a refresh resets the gate so the user
   * can re-read the implications if they want to.
   */
  confirmed: Record<ConsentFlag, boolean>;
};

export function initialConsentUxState(): ConsentUxState {
  return {
    flags: { autonomous: false, autoGrantNew: false },
    confirmed: { autonomous: false, autoGrantNew: false },
  };
}

export type ConsentUxAction =
  /** User flipped the named switch to `next`. */
  | { kind: "toggle"; field: ConsentFlag; next: boolean }
  /** User clicked the modal's "confirm" button. Commits the flag ON. */
  | { kind: "confirm"; field: ConsentFlag }
  /** User clicked the modal's "cancel" button. Leaves the flag as it was. */
  | { kind: "cancel" };

export type ConsentUxResult = ConsentUxState & {
  /** True when the consumer should open the confirm modal for `pendingField`. */
  showConfirm: ConsentFlag | null;
};

/**
 * Reduce the state machine. `showConfirm` is a flag on the returned result so
 * the caller can decide where to render the modal without threading it
 * through props separately.
 */
export function reduceConsentUx(
  state: ConsentUxState,
  action: ConsentUxAction,
): ConsentUxResult {
  switch (action.kind) {
    case "toggle": {
      const { field, next } = action;
      if (state.flags[field] === next) {
        return { ...state, showConfirm: null };
      }
      // Toggles OFF always commit silently — the user is removing access, not
      // broadening it, so no confirm gate.
      if (!next) {
        return {
          ...state,
          flags: { ...state.flags, [field]: false },
          showConfirm: null,
        };
      }
      // Toggles ON commit immediately if the user has already confirmed this
      // flag in this session. The modal is a "have you seen this?" gate, not
      // an every-toggle gate.
      if (state.confirmed[field]) {
        return {
          ...state,
          flags: { ...state.flags, [field]: true },
          showConfirm: null,
        };
      }
      // First ON of this flag: open the modal. The state is left untouched
      // until the modal decides — cancel is a no-op, confirm commits.
      return { ...state, showConfirm: field };
    }
    case "confirm": {
      const { field } = action;
      return {
        flags: { ...state.flags, [field]: true },
        confirmed: { ...state.confirmed, [field]: true },
        showConfirm: null,
      };
    }
    case "cancel": {
      return { ...state, showConfirm: null };
    }
  }
}