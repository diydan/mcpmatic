import { unionOrigins } from "./origin";

/** Union current grants with the catalog so autonomous mode opens every demo origin. */
export function mergeAutonomousConsent(
  current: readonly string[],
  catalog: readonly string[],
): string[] {
  return unionOrigins(current, catalog);
}

/**
 * Whether a session acts without a grant click per origin.
 *
 * Automation is the default: an absent row means on. The product is for people
 * who want an agent to get on with it, and asking permission per origin before
 * anything has happened is friction without a decision behind it.
 *
 * An explicit "0" outranks the default and survives reloads, because a human
 * who turned it off has made a choice and a default must not undo it. An
 * unrecognised value is treated as no choice at all.
 */
export function autonomousFromStored(value: string | null | undefined): boolean {
  return value === "0" ? false : true;
}
